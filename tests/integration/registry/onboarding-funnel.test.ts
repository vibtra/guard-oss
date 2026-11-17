import { describe, expect, it } from "vitest";
import { chaseDue, funnelPosition, type DeviceOnboardingFacts, type PersonOnboardingFacts } from "@vibtra/registry/src/onboarding/funnel.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const T0 = Date.parse("2026-11-01T09:00:00.000Z");
const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
const thresholds = { lateAfterMs: 2 * HOUR, chaseAfterDays: 7 };

const invited: PersonOnboardingFacts = { invitedAt: at(0), devices: [] };
const signedIn: PersonOnboardingFacts = { ...invited, signedInAt: at(HOUR) };
const device = (patch: Partial<DeviceOnboardingFacts> = {}): DeviceOnboardingFacts => ({ enrolledAt: at(2 * HOUR), lastSyncAt: at(2 * HOUR), caTrusted: false, extensionActive: false, ...patch });
const withDevices = (...devices: DeviceOnboardingFacts[]): PersonOnboardingFacts => ({ ...signedIn, devices });
const protectedMac = device({ caTrusted: true, extensionActive: true, caTrustChangedAt: at(3 * HOUR), extensionChangedAt: at(4 * HOUR), lastSyncAt: at(4 * HOUR) });

describe("funnelPosition walks one person through the funnel", () => {
  it("is invited from the invitation until first sign-in", () => {
    expect(funnelPosition(invited, new Date(T0 + 10 * 60_000), thresholds)).toEqual({ stage: "invited", stageSince: at(0), chase: false });
  });

  it("is signed in from the first sign-in", () => {
    expect(funnelPosition(signedIn, new Date(T0 + 2 * HOUR), thresholds)).toEqual({ stage: "signed_in", stageSince: at(HOUR), chase: false });
  });

  it("is enrolled once a Mac enrols, before the certificate is trusted", () => {
    expect(funnelPosition(withDevices(device()), new Date(T0 + 2 * HOUR + 60_000), thresholds)).toMatchObject({ stage: "enrolled", stageSince: at(2 * HOUR) });
  });

  it("is certificate trusted once trust is reported, until the extension is approved", () => {
    const mac = device({ caTrusted: true, caTrustChangedAt: at(3 * HOUR), lastSyncAt: at(3 * HOUR) });
    expect(funnelPosition(withDevices(mac), new Date(T0 + 3 * HOUR + 60_000), thresholds)).toMatchObject({ stage: "certificate_trusted", stageSince: at(3 * HOUR) });
  });

  it("is protected from whichever of trust and approval came last", () => {
    expect(funnelPosition(withDevices(protectedMac), new Date(T0 + 4 * HOUR + 60_000), thresholds)).toMatchObject({ stage: "protected", stageSince: at(4 * HOUR) });
  });

  it("is late once the last sync is older than the Late threshold, and says when it became late", () => {
    const now = new Date(T0 + 4 * HOUR + thresholds.lateAfterMs + 1);
    expect(funnelPosition(withDevices(protectedMac), now, thresholds)).toMatchObject({ stage: "late", stageSince: at(4 * HOUR + thresholds.lateAfterMs) });
  });

  it("is not late at exactly the threshold", () => {
    expect(funnelPosition(withDevices(protectedMac), new Date(T0 + 4 * HOUR + thresholds.lateAfterMs), thresholds).stage).toBe("protected");
  });

  it("reads the threshold it is given rather than a built-in one", () => {
    const now = new Date(T0 + 4 * HOUR + 30 * 60_000);
    expect(funnelPosition(withDevices(protectedMac), now, { ...thresholds, lateAfterMs: 20 * 60_000 }).stage).toBe("late");
    expect(funnelPosition(withDevices(protectedMac), now, { ...thresholds, lateAfterMs: 40 * 60_000 }).stage).toBe("protected");
  });

  it("counts a Mac that enrolled and never synced as late from its enrolment", () => {
    const mac: DeviceOnboardingFacts = { enrolledAt: at(2 * HOUR), caTrusted: false, extensionActive: false };
    expect(funnelPosition(withDevices(mac), new Date(T0 + 2 * HOUR + thresholds.lateAfterMs + 1), thresholds)).toMatchObject({ stage: "late", stageSince: at(2 * HOUR + thresholds.lateAfterMs) });
  });

  it("follows the Mac's current trust and approval, and dates a step back from when it happened", () => {
    const now = new Date(T0 + 6 * HOUR);
    const synced = { lastSyncAt: at(6 * HOUR - 60_000) };
    const extensionOff = { ...protectedMac, ...synced, extensionActive: false, extensionChangedAt: at(5 * HOUR) };
    expect(funnelPosition(withDevices(extensionOff), now, thresholds)).toMatchObject({ stage: "certificate_trusted", stageSince: at(5 * HOUR) });
    const trustLost = { ...protectedMac, ...synced, caTrusted: false, caTrustChangedAt: at(5 * HOUR + 30 * 60_000) };
    expect(funnelPosition(withDevices(trustLost), now, thresholds)).toMatchObject({ stage: "enrolled", stageSince: at(5 * HOUR + 30 * 60_000) });
  });

  it("dates a state no change was ever reported for from the enrolment", () => {
    const mac = device({ caTrusted: true, extensionActive: true, lastSyncAt: at(2 * HOUR + 60_000) });
    expect(funnelPosition(withDevices(mac), new Date(T0 + 2 * HOUR + 2 * 60_000), thresholds)).toMatchObject({ stage: "protected", stageSince: at(2 * HOUR) });
  });

  it("is tampered from a failed integrity check, even while syncing", () => {
    const mac = { ...protectedMac, lastSyncAt: at(5 * HOUR), integrityFailedAt: at(5 * HOUR) };
    expect(funnelPosition(withDevices(mac), new Date(T0 + 5 * HOUR + 60_000), thresholds)).toMatchObject({ stage: "tampered", stageSince: at(5 * HOUR) });
  });
});

