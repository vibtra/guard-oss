import { DEFAULT_CHASE_AFTER_DAYS, type ChaseAfterDays, type OnboardingPage, type OnboardingRow, type OnboardingSettings } from "@vibtra/console-api";
import type { OnboardingStore } from "../tenancy/onboarding.js";
import type { OrgStore } from "../tenancy/store.js";
import { chaseDue, funnelPosition, type FunnelPosition, type FunnelThresholds } from "./funnel.js";

type StoredFacts = Awaited<ReturnType<OnboardingStore["listOnboardingFacts"]>>;

const onboardingRows = (facts: StoredFacts, now: Date, thresholds: FunnelThresholds): OnboardingRow[] => [
  ...facts.people.map((person): OnboardingRow => ({
    kind: "person",
    userId: person.userId,
    email: person.email,
    ...(person.name === undefined || person.name === "" ? {} : { name: person.name }),
    role: person.role,
    ...funnelPosition({ invitedAt: person.invitedAt ?? person.joinedAt, signedInAt: person.joinedAt, devices: person.devices }, now, thresholds),
  })),
  ...facts.invites.map((invite): OnboardingRow => ({
    kind: "invite",
    invitationId: invite.invitationId,
    email: invite.email,
    role: invite.role === "admin" ? "admin" : "member",
    stage: "invited",
    stageSince: invite.invitedAt,
    chase: chaseDue("invited", invite.invitedAt, now, thresholds.chaseAfterDays),
    expiresAt: invite.expiresAt,
    ...(invite.lastSentAt === undefined ? {} : { lastSentAt: invite.lastSentAt }),
  })),
];

export interface OnboardingServiceOptions {
  store: OnboardingStore;
  orgs: Pick<OrgStore, "getOrg" | "setChaseAfterDays">;
  lateAfterMs: (orgId: string) => Promise<number>;
  now: () => Date;
}

export interface OnboardingService {
  page(orgId: string): Promise<OnboardingPage>;
  chaseList(orgId: string): Promise<OnboardingPage>;
  positions(orgId: string): Promise<ReadonlyMap<string, FunnelPosition>>;
  settings(orgId: string): Promise<OnboardingSettings>;
  setChaseAfterDays(orgId: string, days: ChaseAfterDays): Promise<OnboardingSettings>;
  recordInviteSent(orgId: string, invitationId: string): Promise<void>;
}

export const createOnboardingService = (options: OnboardingServiceOptions): OnboardingService => {
  const settings = async (orgId: string): Promise<OnboardingSettings> => ({
    chaseAfterDays: (await options.orgs.getOrg(orgId))?.chaseAfterDays ?? DEFAULT_CHASE_AFTER_DAYS,
  });
  const page = async (orgId: string): Promise<OnboardingPage> => {
    const [facts, { chaseAfterDays }, lateAfterMs] = await Promise.all([options.store.listOnboardingFacts(orgId), settings(orgId), options.lateAfterMs(orgId)]);
    return { rows: onboardingRows(facts, options.now(), { chaseAfterDays, lateAfterMs }), chaseAfterDays };
  };
  return {
    page,
    async chaseList(orgId) {
      const all = await page(orgId);
      return { ...all, rows: all.rows.filter((row) => row.chase) };
    },
    async positions(orgId) {
      const { rows } = await page(orgId);
      return new Map(rows.flatMap((row) => (row.kind === "person" ? [[row.userId, { stage: row.stage, stageSince: row.stageSince, chase: row.chase }] as const] : [])));
    },
    settings,
    async setChaseAfterDays(orgId, days) {
      await options.orgs.setChaseAfterDays(orgId, days);
      return settings(orgId);
    },
    async recordInviteSent(orgId, invitationId) {
      await options.store.recordInviteSent({ orgId, invitationId, at: options.now().toISOString() });
    },
  };
};
