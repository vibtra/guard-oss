import { randomUUID } from "node:crypto";
import { VibtraError } from "../errors.js";
import { isAtLimit, planFor, userLimitFor } from "../config.js";
import { isPublicEmailDomain } from "./public-domains.js";
import { requireWritableOrg } from "./billing-status.js";
import type { OrgRole } from "../auth/session.js";
import type { MemberDirectory } from "./members.js";
import type { Coordinated } from "../store/coordination.js";
import { joinPolicyOf, type OrgRow, type TenancyStore } from "./store.js";

export { PUBLIC_EMAIL_DOMAINS } from "./public-domains.js";

export interface SignInProfile {
  email: string;
  emailVerified: boolean;
  hostedDomain?: string;
}

export interface ClaimContext {
  orgs: Pick<TenancyStore, "getOrg" | "createOrg" | "findOrgByDomain"> & Coordinated;
  members: MemberDirectory;
  ssoDomains?: (domain: string) => Promise<string | undefined>;
  pendingInvitation?: (email: string) => Promise<boolean>;
  overflowSeats?: boolean;
  noPeopleLimit?: boolean;
  beforeJoinWrite?: (join: { orgId: string; email: string }) => Promise<void>;
  waitlist?: (org: { domain?: string }) => Promise<boolean>;
  ownerEmail?: string;
  singleOrg?: { orgExists: () => Promise<boolean> };
  registration?: {
    mode: "allowlist";
    operatorDomain?: string;
    contactEmail?: string;
    isAllowed: (email: string) => Promise<boolean>;
  };
}

export type ClaimPlan =
  | { kind: "join"; orgId: string }
  | { kind: "none"; reason: string }
  | {
      kind: "create";
      name: string;
      slug: string;
      domain?: string;
      ownOrg?: true;
    };

type CreatePlan = Extract<ClaimPlan, { kind: "create" }>;

export interface ClaimOutcome {
  orgId: string;
  role: OrgRole;
  createdOrg: boolean;
}

const ADMINS_NAMED = 3;

const ownerHandleOf = (local: string): string => {
  const handle = local
    .toLowerCase()
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return handle === "" ? "owner" : handle;
};

export const UNSAFE_IN_ADDRESS = /[\s\u0000-\u001f\u007f]/u;

const refuseIfOrgIsFull = async (ctx: ClaimContext, org: OrgRow, email: string): Promise<void> => {
  requireWritableOrg(org, `adding ${email} to ${org.name}`);
  if (ctx.noPeopleLimit === true) return;
  const limit = userLimitFor(org);
  const count = await ctx.members.countMembers(org.orgId);
  if (!isAtLimit(count, limit)) return;
  if (ctx.overflowSeats === true && !planFor(org.plan).limits.sessionHoursHardCap) return;
  if (planFor(org.plan).limits.sessionHoursHardCap && org.userLimit === undefined) throw freeMemberLimit(org.name, email, count, limit);
  const admins = (await ctx.members.listAdmins(org.orgId)).map((a) => a.email);
  const named = admins.slice(0, ADMINS_NAMED).join(", ");
  const whoToAsk =
    admins.length === 0
      ? "an administrator of that org"
      : `${named}${admins.length > ADMINS_NAMED ? ` and ${admins.length - ADMINS_NAMED} other admin${admins.length - ADMINS_NAMED === 1 ? "" : "s"}` : ""}`;
  throw new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message:
      `${org.name} is full: it already has ${count} of the ${limit} people ` +
      `${org.userLimit === undefined ? `its ${planFor(org.plan).name} plan allows` : "its own user limit allows"}, ` +
      `so ${email} was not added. ` +
      `Ask ${whoToAsk} to request a larger plan from the console's Billing page, or to raise its user limit.`,
    detail:
      `join refused for ${email} into org ${org.orgId} (${org.name}): userLimit ${limit} ` +
      `(plan ${planFor(org.plan).id}${org.userLimit === undefined ? "" : ", per-org override"}), current members ${count}. ` +
      "Nothing was created: no user row was written and the org is unchanged.",
  });
};