describe("funnelPosition ranks Tampered over Late over Protected", () => {
  const now = new Date(T0 + DAY);
  const fresh = { ...protectedMac, lastSyncAt: at(DAY - 60_000) };
  const stale = protectedMac;
  const tampered = { ...stale, integrityFailedAt: at(5 * HOUR) };

  it("Tampered outranks Late on the same Mac", () => {
    expect(funnelPosition(withDevices(tampered), now, thresholds).stage).toBe("tampered");
  });

  it("Late outranks Protected across a person's Macs", () => {
    expect(funnelPosition(withDevices(fresh, stale), now, thresholds).stage).toBe("late");
    expect(funnelPosition(withDevices(stale, fresh), now, thresholds).stage).toBe("late");
  });

  it("Tampered outranks Late and Protected across a person's Macs", () => {
    expect(funnelPosition(withDevices(fresh, stale, tampered), now, thresholds).stage).toBe("tampered");
  });

  it("takes the furthest progress across Macs that are all still syncing", () => {
    const enrolledOnly = device({ enrolledAt: at(DAY - 2 * 60_000), lastSyncAt: at(DAY - 60_000) });
    expect(funnelPosition(withDevices(enrolledOnly, fresh), now, thresholds).stage).toBe("protected");
  });

  it("dates a shared stage from the Mac that reached it first", () => {
    const first = { ...fresh, caTrustChangedAt: at(3 * HOUR), extensionChangedAt: at(4 * HOUR) };
    const second = { ...fresh, caTrustChangedAt: at(6 * HOUR), extensionChangedAt: at(7 * HOUR) };
    expect(funnelPosition(withDevices(second, first), now, thresholds).stageSince).toBe(at(4 * HOUR));
  });
});

describe("the chase flag", () => {
  it("counts from the latest send, not the first invitation", () => {
    const reminded: PersonOnboardingFacts = { ...signedIn, lastSentAt: at(5 * DAY) };
    expect(funnelPosition(reminded, new Date(T0 + 12 * DAY - 1), thresholds).chase).toBe(false);
    expect(funnelPosition(reminded, new Date(T0 + 12 * DAY), thresholds).chase).toBe(true);
    expect(funnelPosition({ ...invited, lastSentAt: at(-DAY) }, new Date(T0 + 7 * DAY), thresholds).chase).toBe(true);
  });

  it("is set for an invited or signed-in person once chaseAfterDays have passed since the invitation", () => {
    expect(funnelPosition(invited, new Date(T0 + 7 * DAY - 1), thresholds).chase).toBe(false);
    expect(funnelPosition(invited, new Date(T0 + 7 * DAY), thresholds).chase).toBe(true);
    expect(funnelPosition(signedIn, new Date(T0 + 8 * DAY), thresholds).chase).toBe(true);
  });

  it("follows the org's chaseAfterDays", () => {
    expect(funnelPosition(invited, new Date(T0 + 3 * DAY), { ...thresholds, chaseAfterDays: 3 }).chase).toBe(true);
    expect(funnelPosition(invited, new Date(T0 + 3 * DAY), { ...thresholds, chaseAfterDays: 4 }).chase).toBe(false);
  });

  it("is never set once a Mac has enrolled, whatever happens to it later", () => {
    const now = new Date(T0 + 30 * DAY);
    for (const mac of [device(), protectedMac, { ...protectedMac, integrityFailedAt: at(5 * HOUR) }]) {
      expect(funnelPosition(withDevices(mac), now, thresholds).chase).toBe(false);
    }
    expect(chaseDue("enrolled", at(0), now, 7)).toBe(false);
  });
});
