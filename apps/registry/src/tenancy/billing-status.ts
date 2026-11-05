import { VibtraError } from "../errors.js";
import { appendVaultAudit } from "../vault/operations.js";
import type { VaultStore } from "../vault/store.js";
import { BILLING_STATUSES, type BillingStatus, type TenancyStore } from "./store.js";

export type { BillingStatus };

export const WRITABLE_BILLING_STATUSES: readonly BillingStatus[] = ["active", "past_due"];

export const BILLING_STATUS_WORDS: Readonly<Record<BillingStatus, string>> = {
  active: "up to date",
  past_due: "past due",
  unpaid: "unpaid",
};

export const billingStatusOf = (org: { billingStatus?: string } | undefined): BillingStatus =>
  (BILLING_STATUSES as readonly string[]).includes(org?.billingStatus ?? "")
    ? (org?.billingStatus as BillingStatus)
    : "active";

export const orgMayWrite = (org: { billingStatus?: string } | undefined): boolean =>
  WRITABLE_BILLING_STATUSES.includes(billingStatusOf(org));

export const requireWritableOrg = (org: { billingStatus?: string } | undefined, act: string): void => {
  if (orgMayWrite(org)) return;
  throw new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message: "This organisation is read-only until its bill is settled",
    detail:
      `${act} was refused because the last invoice for this organisation was not paid. Nothing was ` +
      `changed, nothing was deleted and nothing was revoked: deployed tools keep serving, the door ` +
      `tokens you already hold keep working, and every connection and receipt is still here. Settle ` +
      `the invoice — or talk to us — and this organisation writes again.`,
  });
};

export interface BillingStatusContext {
  tenancy: Pick<TenancyStore, "getOrg" | "setBillingStatus">;
  vault?: VaultStore | undefined;
  now?: () => Date;
}

export interface BillingStatusResult {
  orgId: string;
  orgName: string;
  previous: BillingStatus;
  next: BillingStatus;
  moved: boolean;
  audited: boolean;
}

export const setOrgBillingStatus = async (
  ctx: BillingStatusContext,
  args: { orgId: string; status: BillingStatus; actor: string; reason?: string },
): Promise<BillingStatusResult> => {
  const org = await ctx.tenancy.getOrg(args.orgId);
  if (org === undefined) {
    throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: args.orgId });
  }
  const previous = billingStatusOf(org);
  if (previous === args.status) {
    return { orgId: args.orgId, orgName: org.name, previous, next: args.status, moved: false, audited: false };
  }
  const at = (ctx.now ?? (() => new Date()))().toISOString();
  await ctx.tenancy.setBillingStatus(args.orgId, args.status, at);

  let audited = false;
  if (ctx.vault !== undefined) {
    await appendVaultAudit(
      ctx.vault,
      {
        orgId: args.orgId,
        event: "billing.status_changed",
        actorKind: "admin",
        actor: args.actor,
        outcome: "allowed",
        detail:
          `billing status ${previous} → ${args.status}` +
          (args.reason === undefined ? "" : ` (${args.reason})`),
      },
      at,
    );
    audited = true;
  }
  return { orgId: args.orgId, orgName: org.name, previous, next: args.status, moved: true, audited };
};
