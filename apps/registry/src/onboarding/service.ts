import { DEFAULT_CHASE_AFTER_DAYS, type ChaseAfterDays, type OnboardingInviteRow, type OnboardingPage, type OnboardingRow, type OnboardingSettings } from "@vibtra/console-api";
import type { OnboardingFacts, OnboardingStore } from "../tenancy/onboarding.js";
import type { OrgStore } from "../tenancy/store.js";
import { chaseDue, chaseFrom, funnelPosition, type FunnelPosition, type FunnelThresholds } from "./funnel.js";

const laterOf = (a: string, b: string): string => (Date.parse(a) >= Date.parse(b) ? a : b);

const onboardingRows = (facts: OnboardingFacts, now: Date, thresholds: FunnelThresholds): OnboardingRow[] => [
  ...facts.people.map((person): OnboardingRow => ({
    kind: "person",
    userId: person.userId,
    email: person.email,
    ...(person.name === undefined || person.name === "" ? {} : { name: person.name }),
    role: person.role,
    ...(person.lastSentAt === undefined ? {} : { lastSentAt: person.lastSentAt }),
    ...funnelPosition(
      {
        invitedAt: person.invitedAt ?? person.joinedAt,
        ...(person.lastSentAt === undefined ? {} : { lastSentAt: person.lastSentAt }),
        ...(person.firstSignInAt === null ? {} : { signedInAt: laterOf(person.firstSignInAt, person.joinedAt) }),
        devices: person.devices,
      },
      now,
      thresholds,
    ),
  })),
  ...facts.invites.map((invite): OnboardingInviteRow => ({
    kind: "invite",
    invitationId: invite.invitationId,
    email: invite.email,
    role: invite.role,
    stage: "invited",
    stageSince: invite.invitedAt,
    chase: chaseDue("invited", chaseFrom(invite.invitedAt, invite.lastSentAt), now, thresholds.chaseAfterDays),
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
  positions(orgId: string): Promise<ReadonlyMap<string, FunnelPosition>>;
  settings(orgId: string): Promise<OnboardingSettings>;
  setChaseAfterDays(orgId: string, days: ChaseAfterDays): Promise<OnboardingSettings>;
  recordInviteSent(orgId: string, invitationId: string, at: string): Promise<void>;
  recordReminderSent(orgId: string, userId: string, at: string): Promise<void>;
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
    async positions(orgId) {
      const { rows } = await page(orgId);
      return new Map(rows.flatMap((row) => (row.kind === "person" ? [[row.userId, { stage: row.stage, stageSince: row.stageSince, chase: row.chase }] as const] : [])));
    },
    settings,
    async setChaseAfterDays(orgId, days) {
      await options.orgs.setChaseAfterDays(orgId, days);
      return settings(orgId);
    },
    async recordInviteSent(orgId, invitationId, at) {
      await options.store.recordInviteSent({ orgId, invitationId, at });
    },
    async recordReminderSent(orgId, userId, at) {
      await options.store.recordReminderSent({ orgId, userId, at });
    },
  };
};
