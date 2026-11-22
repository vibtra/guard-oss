import { OnboardingStage } from "@vibtra/console-api";
import type { GuardClientMode } from "@vibtra/guard-contract";

const DAY_MS = 86_400_000;

export interface DeviceOnboardingFacts {
  enrolledAt: string;
  lastSyncAt?: string;
  caTrusted: boolean;
  caTrustChangedAt?: string;
  extensionActive: boolean;
  extensionChangedAt?: string;
  integrityFailedAt?: string;
}

export interface PersonOnboardingFacts {
  invitedAt: string;
  lastSentAt?: string;
  signedInAt?: string;
  devices: readonly DeviceOnboardingFacts[];
  protection?: { mode: GuardClientMode; since?: string };
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

const changedSince = (changedAt: string | undefined, enrolledAt: number): number => Math.max(enrolledAt, changedAt === undefined ? 0 : ms(changedAt));

const deviceStage = (device: DeviceOnboardingFacts, now: number, lateAfterMs: number): StageAt => {
  if (device.integrityFailedAt !== undefined) return { stage: "tampered", since: ms(device.integrityFailedAt) };
  const enrolledAt = ms(device.enrolledAt);
  const lastContact = Math.max(enrolledAt, device.lastSyncAt === undefined ? 0 : ms(device.lastSyncAt));
  if (now - lastContact > lateAfterMs) return { stage: "late", since: lastContact + lateAfterMs };
  const trustSince = changedSince(device.caTrustChangedAt, enrolledAt);
  if (!device.caTrusted) return { stage: "enrolled", since: trustSince };
  const extensionSince = changedSince(device.extensionChangedAt, enrolledAt);
  return { stage: device.extensionActive ? "protected" : "certificate_trusted", since: Math.max(trustSince, extensionSince) };
};

const furthest = (a: StageAt, b: StageAt): StageAt => {
  if (rank(a.stage) !== rank(b.stage)) return rank(a.stage) > rank(b.stage) ? a : b;
  return a.since <= b.since ? a : b;
};

const CHASED: ReadonlySet<OnboardingStage> = new Set(["invited", "signed_in"]);

export const chaseFrom = (invitedAt: string, lastSentAt: string | undefined): string =>
  lastSentAt !== undefined && ms(lastSentAt) > ms(invitedAt) ? lastSentAt : invitedAt;

export const chaseDue = (stage: OnboardingStage, since: string, now: Date, chaseAfterDays: number): boolean =>
  CHASED.has(stage) && now.getTime() - ms(since) >= chaseAfterDays * DAY_MS;

export const funnelPosition = (facts: PersonOnboardingFacts, now: Date, thresholds: FunnelThresholds): FunnelPosition => {
  if (facts.protection?.mode === "off") {
    return { stage: "not_in_scope", stageSince: new Date(Math.max(ms(facts.invitedAt), facts.protection.since === undefined ? 0 : ms(facts.protection.since))).toISOString(), chase: false };
  }
  const at = now.getTime();
  const start: StageAt =
    facts.signedInAt === undefined ? { stage: "invited", since: ms(facts.invitedAt) } : { stage: "signed_in", since: ms(facts.signedInAt) };
  const position = facts.devices.map((device) => deviceStage(device, at, thresholds.lateAfterMs)).reduce(furthest, start);
  return {
    stage: position.stage,
    stageSince: new Date(position.since).toISOString(),
    chase: chaseDue(position.stage, chaseFrom(facts.invitedAt, facts.lastSentAt), now, thresholds.chaseAfterDays),
  };
};
