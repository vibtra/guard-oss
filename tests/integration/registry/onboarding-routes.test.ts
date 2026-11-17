import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_LATE_AFTER_MINUTES_DEFAULT } from "@vibtra/guard-contract";
import { OnboardingPage, OnboardingSettingsPage, type OnboardingRow } from "@vibtra/console-api";
import { startRegistry, REGISTRY_ORIGIN, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, preflightBody, type EnrolledDevice } from "./guard-device.ts";
import { manualClock } from "./server-options.ts";

const DAY = 86_400_000;
const LATE_MS = GUARD_LATE_AFTER_MINUTES_DEFAULT * 60_000;

const clock = manualClock(new Date());
let registry: TestRegistry;
let owner: Person;
let member: Person;

beforeAll(async () => {
  registry = await startRegistry({ domain: "onboarding.example", configure: (options) => ({ ...options, clock }) });
  ({ owner, member } = registry.people);
});
afterAll(async () => registry?.close());

const onboardingOf = async (path = "/people/onboarding"): Promise<OnboardingPage> => {
  const answer = await registry.consoleGet(owner, path);
  expect(answer.status, answer.text).toBe(200);
  return OnboardingPage.parse(answer.body);
};

const rowFor = (page: OnboardingPage, email: string): OnboardingRow | undefined => page.rows.find((row) => row.email === email);

const stageOf = async (email: string): Promise<string | undefined> => rowFor(await onboardingOf(), email)?.stage;

