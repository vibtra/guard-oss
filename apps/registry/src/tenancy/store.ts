import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VibtraError } from "../errors.js";
import { DEFAULT_PLAN_ID, planFor, RETIRED_PLAN_IDS } from "../config.js";
import { deriveOrgHandle, isReservedOrgHandle } from "./handle.js";
import type { MemberDirectory, OrgMemberRow } from "./members.js";

export const ORG_CLOSURE_RETENTION_DAYS = 90;

export const ORG_JOIN_POLICIES = ["domain", "invite"] as const;
export type OrgJoinPolicy = (typeof ORG_JOIN_POLICIES)[number];

export const joinPolicyOf = (value: string | undefined): OrgJoinPolicy =>
  (ORG_JOIN_POLICIES as readonly string[]).includes(value ?? "") ? (value as OrgJoinPolicy) : "domain";

export const BILLING_STATUSES = ["active", "past_due", "unpaid"] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

export const OrgRow = z.object({
  orgId: z.string().min(1),
  name: z.string().min(1),
  handle: z.string().min(1).optional(),
  domain: z.string().min(1).optional(),
  plan: z.string().min(1).default(DEFAULT_PLAN_ID),
  userLimit: z.number().int().min(0).optional(),
  liveToolLimit: z.number().int().min(0).optional(),
  connectionLimit: z.number().int().min(0).optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  joinPolicy: z.string().min(1).default("domain"),
  billingStatus: z.string().min(1).default("active"),
  billingStatusAt: z.string().optional(),
  trialEndsAt: z.string().optional(),
  designPartner: z
    .object({
      until: z.string().min(1),
      discountPct: z.number().int().min(0).max(100),
    })
    .optional(),
  stripeCustomerId: z.string().min(1).optional(),
  stripeSubscriptionId: z.string().min(1).optional(),
  stripeSubscriptionStatus: z.string().min(1).optional(),
  stripePriceId: z.string().min(1).optional(),
  stripeCurrentPeriodEnd: z.string().min(1).optional(),
  stripeCancelAtPeriodEnd: z.boolean().optional(),
  stripeSeats: z.number().int().min(0).optional(),
  stripeStateAt: z.string().min(1).optional(),
  stripeMeteredSubscriptionId: z.string().min(1).optional(),
  status: z.string().min(1).default("active"),
  admittedAt: z.string().optional(),
  createdAt: z.string(),
  closedAt: z.string().optional(),
  closedBy: z.string().optional(),
  purgeAfter: z.string().optional(),
});
export type OrgRow = z.infer<typeof OrgRow>;
export type OrgRowInput = z.input<typeof OrgRow>;

export type StripeBillingPatch = Partial<
  Pick<
    OrgRow,
    | "stripeCustomerId"
    | "stripeSubscriptionId"
    | "stripeSubscriptionStatus"
    | "stripePriceId"
    | "stripeCurrentPeriodEnd"
    | "stripeCancelAtPeriodEnd"
    | "stripeSeats"
    | "stripeStateAt"
    | "stripeMeteredSubscriptionId"
  >
>;

export const STRIPE_BILLING_KEYS = [
  "stripeCustomerId",
  "stripeSubscriptionId",
  "stripeSubscriptionStatus",
  "stripePriceId",
  "stripeCurrentPeriodEnd",
  "stripeCancelAtPeriodEnd",
  "stripeSeats",
  "stripeStateAt",
  "stripeMeteredSubscriptionId",
] as const satisfies readonly (keyof StripeBillingPatch)[];

export const BillingEventRow = z.object({
  eventId: z.string().min(1),
  orgId: z.string().min(1).optional(),
  type: z.string().min(1),
  stripeCreated: z.string().min(1),
  livemode: z.boolean(),
  outcome: z.string().min(1),
  receivedAt: z.string().min(1),
});
export type BillingEventRow = z.infer<typeof BillingEventRow>;

export const OrgTokenRow = z.object({
  tokenId: z.string().min(1),
  orgId: z.string().min(1),
  name: z.string().min(1).max(64),
  tokenHash: z.string().length(64),
  createdBy: z.string().min(1),
  holder: z.string().min(1).optional(),
  createdAt: z.string(),
  revokedAt: z.string().optional(),
  onepasswordItemId: z.string().min(1).optional(),
});
export type OrgTokenRow = z.infer<typeof OrgTokenRow>;

export const OrgHandleAliasRow = z.object({
  handle: z.string().min(1),
  orgId: z.string().min(1),
  retiredAt: z.string(),
});
export type OrgHandleAliasRow = z.infer<typeof OrgHandleAliasRow>;

