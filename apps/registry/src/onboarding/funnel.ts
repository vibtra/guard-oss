import { OnboardingStage } from "@vibtra/console-api";
import type { OnboardingStore } from "../tenancy/onboarding.js";

const DAY_MS = 86_400_000;

type StoredFacts = Awaited<ReturnType<OnboardingStore["listOnboardingFacts"]>>;

export type DeviceOnboardingFacts = Omit<StoredFacts["people"][number]["devices"][number], "deviceId">;

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

const rank = (stage: OnboardingStage): number => OnboardingStage.options.indexOf(stage);

const ms = (iso: string): number => new Date(iso).getTime();

const reportedSince = (firstReport: string | undefined, enrolledAt: string): number => ms(firstReport ?? enrolledAt);

const deviceStage = (device: DeviceOnboardingFacts, now: number, lateAfterMs: number): StageAt => {
  if (device.integrityFailedAt !== undefined) return { stage: "tampered", since: ms(device.integrityFailedAt) };
  const lastContact = Math.max(ms(device.enrolledAt), device.lastSyncAt === undefined ? 0 : ms(device.lastSyncAt));
  if (now - lastContact > lateAfterMs) return { stage: "late", since: lastContact + lateAfterMs };
  if (!device.caTrusted) return { stage: "enrolled", since: ms(device.enrolledAt) };
  const trustedSince = reportedSince(device.caTrustedAt, device.enrolledAt);
  if (!device.extensionActive) return { stage: "certificate_trusted", since: trustedSince };
  return { stage: "protected", since: Math.max(trustedSince, reportedSince(device.extensionApprovedAt, device.enrolledAt)) };
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
