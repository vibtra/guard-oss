import { VibtraError } from "../errors.js";
import { appendVaultAudit } from "../vault/operations.js";
import type { VaultStore } from "../vault/store.js";
import type { PlanChangeRequestRow, PlanRequestStore } from "./plan-request-store.js";
import type { OrgRow, TenancyStore } from "./store.js";

export interface PlanChangeContext {
  tenancy: Pick<TenancyStore, "getOrg" | "setPlan" | "setUserLimit" | "setConnectionLimit">;
  vault?: VaultStore | undefined;
  planRequests?: PlanRequestStore | undefined;
  now?: () => Date;
}

export type OrgLimitKind = "users" | "connections";

const LIMIT_LABEL: Readonly<Record<OrgLimitKind, string>> = {
  users: "user limit",
  connections: "connection limit",
};

const limitWord = (value: number | undefined): string =>
  value === undefined ? "the plan's own number" : String(value);

const requireActor = (actor: string): string => {
  const named = actor.trim();
  if (named !== "") return named;
  throw new VibtraError({
    code: "VALIDATION",
    message: "This change has to name somebody",
    detail:
      "an actor is required — the audit line and the decided row both record who did this, and " +
      '"whoever had shell access" is not an answer to "who moved this customer". Nothing was changed.',
  });
};

const mustGetOrg = async (ctx: PlanChangeContext, orgId: string): Promise<OrgRow> => {
  const org = await ctx.tenancy.getOrg(orgId);
  if (org === undefined) {
    throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
  }
  return org;
};

export interface PlanChangeResult {
  orgId: string;
  orgName: string;
  previous: string;
  next: string;
  audited: boolean;
}

export const changeOrgPlan = async (
  ctx: PlanChangeContext,
  args: { orgId: string; plan: string; actor: string; requestId?: string | undefined },
): Promise<PlanChangeResult> => {
  const actor = requireActor(args.actor);
  const org = await mustGetOrg(ctx, args.orgId);
  const previous = org.plan;
  if (previous === args.plan) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "That org is already on that plan",
      detail: `${org.name} (${org.orgId}) is on ${previous} — nothing to change, and nothing was written`,
    });
  }
  await ctx.tenancy.setPlan(args.orgId, args.plan);
  const audited = await writeLine(ctx, {
    orgId: args.orgId,
    event: "plan.changed",
    actor,
    detail: `plan ${previous} → ${args.plan}${args.requestId === undefined ? "" : ` (request ${args.requestId})`}`,
  });
  return { orgId: args.orgId, orgName: org.name, previous, next: args.plan, audited };
};

export const changeOrgLimit = async (
  ctx: PlanChangeContext,
  args: { orgId: string; kind: OrgLimitKind; limit: number | undefined; actor: string },
): Promise<PlanChangeResult> => {
  const actor = requireActor(args.actor);
  const org = await mustGetOrg(ctx, args.orgId);
  const previous = args.kind === "users" ? org.userLimit : org.connectionLimit;
  if (previous === args.limit) {
    throw new VibtraError({
      code: "VALIDATION",
      message: `That org's ${LIMIT_LABEL[args.kind]} is already that`,
      detail: `${org.name} (${org.orgId}) already reads ${limitWord(previous)} — nothing was written`,
    });
  }
  if (args.kind === "users") await ctx.tenancy.setUserLimit(args.orgId, args.limit);
  else await ctx.tenancy.setConnectionLimit(args.orgId, args.limit);
  const audited = await writeLine(ctx, {
    orgId: args.orgId,
    event: "limit.changed",
    actor,
    detail: `${LIMIT_LABEL[args.kind]} ${limitWord(previous)} → ${limitWord(args.limit)}`,
  });
  return {
    orgId: args.orgId,
    orgName: org.name,
    previous: limitWord(previous),
    next: limitWord(args.limit),
    audited,
  };
};

