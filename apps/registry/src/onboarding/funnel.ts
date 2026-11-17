import { ONBOARDING_STAGES, type OnboardingStage } from "@vibtra/console-api";

const DAY_MS = 86_400_000;

export interface DeviceOnboardingFacts {
  enrolledAt: string;
  certificateTrustedAt: string | undefined;
  extensionApprovedAt: string | undefined;
  lastSyncAt: string | undefined;
  integrityFailedAt: string | undefined;
}

export interface PersonOnboardingFacts {
  invitedAt: string;
  signedInAt: string | undefined;
  devices: readonly DeviceOnboardingFacts[];
}

export interface FunnelThresholds {
  lateAfterMs: number;
  chaseAfterDays: number;
}

export interface FunnelPosition {
  stage: OnboardingStage;
  stageSince: string;
  chase: boolean;
}

interface StageAt {
  stage: OnboardingStage;
  since: number;
}

const rank = (stage: OnboardingStage): number => ONBOARDING_STAGES.indexOf(stage);

const ms = (iso: string): number => new Date(iso).getTime();

const later = (a: string, b: string): number => Math.max(ms(a), ms(b));

const deviceStage = (device: DeviceOnboardingFacts, now: number, lateAfterMs: number): StageAt => {
  if (device.integrityFailedAt !== undefined) return { stage: "tampered", since: ms(device.integrityFailedAt) };
  const lastContact = device.lastSyncAt === undefined ? ms(device.enrolledAt) : later(device.lastSyncAt, device.enrolledAt);
  if (now - lastContact > lateAfterMs) return { stage: "late", since: lastContact + lateAfterMs };
  if (device.certificateTrustedAt === undefined) return { stage: "enrolled", since: ms(device.enrolledAt) };
  if (device.extensionApprovedAt === undefined) return { stage: "certificate_trusted", since: ms(device.certificateTrustedAt) };
  return { stage: "protected", since: later(device.certificateTrustedAt, device.extensionApprovedAt) };
};

const furthest = (a: StageAt, b: StageAt): StageAt => {
  if (rank(a.stage) !== rank(b.stage)) return rank(a.stage) > rank(b.stage) ? a : b;
  return a.since <= b.since ? a : b;
};

const CHASED: ReadonlySet<OnboardingStage> = new Set(["invited", "signed_in"]);

export const chaseDue = (stage: OnboardingStage, invitedAt: string, now: Date, chaseAfterDays: number): boolean =>
  CHASED.has(stage) && now.getTime() - ms(invitedAt) >= chaseAfterDays * DAY_MS;

export const funnelPosition = (facts: PersonOnboardingFacts, now: Date, thresholds: FunnelThresholds): FunnelPosition => {
  const at = now.getTime();
  const start: StageAt =
    facts.signedInAt === undefined ? { stage: "invited", since: ms(facts.invitedAt) } : { stage: "signed_in", since: ms(facts.signedInAt) };
  const position = facts.devices.map((device) => deviceStage(device, at, thresholds.lateAfterMs)).reduce(furthest, start);
  return {
    stage: position.stage,
    stageSince: new Date(position.since).toISOString(),
    chase: chaseDue(position.stage, facts.invitedAt, now, thresholds.chaseAfterDays),
  };
};