export const freeMemberLimit = (orgName: string, email: string, count: number, limit: number | null): VibtraError =>
  new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message: `${orgName} already has the Free plan's ${limit ?? count} people (MEMBER_LIMIT), so ${email} was not added. Ask an admin to upgrade the plan (vibtra request plan upgrade, or the console's Usage & billing page).`,
    detail: `join refused for ${email}: MEMBER_LIMIT — Free plan, ${count} of ${limit ?? count} people. Nothing was created.`,
  });

let claimChain: Promise<unknown> = Promise.resolve();

const serialized = <T>(run: () => Promise<T>): Promise<T> => {
  const next = claimChain.then(run);
  claimChain = next.catch(() => undefined);
  return next;
};

const underLock = <T>(ctx: ClaimContext, key: string, run: () => Promise<T>): Promise<T> => {
  const coordinator = ctx.orgs.coordinator;
  return coordinator === undefined ? run() : coordinator.lock(key, run);
};

const refuseUninvitedJoin = async (
  ctx: ClaimContext,
  org: OrgRow,
  email: string,
): Promise<ClaimPlan | undefined> => {
  if (joinPolicyOf(org.joinPolicy) !== "invite") return undefined;

  const invited = ctx.pendingInvitation === undefined ? false : await ctx.pendingInvitation(email);
  if (invited) {
    return {
      kind: "none",
      reason: `${email} holds a pending invitation to ${org.name}; the accept screen is what admits them`,
    };
  }

  const admins = (await ctx.members.listAdmins(org.orgId)).map((a) => a.email);
  const named = admins.slice(0, ADMINS_NAMED).join(", ");
  const whoToAsk =
    admins.length === 0
      ? "an administrator of that organisation"
      : `${named}${
          admins.length > ADMINS_NAMED
            ? ` and ${admins.length - ADMINS_NAMED} other admin${admins.length - ADMINS_NAMED === 1 ? "" : "s"}`
            : ""
        }`;
  throw new VibtraError({
    code: "VALIDATION",
    message:
      `${org.name} does not add people automatically, so ${email} was not added. ` +
      `Ask an admin for an invitation — ${whoToAsk} can send you one — and sign in again with the link.`,
    detail:
      `sign-in refused for ${email}: org ${org.orgId} (${org.name}) has joinPolicy "invite" (migration 0028), and ` +
      "no pending invitation exists for this address. Nothing was created: no user row was written and the org " +
      "is unchanged.",
  });
};

const secondOrgRefusal = (email: string): VibtraError =>
  new VibtraError({
    code: "VALIDATION",
    message:
      `This Guard server has one organisation, so ${email} was not signed up and nothing was created. ` +
      "Ask an admin of that organisation to invite you, and sign in again with the link.",
    detail:
      `sign-in refused for ${email}: GUARD_MULTI_ORG is 0 and an organisation already exists; the plan would have ` +
      "created another. Nothing was created: no user row was written.",
  });

const refuseSecondOrg = async (ctx: ClaimContext, email: string, plan: CreatePlan): Promise<ClaimPlan> => {
  if (ctx.singleOrg === undefined || !(await ctx.singleOrg.orgExists())) return plan;
  const invited = ctx.pendingInvitation === undefined ? false : await ctx.pendingInvitation(email.trim().toLowerCase());
  if (invited) {
    return { kind: "none", reason: `${email} holds a pending invitation; the accept screen is what admits them` };
  }
  throw secondOrgRefusal(email);
};

const refuseUnlistedCreate = async (
  ctx: ClaimContext,
  email: string,
  plan: CreatePlan,
): Promise<ClaimPlan> => {
  const registration = ctx.registration;
  if (registration === undefined) return plan;

  const wanted = email.trim().toLowerCase();
  if (ctx.ownerEmail !== undefined && wanted === ctx.ownerEmail) return plan;
  const host = wanted.split("@")[1] ?? "";
  if (registration.operatorDomain !== undefined && host === registration.operatorDomain) return plan;
  if (await registration.isAllowed(wanted)) return plan;

  const invited = ctx.pendingInvitation === undefined ? false : await ctx.pendingInvitation(wanted);
  if (invited) {
    return {
      kind: "none",
      reason: `${email} holds a pending invitation; the accept screen is what admits them, and sign-ups are otherwise closed`,
    };
  }

  throw new VibtraError({
    code: "VALIDATION",
    message:
      `Vibtra is onboarding by invitation right now, so ${email} was not signed up and nothing was created.` +
      (registration.contactEmail === undefined ? "" : ` Write to ${registration.contactEmail} to ask for access.`),
    detail:
      `sign-in refused for ${email}: REGISTRY_REGISTRATION is allowlist and neither the address nor its domain ` +
      "is listed; the plan would have created a new organisation. Nothing was created: no user row was written.",
  });
};

