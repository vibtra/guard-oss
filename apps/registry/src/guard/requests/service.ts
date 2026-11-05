import { randomBytes } from "node:crypto";
import { GUARD_GRANT_DEFAULT_DAYS, GUARD_GRANT_MAX_DAYS, GUARD_REQUEST_KIND, GuardAskSubject, guardAskKey } from "@vibtra/guard-contract";
import { privacyProblems } from "@vibtra/guard-contract/policy";
import type { GuardRequestStore, PolicyGrantRow, PolicyRequestRow, PolicyRequestRowKind, PolicyRequestStatus } from "./store.js";

const HISTORY_GAP_CLEAR_RULE = "vibtra-gap-clear";

export class RequestDeskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const REQUEST_REMINDER_DAYS = 7;
export const REQUEST_EXPIRY_DAYS = 14;
export const REASK_QUIET_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 86_400_000;

export interface DeskActor {
  userId: string;
  email: string;
}

export interface GuardRequestDeskOptions {
  store: GuardRequestStore;
  now?: () => Date;
  notify?: (row: PolicyRequestRow, requester: DeskActor) => Promise<void>;
  audit?: (entry: { orgId: string; event: "policy.request.decided" | "policy.grant.revoked"; actor: string; detail: string; outcome?: "allowed" | "refused" }) => Promise<void>;
  env?: NodeJS.ProcessEnv;
}

export function testGrantTtlFrom(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env.VIBTRA_TEST_GRANT_TTL_S?.trim();
  if (!raw) return undefined;
  if (env.NODE_ENV === "production") throw new Error("VIBTRA_TEST_GRANT_TTL_S is a test switch and is refused in production");
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 86_400) throw new Error("VIBTRA_TEST_GRANT_TTL_S must be 1..86400 seconds");
  return n;
}

const historyTargetWords = (s: Record<string, string | number | undefined>): string =>
  s.name !== undefined ? `the ${s.ecosystem ?? "npm"} package ${s.name}` : s.host !== undefined ? `${s.host}${s.port && s.port !== 443 ? `:${s.port}` : ""}` : "this workspace";

export function subjectWords(row: Pick<PolicyRequestRow, "kind" | "subject">): string {
  const s = row.subject as Record<string, string | number | undefined>;
  switch (row.kind) {
    case "egress-host":
      return `network access to ${s.host}${s.port && s.port !== 443 ? `:${s.port}` : ""}`;
    case "package":
      return `the ${s.ecosystem} package ${s.name}${s.version ? `@${s.version}` : ""}`;
    case "package-registry":
      return `the ${s.registry === "cargo" ? "crates.io" : s.registry === "go" ? "Go module" : "RubyGems"} registry (unfiltered)`;
    case "connector":
      return typeof s.name === "string" && s.name !== "" ? `the ${s.name} connection (${s.connectionId})` : `the connection ${s.connectionId}`;
    case "model":
      return `the model ${s.provider}${s.model ? `/${s.model}` : ""}`;
    case "image-change":
      return `the OS package ${s.package} in the workspace image`;
    case "policy-change":
      return `a change to the workspace policy (${s.revision})`;
    case "spending-cap":
      return s.dollars !== undefined ? `a monthly spending cap of $${s.dollars}` : "a higher monthly spending cap";
    case "plan":
      return s.plan !== undefined ? `an upgrade to the ${s.plan === "business" ? "Business" : "Team"} plan` : "a plan upgrade";
    case "app-promote":
      return `hosting the app ${s.app} at commit ${String(s.commit ?? "").slice(0, 12)}${s.newApp ? " (a new app box)" : ""}`;
    case "history-exception":
      return s.rule === HISTORY_GAP_CLEAR_RULE ? "clearing the workspace's history gap" : `an exception to the history rule ${s.rule} for ${historyTargetWords(s)}`;
    case "guard": {
      const service = typeof s.serviceName === "string" && s.serviceName !== "" ? s.serviceName : String(s.serviceId);
      const rule = typeof s.ruleName === "string" && s.ruleName !== "" ? s.ruleName : s.ruleId !== undefined ? String(s.ruleId) : undefined;
      return rule === undefined ? `using ${service} from their laptop` : `sending what the rule "${rule}" blocks to ${service}`;
    }
  }
}