const writeLine = async (
  ctx: PlanChangeContext,
  row: { orgId: string; event: "plan.changed" | "limit.changed"; actor: string; detail: string },
): Promise<boolean> => {
  if (ctx.vault === undefined) return false;
  await appendVaultAudit(
    ctx.vault,
    {
      orgId: row.orgId,
      event: row.event,
      actorKind: "admin",
      actor: row.actor,
      outcome: "allowed",
      detail: row.detail,
    },
    (ctx.now ?? (() => new Date()))().toISOString(),
  );
  return true;
};


export interface PlanRequestOutcome {
  request: PlanChangeRequestRow;
  orgName: string;
  previous: string;
  next: string;
  moved: boolean;
  audited: boolean;
}

const requireQueue = (ctx: PlanChangeContext): PlanRequestStore => {
  if (ctx.planRequests !== undefined) return ctx.planRequests;
  throw new VibtraError({
    code: "VALIDATION",
    message: "This registry has no plan-change queue",
    detail:
      "plan-change requests need the org stores this build was not constructed with (REGISTRY_MODE=hosted with " +
      "tenancy). Nothing was changed.",
  });
};

const settle = async (
  ctx: PlanChangeContext,
  args: { requestId: string; status: "approved" | "declined"; actor: string; note?: string | undefined },
): Promise<PlanChangeRequestRow> => {
  const actor = requireActor(args.actor);
  const queue = requireQueue(ctx);
  const before = await queue.getRequest(args.requestId);
  if (before === undefined) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "No such plan-change request",
      detail: `${JSON.stringify(args.requestId)} is not in this registry's queue. Run \`plan-requests list\`.`,
    });
  }
  const settled = await queue.decideRequest({
    requestId: args.requestId,
    status: args.status,
    decidedBy: actor,
    ...(args.note === undefined ? {} : { decisionNote: args.note }),
    decidedAt: (ctx.now ?? (() => new Date()))().toISOString(),
  });
  if (settled === undefined) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "That request has already been decided",
      detail:
        `${before.decidedBy ?? "somebody"} ${before.status} it${
          before.decidedAt === undefined ? "" : ` at ${before.decidedAt}`
        }. A decision is made once; nothing was changed.`,
    });
  }
  return settled;
};

export const approvePlanChangeRequest = async (
  ctx: PlanChangeContext,
  args: { requestId: string; actor: string; note?: string | undefined },
): Promise<PlanRequestOutcome> => {
  requireActor(args.actor);
  const queue = requireQueue(ctx);
  const pending = await queue.getRequest(args.requestId);
  const org = pending === undefined ? undefined : await ctx.tenancy.getOrg(pending.orgId);
  const alreadyThere = pending !== undefined && org?.plan === pending.wantedPlan;

  const settled = await settle(ctx, { ...args, status: "approved" });
  const previous = org?.plan ?? settled.currentPlan;
  if (alreadyThere) {
    return {
      request: settled,
      orgName: org?.name ?? settled.orgId,
      previous,
      next: settled.wantedPlan,
      moved: false,
      audited: false,
    };
  }

  const changed = await changeOrgPlan(ctx, {
    orgId: settled.orgId,
    plan: settled.wantedPlan,
    actor: args.actor,
    requestId: settled.requestId,
  });
  return {
    request: settled,
    orgName: changed.orgName,
    previous: changed.previous,
    next: changed.next,
    moved: true,
    audited: changed.audited,
  };
};

export const declinePlanChangeRequest = async (
  ctx: PlanChangeContext,
  args: { requestId: string; actor: string; note?: string | undefined },
): Promise<PlanRequestOutcome> => {
  const settled = await settle(ctx, { ...args, status: "declined" });
  const org = await ctx.tenancy.getOrg(settled.orgId);
  return {
    request: settled,
    orgName: org?.name ?? settled.orgId,
    previous: org?.plan ?? settled.currentPlan,
    next: org?.plan ?? settled.currentPlan,
    moved: false,
    audited: false,
  };
};