export interface OrgStore {
  getOrg(orgId: string): Promise<OrgRow | undefined>;
  findOrgByDomain(domain: string): Promise<OrgRow | undefined>;
  findOrgByHandle(handle: string): Promise<OrgRow | undefined>;
  listOrgHandleAliases(orgId: string): Promise<OrgHandleAliasRow[]>;
  createOrg(org: OrgRowInput): Promise<OrgRow>;
  setPlan(orgId: string, plan: string): Promise<void>;
  setOrgName(orgId: string, name: string): Promise<void>;
  setUserLimit(orgId: string, limit: number | undefined): Promise<void>;
  setLiveToolLimit(orgId: string, limit: number | undefined): Promise<void>;
  setConnectionLimit(orgId: string, limit: number | undefined): Promise<void>;
  setBillingStatus(orgId: string, status: BillingStatus, at: string): Promise<void>;
  setStripeBilling(orgId: string, patch: StripeBillingPatch): Promise<void>;
  setOrgStatus(orgId: string, status: "active" | "waitlisted", at: string): Promise<void>;
  listWaitlistedOrgs(): Promise<OrgRow[]>;
  appendBillingEvent(row: BillingEventRow): Promise<"inserted" | "duplicate">;
  hasBillingEvent(eventId: string): Promise<boolean>;
  listBillingEvents(orgId: string): Promise<BillingEventRow[]>;
  setDesignPartner(
    orgId: string,
    designPartner: { until: string; discountPct: number } | undefined,
  ): Promise<void>;
  createToken(token: OrgTokenRow): Promise<void>;
  findTokenByHash(tokenHash: string): Promise<OrgTokenRow | undefined>;
  listTokens(orgId: string): Promise<OrgTokenRow[]>;
  revokeToken(orgId: string, tokenId: string, at: string): Promise<boolean>;

  listOrgs(): Promise<OrgRow[]>;
}

export interface TenancyStore extends OrgStore {
  countUsers(orgId: string): Promise<number>;
  listAdmins(orgId: string): Promise<OrgMemberRow[]>;
  listUsers(orgId: string): Promise<OrgMemberRow[]>;
  lastSeenOf(userId: string): Promise<string | undefined>;
}

export const createTenancyStore = (store: OrgStore, members: MemberDirectory): TenancyStore => ({
  ...store,
  countUsers: (orgId) => members.countMembers(orgId),
  listAdmins: (orgId) => members.listAdmins(orgId),
  listUsers: (orgId) => members.listMembers(orgId),
  lastSeenOf: (userId) => members.lastSeenOf(userId),
});

const TenancyFile = z.object({
  orgs: z.array(OrgRow).default([]),
  tokens: z.array(OrgTokenRow).default([]),
  handleAliases: z.array(OrgHandleAliasRow).default([]),
  billingEvents: z.array(BillingEventRow).default([]),
});

