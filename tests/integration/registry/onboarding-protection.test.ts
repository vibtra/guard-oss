import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OnboardingPage, type OnboardingRow } from "@vibtra/console-api";
import { GuardProtectionPage, type GuardClientMode } from "@vibtra/guard-contract";
import { funnelPosition } from "@vibtra/registry/src/onboarding/funnel.ts";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, preflightBody, type EnrolledDevice } from "./guard-device.ts";
import { manualClock } from "./server-options.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe("funnelPosition for a person whose protection is off", () => {
  const T0 = Date.parse("2026-11-01T09:00:00.000Z");
  const at = (offsetMs: number): string => new Date(T0 + offsetMs).toISOString();
  const thresholds = { lateAfterMs: 2 * HOUR, chaseAfterDays: 7 };
  const protectedMac = { enrolledAt: at(2 * HOUR), lastSyncAt: at(40 * DAY), caTrusted: true, extensionActive: true, extensionChangedAt: at(3 * HOUR) };
  const facts = (protection?: { mode: GuardClientMode; since?: string }) => ({ invitedAt: at(0), signedInAt: at(HOUR), devices: [protectedMac], ...(protection === undefined ? {} : { protection }) });

  it("is Not in scope from when Guard went off for them, never before they joined, and never chased", () => {
    const now = new Date(T0 + 40 * DAY);
    expect(funnelPosition(facts({ mode: "off", since: at(5 * DAY) }), now, thresholds)).toEqual({ stage: "not_in_scope", stageSince: at(5 * DAY), chase: false });
    expect(funnelPosition(facts({ mode: "off", since: at(-30 * DAY) }), now, thresholds)).toEqual({ stage: "not_in_scope", stageSince: at(0), chase: false });
    expect(funnelPosition({ invitedAt: at(0), devices: [], protection: { mode: "off" } }, now, thresholds)).toEqual({ stage: "not_in_scope", stageSince: at(0), chase: false });
    expect(funnelPosition({ invitedAt: at(0), devices: [], protection: { mode: "monitor" } }, now, thresholds)).toMatchObject({ stage: "invited", chase: true });
  });

  it("is Protected only with a mode other than Off and the extension active", () => {
    const now = new Date(T0 + 40 * DAY);
    for (const mode of ["monitor", "enforce"] as const) expect(funnelPosition(facts({ mode }), now, thresholds).stage, mode).toBe("protected");
    expect(funnelPosition(facts({ mode: "off" }), now, thresholds).stage).toBe("not_in_scope");
    expect(funnelPosition({ ...facts({ mode: "enforce" }), devices: [{ ...protectedMac, extensionActive: false }] }, now, thresholds).stage).toBe("certificate_trusted");
  });
});

describe("the onboarding funnel follows each person's protection", () => {
  const clock = manualClock(new Date());
  let registry: TestRegistry;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let mac: EnrolledDevice;

  const rowOf = async (who: Person): Promise<OnboardingRow | undefined> => {
    const reply = await registry.consoleGet(owner, "/people/onboarding");
    expect(reply.status, reply.text).toBe(200);
    return OnboardingPage.parse(reply.body).rows.find((row) => row.email === who.email);
  };
  const peopleStage = async (who: Person) => ((await registry.consoleGet(owner, "/people")).body as { rows: Array<{ subject: string; stage?: string; chase?: boolean }> }).rows.find((row) => row.subject === who.userId);
  const apply = async (changes: unknown[]) => {
    const { revision } = GuardProtectionPage.parse((await registry.consoleGet(owner, "/people/protection")).body);
    const reply = await registry.consoleWrite(owner, "POST", "/people/protection/apply", { changes, revision });
    expect(reply.status, reply.text).toBe(200);
  };

  const macReportsProtected = async () => {
    const reported = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("admin-mbp", { health: { caTrusted: true, extensionActive: true } }));
    expect(reported.status, reported.text).toBe(200);
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "onboarding-protection.example", configure: (options) => ({ ...options, clock }) });
    ({ owner, admin, member } = registry.people);
    mac = await enrolDevice(registry, owner, admin, "admin-mbp");
    clock.advance(60_000);
    await macReportsProtected();
  });

  afterAll(async () => registry?.close());

  it("puts a person set to Off out of scope and off the chase list, and back on it when they are set back", async () => {
    clock.advance(8 * DAY);
    expect(await rowOf(member)).toMatchObject({ stage: "signed_in", chase: true });

    await apply([{ userIds: [member.userId], mode: "off" }]);
    const offAt = clock.now().toISOString();
    expect(await rowOf(member)).toMatchObject({ stage: "not_in_scope", stageSince: offAt, chase: false });
    expect(await peopleStage(member)).toMatchObject({ stage: "not_in_scope", chase: false });
    const remind = await registry.consoleWrite(owner, "POST", `/people/${member.userId}/onboarding/remind`);
    expect(remind.status, remind.text).toBe(409);
    clock.advance(30 * DAY);
    expect(await rowOf(member)).toMatchObject({ stage: "not_in_scope", stageSince: offAt, chase: false });

    await apply([{ userIds: [member.userId], mode: "monitor" }]);
    expect(await rowOf(member)).toMatchObject({ stage: "signed_in", chase: true });
  });

  it("counts a Mac as Protected only while the person's mode is not Off, whether Off is their own or the default", async () => {
    await macReportsProtected();
    const protectedRow = await rowOf(admin);
    expect(protectedRow).toMatchObject({ stage: "protected", chase: false });

    await apply([{ userIds: [admin.userId], mode: "off" }]);
    expect(await rowOf(admin)).toMatchObject({ stage: "not_in_scope", stageSince: clock.now().toISOString() });
    await apply([{ userIds: [admin.userId], mode: "enforce" }]);
    expect(await rowOf(admin)).toEqual(protectedRow);

    clock.advance(60_000);
    await apply([{ userIds: [admin.userId], clear: true }, { default: "off" }]);
    const defaultOffAt = clock.now().toISOString();
    for (const who of [owner, admin]) expect(await rowOf(who), who.email).toMatchObject({ stage: "not_in_scope", stageSince: defaultOffAt, chase: false });
    await apply([{ default: "monitor" }]);
    expect(await rowOf(admin)).toEqual(protectedRow);
    expect((await rowOf(owner))?.stage).toBe("signed_in");
  });
});
