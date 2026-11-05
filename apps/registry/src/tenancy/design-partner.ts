import { VibtraError } from "../errors.js";
import { DESIGN_PARTNER_DISCOUNT_PCT } from "../config.js";
import { appendVaultAudit } from "../vault/operations.js";
import type { VaultStore } from "../vault/store.js";
import type { OrgRow, TenancyStore } from "./store.js";

export interface DesignPartnerContext {
  tenancy: Pick<TenancyStore, "getOrg" | "setDesignPartner">;
  vault?: VaultStore | undefined;
  now?: () => Date;
}

export interface DesignPartnerResult {
  orgId: string;
  orgName: string;
  previous: OrgRow["designPartner"];
  next: OrgRow["designPartner"];
  audited: boolean;
}

const dealWord = (deal: OrgRow["designPartner"]): string =>
  deal === undefined ? "none" : `${deal.discountPct}% until ${deal.until}`;

const requireDate = (until: string): string => {
  const typed = until.trim();
  if (typed !== "" && !Number.isNaN(Date.parse(typed))) return typed;
  throw new VibtraError({
    code: "VALIDATION",
    message: "That is not a date",
    detail:
      `${JSON.stringify(until)} is not a date this registry can read — give an ISO date (2027-09-14). The console ` +
      "renders it to the customer on their own Billing page, so a value that parses to nothing would be a " +
      "sentence they cannot act on. Nothing was changed.",
  });
};

const requireActor = (actor: string): string => {
  const named = actor.trim();
  if (named !== "") return named;
  throw new VibtraError({
    code: "VALIDATION",
    message: "This change has to name somebody",
    detail:
      "an actor is required — the audit line records who agreed this deal, and a 50% discount with nobody's " +
      'name on it is precisely the "hidden discount" the founder\'s answer refuses. Nothing was changed.',
  });
};

export const setDesignPartner = async (
  ctx: DesignPartnerContext,
  args: { orgId: string; until: string | undefined; actor: string },
): Promise<DesignPartnerResult> => {
  const actor = requireActor(args.actor);
  const org = await ctx.tenancy.getOrg(args.orgId);
  if (org === undefined) {
    throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: args.orgId });
  }
  const previous = org.designPartner;
  const next =
    args.until === undefined
      ? undefined
      : { until: requireDate(args.until), discountPct: DESIGN_PARTNER_DISCOUNT_PCT };
  await ctx.tenancy.setDesignPartner(args.orgId, next);
  let audited = false;
  if (ctx.vault !== undefined) {
    await appendVaultAudit(
      ctx.vault,
      {
        orgId: args.orgId,
        event: "plan.changed",
        actorKind: "admin",
        actor,
        outcome: "allowed",
        detail: `design partner ${dealWord(previous)} → ${dealWord(next)}`,
      },
      (ctx.now ?? (() => new Date()))().toISOString(),
    );
    audited = true;
  }
  return { orgId: args.orgId, orgName: org.name, previous, next, audited };
};
