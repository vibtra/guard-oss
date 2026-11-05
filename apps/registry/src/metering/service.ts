import { randomBytes } from "node:crypto";
import { renderLine, usageEnvelope, validateEnvelope, type Envelope, type UsageAct, type UsageCode } from "@vibtra/guard-contract/policy";
import { planFor, type PlanLimits } from "../config.js";
import type { OrgRow } from "../tenancy/store.js";
import type { WorkspaceStore } from "../workspaces/store.js";
import type { Clock } from "./clock.js";
import {
  hoursOf,
  type HostState,
  lostHostEnd,
  meterAwake,
  meterSessions,
  MINUTE_MS,
  overageCents,
  overageMinutes,
  peakBoxes,
  periodFor,
  type PeriodWindow,
  resetsOn,
  utcMonth,
} from "./math.js";
import { type AppBoxRow, DEFAULT_SPENDING_CAP_CENTS, type MeteringStore, type NoticeKind, type UsagePeriodRow } from "./store.js";

export const TICK_MS = 60_000;
export const QUOTA_STOP_NOTICE_MS = 10 * MINUTE_MS;
export const REPORT_EVERY_MS = 15 * MINUTE_MS;
export const DEFAULT_FREE_BUDGET_HOURS = 2_000;
export const WAITLIST_AT = 0.9;

export type StartKind = "workspace" | "app-box-create" | "app-box-wake";

export class UsageRefusal extends Error {
  readonly status = 409;
  readonly code: UsageCode;
  readonly envelope: Envelope;
  readonly alias?: string;
  constructor(code: UsageCode, envelope: Envelope, alias?: string) {
    super(renderLine(envelope));
    this.code = code;
    this.envelope = envelope;
    if (alias !== undefined) this.alias = alias;
  }
}

export interface SessionUsageView {
  window: PeriodWindow;
  plan: string;
  limits: PlanLimits;
  usedMinutes: number;
  attachedMinutes: number;
  detachedMinutes: number;
  overageMinutes: number;
  overageCents: number;
  perPerson: Array<{ userId: string; minutes: number; attachedMinutes: number }>;
  running: number;
}

export interface AppBoxUsageView {
  window: PeriodWindow;
  boxes: number;
  peak: number;
  extraBoxes: number;
  awakeMinutes: number;
  awakeOverageMinutes: number;
  awakeOverageCents: number;
  extraCents: number;
}

export interface SpendView {
  sessionCents: number;
  awakeCents: number;
  extraCents: number;
  totalCents: number;
  capCents: number | null;
}

export interface ReportInput {
  org: OrgRow;
  window: PeriodWindow;
  sessionOverageMinutes: number;
  awakeOverageMinutes: number;
  extraBoxes: number;
  final: boolean;
}

export interface MeteringServiceOptions {
  store: MeteringStore;
  workspaces: Pick<WorkspaceStore, "listOrgIntervals" | "listOrgAttachmentWindows" | "listWorkspaces">;
  tenancy: { getOrg(orgId: string): Promise<OrgRow | undefined> };
  clock: Clock;
  hostState?: (hostId: string) => Promise<HostState>;
  freeBudgetHours?: number;
  appBoxMode?: "awake" | "count";
  notifyTerminals?: (target: { orgId: string; userId?: string }, notice: { line: string; id: string; code: string; stopAt?: string }) => void;
  mailAdmins?: (org: OrgRow, kind: Exclude<NoticeKind, "quota-stop">, sentence: string) => Promise<void>;
  stopForQuota?: (orgId: string) => Promise<number>;
  stopAboveConcurrency?: (orgId: string, limit: number) => Promise<number>;
  stopAppBoxesForQuota?: (orgId: string) => Promise<number>;
  report?: (input: ReportInput) => Promise<void>;
  log?: (line: string) => void;
}

const dollars = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