const guardSubject = (value: unknown, requesterUserId: string): { subject: Record<string, unknown>; key: string } => {
  const parsed = GuardAskSubject.safeParse(value);
  if (!parsed.success) throw new RequestDeskError(400, "VALIDATION", `a guard subject is ${JSON.stringify(Object.keys(GuardAskSubject.shape))}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  return { subject: parsed.data, key: guardAskKey(parsed.data, requesterUserId) };
};

const newId = (prefix: "preq" | "pgr"): string => `${prefix}_${randomBytes(10).toString("hex")}`;

const noteProblem = (note: string | undefined): boolean => note !== undefined && (note.length > 280 || privacyProblems(note).length > 0);

export const createGuardRequestDesk = (options: GuardRequestDeskOptions) => {
  const { store } = options;
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? (async () => undefined);
  testGrantTtlFrom(options.env ?? process.env);
  const notify = async (row: PolicyRequestRow, who: DeskActor) => {
    try {
      await options.notify?.(row, who);
    } catch {
    }
  };

  const settle = async (row: PolicyRequestRow): Promise<PolicyRequestRow> => {
    if (row.status !== "pending" || new Date(row.expiresAt).getTime() > now().getTime()) return row;
    return (await store.updateRequest(row.id, "pending", { status: "expired", decidedAt: now().toISOString() })) ?? (await store.getRequest(row.id))!;
  };

  const recentlyRefused = async (orgId: string, userId: string, kind: string, key: string, at: Date): Promise<boolean> => {
    const since = at.getTime() - REASK_QUIET_MS;
    const rows = await Promise.all((await store.listRequests(orgId, { requesterUserId: userId })).filter((r) => r.kind === kind && r.subjectKey === key && r.status !== "approved").map(settle));
    return rows.some((r) => (r.status === "declined" && r.decidedAt !== undefined && new Date(r.decidedAt).getTime() >= since) || (r.status === "expired" && new Date(r.expiresAt).getTime() >= since));
  };

  const liveGrants = async (orgId: string): Promise<PolicyGrantRow[]> => {
    const at = now().getTime();
    return (await store.listGrants(orgId, {})).filter((g) => g.expiresAt === undefined || new Date(g.expiresAt).getTime() > at);
  };

  const pendingRequest = async (orgId: string, id: string): Promise<PolicyRequestRow> => {
    const found = await store.getRequest(id);
    if (!found || found.orgId !== orgId) throw new RequestDeskError(404, "REQUEST_NOT_FOUND", "No such request");
    return settle(found);
  };

  const desk = {
    async raise(orgId: string, requester: DeskActor, input: { kind: typeof GUARD_REQUEST_KIND; subject: unknown; why?: string }) {
      const { subject, key } = guardSubject(input.subject, requester.userId);
      if (input.why !== undefined) {
        const why = input.why.trim();
        if (why === "" || why.length > 280) throw new RequestDeskError(400, "VALIDATION", "why is one short reason (1–280 characters)");
        if (privacyProblems(why).length > 0) throw new RequestDeskError(400, "VALIDATION", "why must not carry a secret");
      }
      const at = now();
      const { row, created } = await store.insertRequest({
        id: newId("preq"),
        orgId,
        requesterUserId: requester.userId,
        kind: GUARD_REQUEST_KIND,
        subject,
        subjectKey: key,
        ...(input.why ? { why: input.why.trim() } : {}),
        status: "pending",
        reminderAt: new Date(at.getTime() + REQUEST_REMINDER_DAYS * DAY_MS).toISOString(),
        expiresAt: new Date(at.getTime() + REQUEST_EXPIRY_DAYS * DAY_MS).toISOString(),
        createdAt: at.toISOString(),
      });
      if (created && !(await recentlyRefused(orgId, requester.userId, GUARD_REQUEST_KIND, key, at))) await notify(row, requester);
      return { request: desk.requestView(row), created };
    },

    requestView(row: PolicyRequestRow) {
      const { why: _why, ...rest } = row;
      return { ...rest, words: subjectWords(row) };
    },

    async listRequests(orgId: string, filter: { status?: PolicyRequestStatus; kind?: PolicyRequestRowKind } = {}) {
      const rows = await Promise.all((await store.listRequests(orgId, {})).map(settle));
      return rows.filter((r) => (filter.status === undefined || r.status === filter.status) && (filter.kind === undefined || r.kind === filter.kind)).map((r) => desk.requestView(r));
    },

    async myRequests(orgId: string, userId: string) {
      return Promise.all((await store.listRequests(orgId, { requesterUserId: userId })).map(settle));
    },

    async getRequest(orgId: string, id: string) {
      const row = await pendingRequest(orgId, id);
      const open = (await store.listRequests(orgId, { status: "pending", kind: row.kind })).filter((r) => r.subjectKey === row.subjectKey && r.id !== row.id).length;
      const holders = (await liveGrants(orgId)).filter((g) => g.kind === row.kind && g.subjectKey === row.subjectKey).length;
      return { request: desk.requestView(row), facts: { kind: row.kind, words: subjectWords(row), otherOpenRequests: open, liveGrants: holders, expiresAt: row.expiresAt } };
    },

    async approve(orgId: string, actor: DeskActor, id: string, input: { grant?: { days?: number; hours?: number; scope?: "user" | "org" }; note?: string } = {}) {
      const row = await pendingRequest(orgId, id);
      if (row.status === "expired") throw new RequestDeskError(409, "REQUEST_EXPIRED", "This request expired before anyone decided it");
      if (row.status !== "pending") throw new RequestDeskError(409, "REQUEST_DECIDED", `This request is already ${row.status}`);
      const at = now();
      const note = input.note?.trim();
      if (noteProblem(note)) throw new RequestDeskError(400, "VALIDATION", "a note is one short sentence (<= 280 characters) and carries no secret");
      if (row.kind !== GUARD_REQUEST_KIND) throw new RequestDeskError(409, "REQUEST_NOT_GUARD", "Guard approves Guard asks only; this request came from the retired workspace platform");
      const scope = input.grant?.scope ?? "user";
      const days = input.grant?.days ?? GUARD_GRANT_DEFAULT_DAYS;
      if (!Number.isInteger(days) || days < 1 || days > GUARD_GRANT_MAX_DAYS) {
        throw new RequestDeskError(422, "LEASE_TOO_LONG", `a guard grant lasts 1 to ${GUARD_GRANT_MAX_DAYS} days; to allow it for good, change the Guard rules`);
      }
      const testGrantTtlS = testGrantTtlFrom(options.env ?? process.env);
      const hours = input.grant?.days === undefined ? input.grant?.hours : undefined;
      if (hours !== undefined && (!Number.isInteger(hours) || hours < 1 || hours > 23)) throw new RequestDeskError(422, "LEASE_TOO_LONG", "an hours grant lasts 1 to 23 hours");
      const ms = testGrantTtlS !== undefined ? testGrantTtlS * 1000 : hours !== undefined ? hours * 3_600_000 : days * DAY_MS;
      const expiresAt = new Date(at.getTime() + ms).toISOString();
      const grantId = newId("pgr");
      await store.insertGrant({
        id: grantId,
        orgId,
        scope,
        ...(scope === "user" ? { userId: row.requesterUserId } : {}),
        kind: GUARD_REQUEST_KIND,
        subject: row.subject,
        subjectKey: row.subjectKey,
        expiresAt,
        requestId: row.id,
        approvedBy: actor.userId,
        createdAt: at.toISOString(),
      });
      const updated = await store.updateRequest(row.id, "pending", { status: "approved", grantId, decidedBy: actor.userId, decidedAt: at.toISOString(), ...(note ? { decisionNote: note } : {}) });
      if (!updated) throw new RequestDeskError(409, "REQUEST_DECIDED", "This request was decided by someone else just now");
      await audit({ orgId, event: "policy.request.decided", actor: actor.email || actor.userId, detail: `${row.kind} ${row.subjectKey} approved as grant ${grantId} (${scope}, until ${expiresAt})` });
      return { request: desk.requestView(updated), grant: (await store.getGrant(grantId))! };
    },

    async decline(orgId: string, actor: DeskActor, id: string, input: { note?: string } = {}) {
      const row = await pendingRequest(orgId, id);
      if (row.status !== "pending") throw new RequestDeskError(409, row.status === "expired" ? "REQUEST_EXPIRED" : "REQUEST_DECIDED", `This request is already ${row.status}`);
      const note = input.note?.trim();
      if (noteProblem(note)) throw new RequestDeskError(400, "VALIDATION", "a note is one short sentence (<= 280 characters) and carries no secret");
      const updated = await store.updateRequest(row.id, "pending", { status: "declined", decidedBy: actor.userId, decidedAt: now().toISOString(), ...(note ? { decisionNote: note } : {}) });
      if (!updated) throw new RequestDeskError(409, "REQUEST_DECIDED", "This request was decided by someone else just now");
      await audit({ orgId, event: "policy.request.decided", actor: actor.email || actor.userId, detail: `${row.kind} ${row.subjectKey} declined`, outcome: "refused" });
      return { request: desk.requestView(updated) };
    },

    async revokeGrant(orgId: string, actor: DeskActor, id: string) {
      const g = await store.getGrant(id);
      if (!g || g.orgId !== orgId) throw new RequestDeskError(404, "GRANT_NOT_FOUND", "No such grant");
      const revoked = await store.revokeGrant(id, actor.userId, now().toISOString());
      if (!revoked) throw new RequestDeskError(409, "GRANT_REVOKED", "This grant is already revoked");
      await audit({ orgId, event: "policy.grant.revoked", actor: actor.email || actor.userId, detail: `grant ${id} (${g.kind} ${g.subjectKey}) revoked` });
      return { grant: revoked };
    },

    async listGrants(orgId: string) {
      const at = now().getTime();
      return (await store.listGrants(orgId, { includeRevoked: true })).map((g) => ({ ...g, live: g.revokedAt === undefined && (g.expiresAt === undefined || new Date(g.expiresAt).getTime() > at) }));
    },
  };
  return desk;
};

export type GuardRequestDesk = ReturnType<typeof createGuardRequestDesk>;