export const planOrgForSignIn = (ctx: ClaimContext, profile: SignInProfile): Promise<ClaimPlan> =>
  serialized(async () => {
    if (!profile.emailVerified) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Sign-in requires a verified email address",
        detail: `the identity provider did not assert a verified email for ${profile.email} — an unverified address cannot claim or join an org`,
      });
    }
    const parts = profile.email.split("@");
    const local = parts.length === 2 ? (parts[0] ?? "") : "";
    const host = parts.length === 2 ? (parts[1] ?? "") : "";
    if (parts.length !== 2 || local === "" || host === "" || UNSAFE_IN_ADDRESS.test(profile.email)) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "That sign-in email is not one unambiguous address, so it cannot decide org membership.",
        detail: `the identity provider asserted an email with ${parts.length - 1} "@" (or an empty part, or whitespace); org membership is never derived from an ambiguous address`,
      });
    }
    const emailDomain = host.toLowerCase();
    const domain = (profile.hostedDomain ?? emailDomain).toLowerCase();

    if (isPublicEmailDomain(domain) && ctx.ownerEmail !== undefined && profile.email.trim().toLowerCase() === ctx.ownerEmail) {
      const handle = ownerHandleOf(local);
      return refuseSecondOrg(ctx, profile.email, { kind: "create", name: handle, slug: handle, ownOrg: true });
    }

    if (isPublicEmailDomain(domain)) {
      const invited = ctx.pendingInvitation === undefined ? false : await ctx.pendingInvitation(profile.email.trim().toLowerCase());
      if (invited) {
        return { kind: "none", reason: `${profile.email} holds a pending invitation; the accept screen is what admits them` };
      }
      throw new VibtraError({
        code: "VALIDATION",
        message: `Use your work email to create an organisation. ${profile.email} is a personal mailbox, so nothing was created; a colleague can invite you to their organisation instead.`,
        detail: `sign-in refused for ${profile.email}: ${domain} is a public email provider (m3-8) and the address holds no invitation. Nothing was created: no user row was written.`,
      });
    }

    const claimed = await ctx.orgs.findOrgByDomain(domain);
    if (claimed !== undefined) {
      if (claimed.closedAt !== undefined) {
        throw new VibtraError({
          code: "VALIDATION",
          message:
            `${claimed.name} is closed, so ${profile.email} cannot sign in to it. ` +
            "An organisation is closed by one of its owners and closing cannot be undone.",
          detail:
            `sign-in refused for ${profile.email}: org ${claimed.orgId} (${claimed.name}) claims ${domain} and was ` +
            `closed at ${claimed.closedAt}${claimed.closedBy === undefined ? "" : ` by ${claimed.closedBy}`}. ` +
            "Nothing was created: no user row was written and the org is unchanged.",
        });
      }
      const gated = await refuseUninvitedJoin(ctx, claimed, profile.email);
      if (gated !== undefined) return gated;
      await refuseIfOrgIsFull(ctx, claimed, profile.email);
      return { kind: "join", orgId: claimed.orgId };
    }

    const bound = ctx.ssoDomains === undefined ? undefined : await ctx.ssoDomains(domain);
    if (bound !== undefined) {
      const boundOrg = await ctx.orgs.getOrg(bound);
      if (boundOrg !== undefined) {
        if (boundOrg.closedAt !== undefined) {
          throw new VibtraError({
            code: "VALIDATION",
            message:
              `${boundOrg.name} is closed, so ${profile.email} cannot sign in to it. ` +
              "An organisation is closed by one of its owners and closing cannot be undone.",
            detail:
              `sign-in refused for ${profile.email}: org ${boundOrg.orgId} (${boundOrg.name}) has bound ${domain} ` +
              `to its identity provider and was closed at ${boundOrg.closedAt}. Nothing was created.`,
          });
        }
        const gatedBound = await refuseUninvitedJoin(ctx, boundOrg, profile.email);
        if (gatedBound !== undefined) return gatedBound;
        await refuseIfOrgIsFull(ctx, boundOrg, profile.email);
        return { kind: "join", orgId: boundOrg.orgId };
      }
    }

    const create = await refuseSecondOrg(ctx, profile.email, { kind: "create", name: domain, slug: domain, domain });
    return create.kind === "create" ? refuseUnlistedCreate(ctx, profile.email, create) : create;
  });