export const createMeteringService = (options: MeteringServiceOptions) => {
  const { store, clock } = options;
  const log = options.log ?? (() => undefined);
  const mode = options.appBoxMode ?? "awake";
  const budgetMinutes = Math.max(0, Math.round((options.freeBudgetHours ?? DEFAULT_FREE_BUDGET_HOURS) * 60));
  const lastReport = new Map<string, number>();

  const orgOf = async (orgId: string): Promise<OrgRow | undefined> => options.tenancy.getOrg(orgId);

  const openEnds = async (orgId: string, now: number): Promise<(workspaceId: string) => number> => {
    const rows = await options.workspaces.listWorkspaces({ orgId });
    const hostOf = new Map(rows.map((w) => [w.id, w.hostId]));
    const cache = new Map<string, number>();
    for (const hostId of new Set(rows.map((w) => w.hostId).filter((h): h is string => h !== undefined))) {
      let end = now;
      if (options.hostState) {
        try {
          end = lostHostEnd(now, await options.hostState(hostId));
        } catch {
          end = now;
        }
      }
      cache.set(hostId, end);
    }
    return (workspaceId) => {
      const host = hostOf.get(workspaceId);
      return host !== undefined ? (cache.get(host) ?? now) : now;
    };
  };

  const sessionUsageIn = async (org: OrgRow, window: PeriodWindow, nowMs: number, planId: string | undefined = org.plan): Promise<SessionUsageView> => {
    const limits = planFor(planId).limits;
    const to = new Date(Math.min(window.end.getTime(), nowMs)).toISOString();
    const from = window.start.toISOString();
    const [intervals, attachments, workspaces] = await Promise.all([
      options.workspaces.listOrgIntervals(org.orgId, from, to),
      options.workspaces.listOrgAttachmentWindows(org.orgId, from, to),
      options.workspaces.listWorkspaces({ orgId: org.orgId }),
    ]);
    const usage = meterSessions(intervals, attachments, window, await openEnds(org.orgId, nowMs));
    const userOf = new Map(workspaces.map((w) => [w.id, w.userId]));
    const perPerson = new Map<string, { userId: string; minutes: number; attachedMinutes: number }>();
    for (const [wid, row] of usage.perWorkspace) {
      const userId = userOf.get(wid) ?? "unknown";
      const p = perPerson.get(userId) ?? { userId, minutes: 0, attachedMinutes: 0 };
      p.minutes += row.minutes;
      p.attachedMinutes += row.attachedMinutes;
      perPerson.set(userId, p);
    }
    const over = limits.sessionHoursHardCap ? 0 : overageMinutes(usage.totalMinutes, limits.sessionHours);
    return {
      window,
      plan: planFor(planId).id,
      limits,
      usedMinutes: usage.totalMinutes,
      attachedMinutes: usage.attachedMinutes,
      detachedMinutes: usage.detachedMinutes,
      overageMinutes: over,
      overageCents: overageCents(over, limits.sessionOverageCentsPerHour),
      perPerson: [...perPerson.values()].sort((a, b) => b.minutes - a.minutes),
      running: workspaces.filter((w) => w.status === "running" || w.status === "starting").length,
    };
  };

  const appBoxUsageIn = async (org: OrgRow, window: PeriodWindow, nowMs: number, planId: string | undefined = org.plan): Promise<AppBoxUsageView> => {
    const limits = planFor(planId).limits;
    const all = await store.listBoxes(org.orgId, { includeDeleted: true });
    const live = all.filter((b) => b.status !== "deleted");
    const peak = peakBoxes(all, window, nowMs);
    const extraBoxes = limits.appBoxes === null ? 0 : Math.max(0, peak - limits.appBoxes);
    const awakeMinutes = mode === "count" ? 0 : meterAwake(await store.listBoxIntervals(org.orgId, window.start.toISOString(), window.end.toISOString()), window, nowMs);
    const awakeOver = limits.appBoxHardCap || mode === "count" ? 0 : overageMinutes(awakeMinutes, limits.appBoxAwakeHours);
    return {
      window,
      boxes: live.length,
      peak,
      extraBoxes,
      awakeMinutes,
      awakeOverageMinutes: awakeOver,
      awakeOverageCents: overageCents(awakeOver, limits.appBoxOverageCentsPerAwakeHour),
      extraCents: limits.extraBoxCentsPerMonth === null ? 0 : extraBoxes * limits.extraBoxCentsPerMonth,
    };
  };

  const capOf = async (orgId: string): Promise<number | null> => {
    const row = await store.getCap(orgId);
    return row === undefined ? DEFAULT_SPENDING_CAP_CENTS : row.capCents;
  };

  const spendOf = (session: SessionUsageView, boxes: AppBoxUsageView, capCents: number | null): SpendView => ({
    sessionCents: session.overageCents,
    awakeCents: boxes.awakeOverageCents,
    extraCents: boxes.extraCents,
    totalCents: session.overageCents + boxes.awakeOverageCents + boxes.extraCents,
    capCents,
  });

  const capReached = (limits: PlanLimits, session: SessionUsageView, spend: SpendView): boolean => {
    if (limits.sessionHoursHardCap || spend.capCents === null) return false;
    const atAllowance = limits.sessionHours !== null && session.usedMinutes >= limits.sessionHours * 60;
    return spend.totalCents >= spend.capCents && (atAllowance || spend.totalCents > 0);
  };

  const hoursExhausted = (limits: PlanLimits, session: SessionUsageView): boolean =>
    limits.sessionHoursHardCap && limits.sessionHours !== null && session.usedMinutes >= limits.sessionHours * 60;

  const envelope = (code: UsageCode, org: OrgRow | undefined, act: Omit<UsageAct, "planName">, userId?: string): Envelope => {
    const env = usageEnvelope(code, { planName: planFor(org?.plan).name, ...act }, { orgId: org?.orgId ?? "org_unknown", ...(userId ? { actorId: userId } : {}), ...(org?.name ? { orgName: org.name } : {}), now: clock.now() });
    const checked = validateEnvelope(env);
    if (!checked.ok) log(`metering: a ${code} envelope failed validation (${checked.errors.length} problem(s))`);
    return env;
  };

  const freeBudget = async (at: Date = clock.now()) => {
    const month = utcMonth(at);
    const rows = await store.listPeriods({ meter: "session", plan: "free", periodStartFrom: month.start.toISOString(), periodStartBefore: month.end.toISOString() });
    const usedMinutes = rows.reduce((sum, r) => sum + r.usedMinutes, 0);
    return { usedMinutes, budgetMinutes, ratio: budgetMinutes === 0 ? 1 : usedMinutes / budgetMinutes, resetsOn: resetsOn(month) };
  };

  const savePeriods = async (org: OrgRow, session: SessionUsageView, boxes: AppBoxUsageView, state: "open" | "closed") => {
    const limits = session.limits;
    const at = clock.now().toISOString();
    const base = { orgId: org.orgId, periodStart: session.window.start.toISOString(), periodEnd: session.window.end.toISOString(), plan: session.plan, state, updatedAt: at, reportedOverageMinutes: 0 };
    await store.upsertPeriod({ ...base, meter: "session", includedMinutes: limits.sessionHours === null ? null : limits.sessionHours * 60, usedMinutes: session.usedMinutes });
    if (boxes.boxes > 0 || boxes.peak > 0 || boxes.awakeMinutes > 0) {
      await store.upsertPeriod({ ...base, meter: "appbox_awake", includedMinutes: limits.appBoxAwakeHours === null ? null : limits.appBoxAwakeHours * 60, usedMinutes: boxes.awakeMinutes });
      await store.upsertPeriod({ ...base, meter: "appbox_extra", includedMinutes: limits.appBoxes, usedMinutes: boxes.peak });
    }
  };

  const reportFor = async (org: OrgRow, session: SessionUsageView, boxes: AppBoxUsageView, final: boolean) => {
    if (!options.report || session.limits.sessionHoursHardCap) return;
    const key = `${org.orgId}:${session.window.start.toISOString()}`;
    const nowMs = clock.now().getTime();
    if (!final && nowMs - (lastReport.get(key) ?? 0) < REPORT_EVERY_MS) return;
    lastReport.set(key, nowMs);
    try {
      await options.report({ org, window: session.window, sessionOverageMinutes: session.overageMinutes, awakeOverageMinutes: boxes.awakeOverageMinutes, extraBoxes: boxes.extraBoxes, final });
    } catch (error) {
      log(`metering: reporting ${org.orgId} failed (${(error as Error).name}); the rows stay pending`);
    }
  };

  const sentenceFor = (kind: Exclude<NoticeKind, "quota-stop">, session: SessionUsageView, spend: SpendView): string => {
    if (kind === "cap80" || kind === "cap100") return `Overage spend this month is ${dollars(spend.totalCents)} of the ${dollars(spend.capCents ?? 0)} spending cap.`;
    return `${hoursOf(session.usedMinutes)} of the ${session.limits.sessionHours ?? 0} Free session-hours are used this month.`;
  };

  const notifyOnce = async (org: OrgRow, window: PeriodWindow, kind: Exclude<NoticeKind, "quota-stop">, session: SessionUsageView, spend: SpendView) => {
    const inserted = await store.insertNotice({ orgId: org.orgId, periodStart: window.start.toISOString(), kind, at: clock.now().toISOString() });
    if (!inserted) return;
    log(`metering: ${org.orgId} ${kind} notice`);
    try {
      await options.mailAdmins?.(org, kind, sentenceFor(kind, session, spend));
    } catch {
    }
  };

  const isCurrentRow = (row: UsagePeriodRow, w: PeriodWindow, planId: string): boolean =>
    row.state === "open" && Date.parse(row.periodEnd) === w.end.getTime() && row.plan === planId && Date.parse(row.periodStart) >= w.start.getTime();

  const cutOf = (row: UsagePeriodRow, w: PeriodWindow, nowMs: number): number => {
    const start = Date.parse(row.periodStart);
    const end = Date.parse(row.periodEnd);
    if (end <= nowMs) return end;
    const at = Math.max(w.start.getTime(), Date.parse(row.updatedAt));
    return Math.max(start, Math.min(at, end, nowMs));
  };

  const currentWindow = async (org: OrgRow, now: Date): Promise<PeriodWindow> => {
    const w = periodFor(org, now);
    const nowMs = now.getTime();
    const planId = planFor(org.plan).id;
    const rows = await store.listPeriods({ orgId: org.orgId, meter: "session" });
    const open = rows.find((r) => isCurrentRow(r, w, planId) && Date.parse(r.periodStart) <= nowMs);
    if (open) return { start: new Date(open.periodStart), end: w.end };
    let start = w.start.getTime();
    for (const r of rows) {
      const end = r.state === "closed" ? Date.parse(r.periodEnd) : cutOf(r, w, nowMs);
      if (Date.parse(r.periodStart) < w.end.getTime() && end > start && end < w.end.getTime()) start = end;
    }
    return { start: new Date(Math.min(start, nowMs)), end: w.end };
  };

  const meterOrg = async (orgId: string) => {
    const org = await orgOf(orgId);
    if (!org) return undefined;
    const now = clock.now();
    const nowMs = now.getTime();
    const planId = planFor(org.plan).id;
    const anchored = periodFor(org, now);
    for (const open of await store.listPeriods({ orgId, meter: "session", state: "open" })) {
      if (isCurrentRow(open, anchored, planId)) continue;
      const window = { start: new Date(open.periodStart), end: new Date(cutOf(open, anchored, nowMs)) };
      const s = await sessionUsageIn(org, window, nowMs, open.plan);
      const b = await appBoxUsageIn(org, window, nowMs, open.plan);
      await savePeriods(org, s, b, "closed");
      await reportFor(org, s, b, true);
    }
    const window = await currentWindow(org, now);
    const session = await sessionUsageIn(org, window, nowMs);
    const boxes = await appBoxUsageIn(org, window, nowMs);
    const spend = spendOf(session, boxes, await capOf(orgId));
    await savePeriods(org, session, boxes, "open");
    const limits = session.limits;
    if (limits.sessionHoursHardCap && limits.sessionHours !== null) {
      if (session.usedMinutes >= limits.sessionHours * 60 * 0.8) await notifyOnce(org, window, "hours80", session, spend);
      if (session.usedMinutes >= limits.sessionHours * 60) await notifyOnce(org, window, "hours100", session, spend);
    } else if (spend.capCents !== null && spend.capCents > 0) {
      if (spend.totalCents >= spend.capCents * 0.8) await notifyOnce(org, window, "cap80", session, spend);
      if (spend.totalCents >= spend.capCents) await notifyOnce(org, window, "cap100", session, spend);
    }
    const over = hoursExhausted(limits, session) || capReached(limits, session, spend);
    const overBoxes = capReached(limits, session, spend) || (limits.appBoxHardCap && mode === "awake" && limits.appBoxAwakeHours !== null && boxes.awakeMinutes >= limits.appBoxAwakeHours * 60);
    const awakeBoxes = options.stopAppBoxesForQuota ? (await store.listBoxes(orgId)).filter((b) => b.status === "awake").length : 0;
    const stopSessions = over && session.running > 0;
    const stopBoxes = overBoxes && awakeBoxes > 0;
    const periodStart = window.start.toISOString();
    const pending = await store.getNotice(orgId, periodStart, "quota-stop");
    if (stopSessions || stopBoxes) {
      if (pending?.doneAt !== undefined) await store.deleteNotice(orgId, periodStart, "quota-stop");
      const current = pending?.doneAt !== undefined ? undefined : pending;
      if (current === undefined) {
        const stopAt = new Date(nowMs + QUOTA_STOP_NOTICE_MS).toISOString();
        await store.insertNotice({ orgId, periodStart, kind: "quota-stop", at: now.toISOString(), stopAt });
        if (stopSessions) {
          const code: UsageCode = hoursExhausted(limits, session) ? "SESSION_HOURS_USED_UP" : "SPENDING_CAP_REACHED";
          const env = envelope(code, org, { allowance: code === "SPENDING_CAP_REACHED" ? `${dollars(spend.capCents ?? 0)} a month` : `${limits.sessionHours} session-hours a month`, resetsOn: resetsOn(window) });
          const line =
            code === "SPENDING_CAP_REACHED"
              ? "vibtra: Spending cap reached; this session stops in 10 minutes unless IT raises the cap."
              : `vibtra: The Free plan's ${limits.sessionHours} session-hours are used up; this session stops in 10 minutes.`;
          options.notifyTerminals?.({ orgId }, { line, id: env.id, code, stopAt });
        }
        log(`metering: ${orgId} over its ${capReached(limits, session, spend) ? "spending cap" : stopSessions ? "session-hours" : "app box awake hours"}; ${stopSessions ? "running workspaces" : ""}${stopSessions && stopBoxes ? " and " : ""}${stopBoxes ? "awake app boxes" : ""} stop at ${stopAt}`);
      } else if (current.stopAt !== undefined && Date.parse(current.stopAt) <= nowMs) {
        const stopped = stopSessions ? ((await options.stopForQuota?.(orgId)) ?? 0) : 0;
        const slept = stopBoxes ? ((await options.stopAppBoxesForQuota?.(orgId)) ?? 0) : 0;
        await store.updateNotice(orgId, periodStart, "quota-stop", { doneAt: now.toISOString() });
        log(`metering: ${orgId} quota stop ran (${stopped} workspace(s), ${slept} app box(es))`);
      }
    } else if (!over && !overBoxes && pending !== undefined && pending.doneAt === undefined) {
      await store.deleteNotice(orgId, periodStart, "quota-stop");
      log(`metering: ${orgId} pending quota stop cancelled`);
    }
    if (limits.concurrentWorkspaces !== null && options.stopAboveConcurrency !== undefined) {
      const live = await options.workspaces.listWorkspaces({ orgId, statuses: ["running", "starting"] });
      if (live.length > limits.concurrentWorkspaces) {
        const stopped = await options.stopAboveConcurrency(orgId, limits.concurrentWorkspaces);
        log(`metering: ${orgId} above its ${limits.concurrentWorkspaces}-workspace limit; ${stopped} newest stopped`);
      }
    }
    await reportFor(org, session, boxes, false);
    return { org, session, boxes, spend };
  };

  const service = {
    clock,
    freeBudget,

    async sessionUsage(orgId: string): Promise<SessionUsageView | undefined> {
      const org = await orgOf(orgId);
      if (!org) return undefined;
      const now = clock.now();
      return sessionUsageIn(org, await currentWindow(org, now), now.getTime());
    },

    async appBoxUsage(orgId: string): Promise<AppBoxUsageView | undefined> {
      const org = await orgOf(orgId);
      if (!org) return undefined;
      const now = clock.now();
      return appBoxUsageIn(org, await currentWindow(org, now), now.getTime());
    },

    async spend(orgId: string): Promise<SpendView | undefined> {
      const org = await orgOf(orgId);
      if (!org) return undefined;
      const now = clock.now();
      const window = await currentWindow(org, now);
      return spendOf(await sessionUsageIn(org, window, now.getTime()), await appBoxUsageIn(org, window, now.getTime()), await capOf(orgId));
    },

    capCents: capOf,

    async setCap(orgId: string, actor: string, capDollars: number | null, confirm?: string): Promise<number | null> {
      const org = await orgOf(orgId);
      if (!org) throw new MeteringDoorError(404, "ORG_NOT_FOUND", "No such organisation");
      if (planFor(org.plan).limits.sessionHoursHardCap) throw new MeteringDoorError(409, "NO_OVERAGE_ON_FREE", "The Free plan has no overage, so it has no spending cap; upgrade to set one");
      if (capDollars === null && confirm !== "no cap") throw new MeteringDoorError(400, "VALIDATION", 'Removing the cap needs the typed confirmation "no cap"');
      if (capDollars !== null && (!Number.isInteger(capDollars) || capDollars < 0 || capDollars > 1_000_000)) throw new MeteringDoorError(400, "VALIDATION", "The cap is whole dollars from 0 to 1,000,000");
      const capCents = capDollars === null ? null : capDollars * 100;
      await store.setCap({ orgId, capCents, explicitUnlimited: capCents === null, setBy: actor, setAt: clock.now().toISOString() });
      await meterOrg(orgId);
      return capCents;
    },

    async checkStart(orgId: string, userId: string, kind: StartKind, extra: { profile?: string } = {}): Promise<void> {
      const org = await orgOf(orgId);
      if (!org) return;
      const limits = planFor(org.plan).limits;
      const now = clock.now();
      const window = await currentWindow(org, now);
      const reset = resetsOn(window);
      const profile = extra.profile !== undefined ? { profile: extra.profile } : {};
      const operation = kind === "app-box-wake" ? "wake" : "start";
      if (org.status === "waitlisted") throw new UsageRefusal("FREE_BUDGET_EXHAUSTED", envelope("FREE_BUDGET_EXHAUSTED", org, { operation, resetsOn: reset, ...profile }, userId));
      if (limits.sessionHoursHardCap) {
        const budget = await freeBudget(now);
        if (budget.ratio >= 1) throw new UsageRefusal("FREE_BUDGET_EXHAUSTED", envelope("FREE_BUDGET_EXHAUSTED", org, { operation, resetsOn: budget.resetsOn, ...profile }, userId));
      }
      if (kind === "workspace") {
        const session = await sessionUsageIn(org, window, now.getTime());
        if (hoursExhausted(limits, session)) {
          throw new UsageRefusal("SESSION_HOURS_USED_UP", envelope("SESSION_HOURS_USED_UP", org, { operation, allowance: `${limits.sessionHours} session-hours a month`, resetsOn: reset, ...profile }, userId));
        }
        const spend = spendOf(session, await appBoxUsageIn(org, window, now.getTime()), await capOf(orgId));
        if (capReached(limits, session, spend)) {
          throw new UsageRefusal("SPENDING_CAP_REACHED", envelope("SPENDING_CAP_REACHED", org, { operation, allowance: `${dollars(spend.capCents ?? 0)} a month`, resetsOn: reset, ...profile }, userId));
        }
        if (limits.concurrentWorkspaces !== null) {
          const others = (await options.workspaces.listWorkspaces({ orgId, statuses: ["running", "starting"] })).filter((w) => w.userId !== userId);
          if (others.length >= limits.concurrentWorkspaces) {
            const n = limits.concurrentWorkspaces;
            throw new UsageRefusal("CONCURRENCY_LIMIT", envelope("CONCURRENCY_LIMIT", org, { operation, allowance: `${n} workspace${n === 1 ? "" : "s"}`, ...profile }, userId), limits.sessionHoursHardCap ? "FREE_ONE_AT_A_TIME" : undefined);
          }
        }
        return;
      }
      const boxes = await appBoxUsageIn(org, window, now.getTime());
      if (kind === "app-box-create" && limits.appBoxes !== null && boxes.boxes >= limits.appBoxes) {
        if (limits.extraBoxCentsPerMonth === null) throw new UsageRefusal("APP_BOX_LIMIT", envelope("APP_BOX_LIMIT", org, { allowance: `${limits.appBoxes} app box${limits.appBoxes === 1 ? "" : "es"}` }, userId));
        const session = await sessionUsageIn(org, window, now.getTime());
        const spend = spendOf(session, boxes, await capOf(orgId));
        const addedCents = Math.max(0, boxes.boxes + 1 - limits.appBoxes - boxes.extraBoxes) * limits.extraBoxCentsPerMonth;
        if (spend.capCents !== null && spend.totalCents + addedCents > spend.capCents) {
          throw new UsageRefusal("SPENDING_CAP_REACHED", envelope("SPENDING_CAP_REACHED", org, { allowance: `${dollars(spend.capCents)} a month`, resetsOn: reset }, userId));
        }
      }
      if (kind === "app-box-wake" && mode === "awake" && limits.appBoxAwakeHours !== null && boxes.awakeMinutes >= limits.appBoxAwakeHours * 60) {
        if (limits.appBoxHardCap) {
          throw new UsageRefusal("APP_BOX_HOURS_USED_UP", envelope("APP_BOX_HOURS_USED_UP", org, { operation: "wake", allowance: `${limits.appBoxAwakeHours} awake hours a month`, resetsOn: reset }, userId));
        }
        const session = await sessionUsageIn(org, window, now.getTime());
        const spend = spendOf(session, boxes, await capOf(orgId));
        if (spend.capCents !== null && spend.totalCents >= spend.capCents) {
          throw new UsageRefusal("APP_BOX_HOURS_USED_UP", envelope("APP_BOX_HOURS_USED_UP", org, { operation: "wake", allowance: `${limits.appBoxAwakeHours} awake hours a month`, resetsOn: reset, paid: true }, userId));
        }
      }
    },

    async shouldWaitlist(): Promise<boolean> {
      return (await freeBudget()).ratio >= WAITLIST_AT;
    },

    async tick(): Promise<{ orgs: number }> {
      const orgs = new Set<string>();
      try {
        for (const w of await options.workspaces.listWorkspaces({})) orgs.add(w.orgId);
        for (const p of await store.listPeriods({ state: "open" })) orgs.add(p.orgId);
        for (const n of await store.listNotices({ kind: "quota-stop", open: true })) orgs.add(n.orgId);
      } catch (error) {
        log(`metering: tick could not list orgs (${(error as Error).message})`);
        return { orgs: 0 };
      }
      for (const orgId of orgs) {
        try {
          await meterOrg(orgId);
        } catch (error) {
          log(`metering: tick for ${orgId} failed (${(error as Error).message})`);
        }
      }
      return { orgs: orgs.size };
    },

    meterOrg,

    async view(orgId: string, emailOf?: (userId: string) => Promise<string | undefined>) {
      const org = await orgOf(orgId);
      if (!org) return undefined;
      const now = clock.now();
      const window = await currentWindow(org, now);
      const session = await sessionUsageIn(org, window, now.getTime());
      const boxes = await appBoxUsageIn(org, window, now.getTime());
      const capCents = await capOf(orgId);
      const spend = spendOf(session, boxes, capCents);
      const limits = session.limits;
      const periodStart = window.start.toISOString();
      const state = hoursExhausted(limits, session)
        ? ("exhausted" as const)
        : capReached(limits, session, spend)
          ? ("cap-reached" as const)
          : (limits.sessionHours !== null && session.usedMinutes >= limits.sessionHours * 60 * 0.8) || (capCents !== null && capCents > 0 && spend.totalCents >= capCents * 0.8)
            ? ("warn80" as const)
            : ("ok" as const);
      const sent = (await store.listReports({ orgId, meter: "session", periodStart, status: "sent" })).map((r) => r.sentAt).filter((x): x is string => x !== undefined).sort();
      const [cap80, cap100] = await Promise.all([store.getNotice(orgId, periodStart, "cap80"), store.getNotice(orgId, periodStart, "cap100")]);
      const perPerson = await Promise.all(
        session.perPerson.map(async (p) => {
          const email = emailOf ? await emailOf(p.userId).catch(() => undefined) : undefined;
          return { ...p, ...(email ? { email } : {}) };
        }),
      );
      return {
        planId: session.plan,
        session: {
          periodStart,
          periodEnd: window.end.toISOString(),
          includedHours: limits.sessionHours,
          hardCap: limits.sessionHoursHardCap,
          usedMinutes: session.usedMinutes,
          attachedMinutes: session.attachedMinutes,
          detachedMinutes: session.detachedMinutes,
          overageMinutes: session.overageMinutes,
          overageCents: session.overageCents,
          overageCentsPerHour: limits.sessionOverageCentsPerHour,
          state,
          ...(sent.length > 0 ? { reportedAt: sent[sent.length - 1]! } : {}),
          perPerson,
          running: session.running,
          concurrentLimit: limits.concurrentWorkspaces,
        },
        appBoxes: {
          mode,
          boxes: boxes.boxes,
          includedBoxes: limits.appBoxes,
          extraBoxes: boxes.extraBoxes,
          awakeMinutes: boxes.awakeMinutes,
          includedAwakeHours: limits.appBoxAwakeHours,
          hardCap: limits.appBoxHardCap,
          storageGbPerBox: limits.storageGbPerBox,
          overageCents: boxes.awakeOverageCents + boxes.extraCents,
        },
        ...(limits.sessionHoursHardCap ? {} : { spendingCap: { capCents, spentCents: spend.totalCents, notified80: cap80 !== undefined, notified100: cap100 !== undefined } }),
      };
    },

    appBoxes: {
      canCreate: (orgId: string, userId: string) => service.checkStart(orgId, userId, "app-box-create"),
      canWake: async (boxId: string, userId: string) => {
        const box = await store.getBox(boxId);
        if (!box) throw new MeteringDoorError(404, "APP_BOX_NOT_FOUND", "No such app box");
        await service.checkStart(box.orgId, userId, "app-box-wake");
      },
      async recordCreated(input: { orgId: string; name: string; storageGb?: number; id?: string }): Promise<AppBoxRow> {
        const org = await orgOf(input.orgId);
        const limit = planFor(org?.plan).limits.storageGbPerBox;
        const row: AppBoxRow = {
          id: input.id ?? `abx_${randomBytes(10).toString("hex")}`,
          orgId: input.orgId,
          name: input.name,
          status: "asleep",
          storageGb: Math.min(input.storageGb ?? limit ?? 0, limit ?? Number.MAX_SAFE_INTEGER),
          createdAt: clock.now().toISOString(),
        };
        await store.insertBox(row);
        if (org) {
          try {
            const now = clock.now();
            const window = await currentWindow(org, now);
            await savePeriods(org, await sessionUsageIn(org, window, now.getTime()), await appBoxUsageIn(org, window, now.getTime()), "open");
          } catch (error) {
            log(`metering: ${input.orgId} after a new box: ${(error as Error).message}`);
          }
        }
        return row;
      },
      async recordDeleted(boxId: string): Promise<void> {
        const at = clock.now().toISOString();
        await store.closeBoxInterval(boxId, at);
        await store.updateBox(boxId, { status: "deleted", deletedAt: at });
      },
      async recordAwake(boxId: string, at: Date = clock.now()): Promise<void> {
        const box = await store.getBox(boxId);
        if (!box) throw new MeteringDoorError(404, "APP_BOX_NOT_FOUND", "No such app box");
        await store.updateBox(boxId, { status: "awake" });
        await store.openBoxInterval({ boxId, orgId: box.orgId, awakeFrom: at.toISOString() });
      },
      async recordAsleep(boxId: string, at: Date = clock.now()): Promise<void> {
        await store.closeBoxInterval(boxId, at.toISOString());
        await store.updateBox(boxId, { status: "asleep" });
      },
      async awakeMinutes(orgId: string, window?: PeriodWindow): Promise<number> {
        const org = await orgOf(orgId);
        const now = clock.now();
        const w = window ?? (org ? await currentWindow(org, now) : periodFor(org, now));
        return meterAwake(await store.listBoxIntervals(orgId, w.start.toISOString(), w.end.toISOString()), w, now.getTime());
      },
      async awakeMinutesByBox(orgId: string): Promise<Map<string, number>> {
        const org = await orgOf(orgId);
        const now = clock.now();
        const w = org ? await currentWindow(org, now) : periodFor(org, now);
        const intervals = await store.listBoxIntervals(orgId, w.start.toISOString(), w.end.toISOString());
        const byBox = new Map<string, typeof intervals>();
        for (const i of intervals) byBox.set(i.boxId, [...(byBox.get(i.boxId) ?? []), i]);
        const out = new Map<string, number>();
        for (const [boxId, rows] of byBox) out.set(boxId, mode === "count" ? 0 : meterAwake(rows, w, now.getTime()));
        return out;
      },
      list: (orgId: string) => store.listBoxes(orgId),
      idleSleepMinutes: (planId: string) => planFor(planId).limits.idleSleepMin,
      storageLimitGb: (planId: string) => planFor(planId).limits.storageGbPerBox,
      mode: () => mode,
    },

    periods: (orgId: string): Promise<UsagePeriodRow[]> => store.listPeriods({ orgId }),
  };
  return service;
};

export type MeteringService = ReturnType<typeof createMeteringService>;

export class MeteringDoorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const idleSleepMinutes = (planId: string): number | null => planFor(planId).limits.idleSleepMin;
export const storageLimitGb = (planId: string): number | null => planFor(planId).limits.storageGbPerBox;