export const createFileOrgStore = async (file: string): Promise<OrgStore> => {
  let orgs: OrgRow[] = [];
  let tokens: OrgTokenRow[] = [];
  let handleAliases: OrgHandleAliasRow[] = [];
  let billingEvents: BillingEventRow[] = [];

  try {
    const parsed = TenancyFile.parse(JSON.parse(await readFile(file, "utf8")));
    orgs = parsed.orgs;
    tokens = parsed.tokens;
    handleAliases = parsed.handleAliases;
    billingEvents = parsed.billingEvents;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ orgs, tokens, handleAliases, billingEvents }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  const handleTaken = (candidate: string, exceptOrgId?: string): boolean => {
    if (isReservedOrgHandle(candidate)) return true;
    if (orgs.some((o) => o.handle === candidate && o.orgId !== exceptOrgId)) return true;
    return handleAliases.some((a) => a.handle === candidate && a.orgId !== exceptOrgId);
  };

  let backfilled = false;
  for (const org of orgs) {
    if (org.handle !== undefined) continue;
    org.handle = await deriveOrgHandle(
      org.domain ?? org.name,
      async (candidate) => handleTaken(candidate, org.orgId),
      org.orgId,
    );
    backfilled = true;
  }

  for (const org of orgs) {
    const moved = RETIRED_PLAN_IDS[org.plan];
    if (moved === undefined) continue;
    org.plan = moved;
    backfilled = true;
  }
  for (const org of orgs) {
    if (org.plan !== "team" || org.stripeSubscriptionId !== undefined) continue;
    org.plan = "free";
    backfilled = true;
  }

  if (backfilled) await persist();

  return {
    async getOrg(orgId) {
      return orgs.find((o) => o.orgId === orgId);
    },
    async findOrgByDomain(domain) {
      return orgs.find((o) => o.domain !== undefined && o.domain === domain);
    },
    async findOrgByHandle(handle) {
      const wanted = handle.trim().toLowerCase();
      if (wanted === "") return undefined;
      const live = orgs.find((o) => o.handle === wanted);
      if (live !== undefined) return live;
      const alias = handleAliases.find((a) => a.handle === wanted);
      return alias === undefined ? undefined : orgs.find((o) => o.orgId === alias.orgId);
    },
    async createOrg(org) {
      const parsed = OrgRow.parse(org);
      if (orgs.some((o) => o.orgId === parsed.orgId)) {
        throw new VibtraError({ code: "VALIDATION", message: "Org id already exists", detail: parsed.orgId });
      }
      if (parsed.domain !== undefined && orgs.some((o) => o.domain === parsed.domain)) {
        throw new VibtraError({ code: "VALIDATION", message: "That domain already has an org", detail: parsed.domain });
      }
      if (parsed.handle !== undefined) {
        if (handleTaken(parsed.handle)) {
          throw new VibtraError({ code: "VALIDATION", message: "That handle is taken", detail: parsed.handle });
        }
      } else {
        parsed.handle = await deriveOrgHandle(parsed.domain ?? parsed.name, async (c) => handleTaken(c), parsed.orgId);
      }
      orgs.push(parsed);
      await persist();
      return parsed;
    },
    async listOrgHandleAliases(orgId) {
      return handleAliases
        .filter((a) => a.orgId === orgId)
        .sort((a, b) => b.retiredAt.localeCompare(a.retiredAt));
    },
    async setPlan(orgId, plan) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      if (planFor(plan).id !== plan) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "No such plan",
          detail: `${JSON.stringify(plan)} is not a bucket in REGISTRY_PLANS (apps/registry/src/config.ts)`,
        });
      }
      org.plan = plan;
      await persist();
    },
    async setOrgName(orgId, name) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      org.name = name;
      await persist();
    },
    async setUserLimit(orgId, limit) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      if (limit === undefined) delete org.userLimit;
      else org.userLimit = limit;
      await persist();
    },
    async setLiveToolLimit(orgId, limit) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      if (limit === undefined) delete org.liveToolLimit;
      else org.liveToolLimit = limit;
      await persist();
    },
    async setConnectionLimit(orgId, limit) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      if (limit === undefined) delete org.connectionLimit;
      else org.connectionLimit = limit;
      await persist();
    },
    async setBillingStatus(orgId, status, at) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      org.billingStatus = status;
      org.billingStatusAt = at;
      await persist();
    },
    async setOrgStatus(orgId, status, at) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      org.status = status;
      if (status === "active") org.admittedAt = at;
      await persist();
    },
    async listWaitlistedOrgs() {
      return orgs.filter((o) => o.status === "waitlisted").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async setStripeBilling(orgId, patch) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      const target = org as Record<string, unknown>;
      for (const key of STRIPE_BILLING_KEYS) {
        if (key in patch && patch[key] !== undefined) target[key] = patch[key];
      }
      await persist();
    },
    async appendBillingEvent(row) {
      const parsed = BillingEventRow.parse(row);
      if (billingEvents.some((e) => e.eventId === parsed.eventId)) return "duplicate";
      billingEvents.push(parsed);
      await persist();
      return "inserted";
    },
    async hasBillingEvent(eventId) {
      return billingEvents.some((e) => e.eventId === eventId);
    },
    async listBillingEvents(orgId) {
      return billingEvents.filter((e) => e.orgId === orgId).reverse();
    },
    async setDesignPartner(orgId, designPartner) {
      const org = orgs.find((o) => o.orgId === orgId);
      if (org === undefined) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
      if (designPartner === undefined) delete org.designPartner;
      else org.designPartner = designPartner;
      await persist();
    },
    async createToken(token) {
      const parsed = OrgTokenRow.parse(token);
      if (tokens.some((t) => t.tokenId === parsed.tokenId || t.tokenHash === parsed.tokenHash)) {
        throw new VibtraError({ code: "VALIDATION", message: "Token already exists", detail: parsed.tokenId });
      }
      tokens.push(parsed);
      await persist();
    },
    async findTokenByHash(tokenHash) {
      return tokens.find((t) => t.tokenHash === tokenHash);
    },
    async listTokens(orgId) {
      return tokens.filter((t) => t.orgId === orgId);
    },
    async revokeToken(orgId, tokenId, at) {
      const token = tokens.find((t) => t.orgId === orgId && t.tokenId === tokenId);
      if (token === undefined || token.revokedAt !== undefined) return false;
      token.revokedAt = at;
      await persist();
      return true;
    },
    async listOrgs() {
      return orgs.map((o) => ({ ...o })).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
  };
};