const freeSlug = async (ctx: ClaimContext, base: string): Promise<string> => {
  if ((await ctx.members.findOrgBySlug(base)) === undefined) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base}-${n}`;
    if ((await ctx.members.findOrgBySlug(candidate)) === undefined) return candidate;
  }
  return `${base}-${randomUUID().slice(0, 8)}`;
};

export const applyOrgPlan = async (
  ctx: ClaimContext,
  plan: Exclude<ClaimPlan, { kind: "none" }>,
  userId: string,
  email = "",
): Promise<ClaimOutcome> => {
  if (plan.kind === "join") {
    if (ctx.beforeJoinWrite !== undefined) await ctx.beforeJoinWrite({ orgId: plan.orgId, email });
    return underLock(ctx, `claim:join:${plan.orgId}`, () =>
      serialized(async () => {
        const org = await ctx.orgs.getOrg(plan.orgId);
        if (org !== undefined) {
          try {
            await refuseIfOrgIsFull(ctx, org, email);
          } catch (e) {
            await ctx.members.deleteUser(userId);
            throw e;
          }
        }
        const role: OrgRole = (await ctx.members.countMembers(plan.orgId)) === 0 ? "owner" : "member";
        await ctx.members.addMember({ orgId: plan.orgId, userId, role });
        return { orgId: plan.orgId, role, createdOrg: false };
      }),
    );
  }

  const create = async (): Promise<ClaimOutcome> => {
    const slug = plan.ownOrg === true ? await freeSlug(ctx, plan.slug) : plan.slug;
    const existing = slug === plan.slug ? await ctx.members.findOrgBySlug(plan.slug) : undefined;
    if (existing !== undefined) {
      await ctx.members.addMember({ orgId: existing.id, userId, role: "member" });
      return { orgId: existing.id, role: "member", createdOrg: false };
    }

    if (ctx.singleOrg !== undefined && (await ctx.singleOrg.orgExists())) {
      await ctx.members.deleteUser(userId);
      throw secondOrgRefusal(email);
    }

    let org;
    try {
      org = await ctx.members.createOrg({ name: plan.name, slug });
    } catch (e) {
      const raced = await ctx.members.findOrgBySlug(slug);
      if (raced === undefined) throw e;
      await ctx.members.addMember({ orgId: raced.id, userId, role: "member" });
      return { orgId: raced.id, role: "member", createdOrg: false };
    }

    const waitlisted = ctx.waitlist === undefined ? false : await ctx.waitlist(plan.domain !== undefined ? { domain: plan.domain } : {}).catch(() => false);
    await ctx.orgs.createOrg({
      orgId: org.id,
      name: plan.name,
      ...(plan.domain !== undefined ? { domain: plan.domain } : {}),
      ...(waitlisted ? { status: "waitlisted" } : {}),
      createdAt: new Date().toISOString(),
    });
    await ctx.members.addMember({ orgId: org.id, userId, role: "owner" });
    return { orgId: org.id, role: "owner", createdOrg: true };
  };
  return ctx.singleOrg === undefined ? serialized(create) : underLock(ctx, "claim:create", () => serialized(create));
};

export const claimOrJoinOrg = async (
  ctx: ClaimContext,
  profile: SignInProfile,
  userId: string,
): Promise<ClaimOutcome | undefined> => {
  const plan = await planOrgForSignIn(ctx, profile);
  return plan.kind === "none" ? undefined : applyOrgPlan(ctx, plan, userId, profile.email);
};