describe("admin-only onboarding doors", () => {
  it("refuses a member every onboarding door but reading the settings, and changes nothing", async () => {
    for (const path of ["/people/onboarding", "/people/onboarding/chase"]) {
      const refused = await registry.consoleGet(member, path);
      expect([refused.status, (refused.body as { code?: string }).code], path).toEqual([403, "admin_only"]);
    }
    const put = await registry.consoleWrite(member, "PUT", "/people/onboarding/settings", { chaseAfterDays: 2 });
    expect(put.status).toBe(403);
    const resend = await registry.consoleWrite(member, "POST", "/people/invitations/anything/resend");
    expect(resend.status).toBe(403);
    expect(OnboardingSettingsPage.parse((await registry.consoleGet(member, "/people/onboarding/settings")).body)).toEqual({ chaseAfterDays: 7, mayEdit: false });
    expect(OnboardingSettingsPage.parse((await registry.consoleGet(owner, "/people/onboarding/settings")).body)).toEqual({ chaseAfterDays: 7, mayEdit: true });
  });

  it("gets and sets chaseAfterDays, and refuses a value outside 1 to 365", async () => {
    const saved = await registry.consoleWrite(owner, "PUT", "/people/onboarding/settings", { chaseAfterDays: 3 });
    expect([saved.status, saved.body]).toEqual([200, { chaseAfterDays: 3, mayEdit: true }]);
    for (const bad of [0, 366, 2.5, "7"]) {
      const refused = await registry.consoleWrite(owner, "PUT", "/people/onboarding/settings", { chaseAfterDays: bad });
      expect(refused.status, JSON.stringify(bad)).toBe(400);
    }
    expect((await registry.consoleGet(registry.people.admin, "/people/onboarding/settings")).body).toEqual({ chaseAfterDays: 3, mayEdit: true });
  });

  it("re-issues an expired invitation under a new id and cancels the old one, so the person appears once", async () => {
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "kai@onboarding.example", role: "admin" });
    const oldId = String((invited.body as { invitationId: string }).invitationId);
    const adapter = await registry.server.auth!.adapter();
    await adapter.update({ model: "invitation", where: [{ field: "id", value: oldId }], update: { expiresAt: new Date(Date.now() - 60_000) } });
    const resent = await registry.consoleWrite(owner, "POST", `/people/invitations/${oldId}/resend`);
    expect(resent.status, resent.text).toBe(200);
    const newId = String((resent.body as { invitationId: string }).invitationId);
    expect(newId).not.toBe(oldId);
    expect(resent.body).toMatchObject({ email: "kai@onboarding.example", role: "admin" });
    expect(Date.parse(String((resent.body as { expiresAt: string }).expiresAt))).toBeGreaterThan(Date.now());
    const kai = (await onboardingOf()).rows.filter((row) => row.email === "kai@onboarding.example");
    expect(kai).toEqual([expect.objectContaining({ kind: "invite", invitationId: newId, lastSentAt: clock.now().toISOString() })]);
    const cancel = await registry.consoleWrite(owner, "DELETE", `/people/invitations/${newId}`);
    expect(cancel.status).toBe(204);
  });

  it("never hands a member an invitation id that could be used to join", async () => {
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "noor@onboarding.example", role: "admin" });
    const invitationId = String((invited.body as { invitationId: string }).invitationId);
    const answers = [
      await registry.consoleGet(member, "/people"),
      await registry.consoleGet(member, "/people/onboarding"),
      await registry.consoleGet(member, "/people/onboarding/chase"),
      await registry.consoleGet(member, "/people/onboarding/settings"),
      await registry.consoleWrite(member, "POST", `/people/invitations/${invitationId}/resend`),
    ];
    for (const answer of answers) expect(answer.text).not.toContain(invitationId);
    for (const door of ["list-invitations", `get-invitation?id=${invitationId}`]) {
      const direct = await fetch(`${registry.url}/api/auth/organization/${door}`, { headers: { cookie: member.cookie, origin: REGISTRY_ORIGIN } });
      expect(direct.status, door).toBe(404);
      expect(await direct.text()).not.toContain(invitationId);
    }
    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${invitationId}`)).status).toBe(204);
  });

  it("answers 404 when re-sending an invitation that is not pending here", async () => {
    const missing = await registry.consoleWrite(owner, "POST", "/people/invitations/not-an-invitation/resend");
    expect(missing.status).toBe(404);
  });
});

describe("one person from Invited to Protected, then Late", () => {
  const email = "lee@onboarding.example";
  let invitationId: string;
  let lee: Person;
  let mac: EnrolledDevice;

  it("is Invited once the invitation is made, with its send time recorded", async () => {
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email, role: "member" });
    expect(invited.status, invited.text).toBe(200);
    invitationId = String((invited.body as { invitationId: string }).invitationId);
    const row = rowFor(await onboardingOf(), email);
    expect(row).toMatchObject({ kind: "invite", invitationId, stage: "invited", chase: false, lastSentAt: clock.now().toISOString() });
    expect((await onboardingOf("/people/onboarding/chase")).rows.map((r) => r.email)).not.toContain(email);
  });

  it("joins the chase list after chaseAfterDays, and a re-send records the new send time and restarts the count", async () => {
    clock.advance(3 * DAY + 60_000);
    expect((await onboardingOf("/people/onboarding/chase")).rows.find((r) => r.email === email)).toMatchObject({ kind: "invite", chase: true });
    const resent = await registry.consoleWrite(owner, "POST", `/people/invitations/${invitationId}/resend`);
    expect(resent.status, resent.text).toBe(200);
    expect(resent.body).toMatchObject({ invitationId, email, role: "member", delivery: "mail_off", emailed: false, inviteUrl: `${REGISTRY_ORIGIN}/login?invitation=${encodeURIComponent(invitationId)}` });
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ lastSentAt: clock.now().toISOString(), chase: false });
    clock.advance(3 * DAY);
    expect(rowFor(await onboardingOf("/people/onboarding/chase"), email)).toMatchObject({ kind: "invite", chase: true });
  });

  it("is Signed in once they accept, and stays on the chase list until a Mac enrols", async () => {
    lee = await registry.join("lee", "onboarding.example");
    const accepted = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { cookie: lee.cookie, origin: REGISTRY_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ invitationId }),
    });
    expect(accepted.status, await accepted.text()).toBe(200);
    const row = rowFor(await onboardingOf(), email);
    expect(row).toMatchObject({ kind: "person", userId: lee.userId, stage: "signed_in", chase: true });
    const people = (await registry.consoleGet(owner, "/people")).body as { rows: Array<{ subject: string; stage?: string }> };
    expect(people.rows.find((r) => r.subject === lee.userId)).toMatchObject({ stage: "signed_in", chase: true });
    const asMember = (await registry.consoleGet(member, "/people")).body as { rows: Array<{ subject: string; stage?: string }> };
    expect(asMember.rows.find((r) => r.subject === lee.userId)?.stage).toBeUndefined();
  });

  it("is Enrolled once the Mac enrols, and leaves the chase list", async () => {
    mac = await enrolDevice(registry, owner, lee, "lee-mbp");
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "enrolled", stageSince: clock.now().toISOString(), chase: false });
    expect((await onboardingOf("/people/onboarding/chase")).rows.map((r) => r.email)).not.toContain(email);
  });

  it("is Certificate trusted, then Protected, as the Mac reports them", async () => {
    clock.advance(60_000);
    const trusted = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: false } }));
    expect(trusted.status, trusted.text).toBe(200);
    expect(await stageOf(email)).toBe("certificate_trusted");

    clock.advance(60_000);
    const approved = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: true } }));
    expect(approved.status, approved.text).toBe(200);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "protected", stageSince: clock.now().toISOString(), chase: false });
  });

  it("steps back to Certificate trusted when the extension is turned off, dated from that report, and forward again", async () => {
    clock.advance(60_000);
    const off = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: false } }));
    expect(off.status, off.text).toBe(200);
    const offAt = clock.now().toISOString();
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "certificate_trusted", stageSince: offAt });
    clock.advance(60_000);
    const sameAgain = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: false } }));
    expect(sameAgain.status).toBe(200);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "certificate_trusted", stageSince: offAt });
    clock.advance(60_000);
    const on = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: true } }));
    expect(on.status).toBe(200);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "protected", stageSince: clock.now().toISOString() });
  });

  it("is Tampered while the Mac's integrity check fails, and Protected again once a later check passes", async () => {
    const orgId = String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId);
    const devices = registry.server.service.guard!;
    clock.advance(60_000);
    const failedAt = clock.now().toISOString();
    await devices.updateDevice(orgId, mac.deviceId, { integrity: { kind: "failed", at: failedAt } });
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "tampered", stageSince: failedAt });
    clock.advance(60_000);
    await devices.updateDevice(orgId, mac.deviceId, { integrity: { kind: "passed", at: clock.now().toISOString() } });
    expect(await stageOf(email)).toBe("protected");
    const synced = await agentDoor(registry, "POST", `/preflight/${mac.deviceId}`, mac.token, preflightBody("lee-mbp", { health: { caTrusted: true, extensionActive: true } }));
    expect(synced.status).toBe(200);
  });

  it("is Late once the Mac stops syncing for longer than the org's Late threshold", async () => {
    const lastSync = clock.now().getTime();
    clock.advance(LATE_MS);
    expect(await stageOf(email)).toBe("protected");
    clock.advance(60_000);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "late", stageSince: new Date(lastSync + LATE_MS).toISOString(), chase: false });
  });
});
