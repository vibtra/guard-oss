import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_LATE_AFTER_MINUTES_DEFAULT } from "@vibtra/guard-contract";
import { CONSOLE_API_PREFIX, OnboardingPage, OnboardingSettingsPage, type OnboardingRow } from "@vibtra/console-api";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
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

const onboardingOf = async (): Promise<OnboardingPage> => {
  const answer = await registry.consoleGet(owner, "/people/onboarding");
  expect(answer.status, answer.text).toBe(200);
  return OnboardingPage.parse(answer.body);
};

const rowFor = (page: OnboardingPage, email: string): OnboardingRow | undefined => page.rows.find((row) => row.email === email);

const chased = async (): Promise<string[]> => (await onboardingOf()).rows.filter((row) => row.chase).map((row) => row.email);

const stageOf = async (email: string): Promise<string | undefined> => rowFor(await onboardingOf(), email)?.stage;

const ownOrgId = async (): Promise<string> => String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId);

const rolesInOrg = async (orgId: string, userId: string): Promise<string[]> =>
  (await (await registry.server.auth!.adapter()).findMany<{ role: string }>({ model: "member", where: [{ field: "userId", value: userId }, { field: "organizationId", value: orgId }] })).map(
    (row) => row.role,
  );

const passwordOf = (email: string): string => `vibtra-test-passphrase-${email}`;

const sessionCookie = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";

const authPost = (path: string, body: unknown, cookie?: string): Promise<Response> =>
  fetch(`${registry.url}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, ...(cookie === undefined ? {} : { cookie }) },
    body: JSON.stringify(body),
  });

const consoleSessionOf = async (cookie: string): Promise<{ status: number; orgId?: string; role?: string }> => {
  const answer = await fetch(`${registry.url}${CONSOLE_API_PREFIX}/session`, { headers: { cookie } });
  return answer.status === 200 ? { status: 200, ...((await answer.json()) as { orgId: string; role: string }) } : { status: answer.status };
};

const signUpInvited = async (name: string, role: "member" | "admin" = "admin"): Promise<{ email: string; userId: string; cookie: string; invitationId: string }> => {
  const email = `${name}@onboarding.example`;
  const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email, role });
  expect(invited.status, invited.text).toBe(200);
  const signedUp = await authPost("sign-up/email", { email, password: passwordOf(email), name });
  expect(signedUp.status, await signedUp.clone().text()).toBe(200);
  const userId = String(((await signedUp.json()) as { user: { id: string } }).user.id);
  return { email, userId, cookie: sessionCookie(signedUp), invitationId: String((invited.body as { invitationId: string }).invitationId) };
};

const signIn = async (email: string): Promise<string> => {
  const signedIn = await authPost("sign-in/email", { email, password: passwordOf(email) });
  expect(signedIn.status, await signedIn.clone().text()).toBe(200);
  return sessionCookie(signedIn);
};

describe("admin-only onboarding doors", () => {
  it("refuses a member every onboarding door but reading the settings, and changes nothing", async () => {
    const refused = await registry.consoleGet(member, "/people/onboarding");
    expect([refused.status, (refused.body as { code?: string }).code]).toEqual([403, "admin_only"]);
    const put = await registry.consoleWrite(member, "PUT", "/people/onboarding/settings", { chaseAfterDays: 2 });
    expect(put.status).toBe(403);
    const resend = await registry.consoleWrite(member, "POST", "/people/invitations/anything/resend");
    expect(resend.status).toBe(403);
    const remind = await registry.consoleWrite(member, "POST", `/people/${member.userId}/onboarding/remind`);
    expect(remind.status).toBe(403);
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

  it("answers 404 when re-sending an invitation that is not pending here, or reminding somebody who is not a member", async () => {
    const missing = await registry.consoleWrite(owner, "POST", "/people/invitations/not-an-invitation/resend");
    expect(missing.status).toBe(404);
    const nobody = await registry.consoleWrite(owner, "POST", "/people/usr_nobody/onboarding/remind");
    expect(nobody.status).toBe(404);
  });

  it("refuses a reminder with 409 to a member who was added but has never signed in, and sends nothing", async () => {
    const adapter = await registry.server.auth!.adapter();
    const orgId = String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId);
    const email = "rae@onboarding.example";
    const rae = await adapter.create<{ id: string }>({
      model: "user",
      data: { name: "rae", email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    });
    await adapter.create({ model: "member", data: { organizationId: orgId, userId: rae.id, role: "member", createdAt: new Date() } });
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ kind: "person", userId: rae.id, stage: "invited" });
    const refused = await registry.consoleWrite(owner, "POST", `/people/${rae.id}/onboarding/remind`);
    expect([refused.status, refused.text]).toEqual([409, expect.stringContaining("is invited. Nothing was sent")]);
    expect(rowFor(await onboardingOf(), email)?.lastSentAt).toBeUndefined();
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${rae.id}`)).status).toBe(200);
  });

  it("admits an invited person through their invitation, with its role and one membership, and still auto-joins one whose invitation expired", async () => {
    const adapter = await registry.server.auth!.adapter();
    const orgId = String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId);
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "ira@onboarding.example", role: "admin" });
    const ira = await registry.join("ira", "onboarding.example", String((invited.body as { invitationId: string }).invitationId));
    const memberships = await adapter.findMany<{ role: string }>({ model: "member", where: [{ field: "userId", value: ira.userId }, { field: "organizationId", value: orgId }] });
    expect(memberships.map((row) => row.role)).toEqual(["admin"]);

    const lapsed = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "eve@onboarding.example", role: "admin" });
    const lapsedId = String((lapsed.body as { invitationId: string }).invitationId);
    await adapter.update({ model: "invitation", where: [{ field: "id", value: lapsedId }], update: { expiresAt: new Date(Date.now() - 60_000) } });
    const eve = await registry.join("eve", "onboarding.example");
    const joined = await adapter.findMany<{ role: string }>({ model: "member", where: [{ field: "userId", value: eve.userId }, { field: "organizationId", value: orgId }] });
    expect(joined.map((row) => row.role)).toEqual(["member"]);

    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${lapsedId}`)).status).toBe(204);
    for (const person of [ira, eve]) expect((await registry.consoleWrite(owner, "DELETE", `/people/${person.userId}`)).status).toBe(200);
  });

  it("auto-joins a domain's open organisation despite an invitation to another one, joins a deferred person on the next sign-in once their invitation is revoked or lapses, and never re-joins a removed person", async () => {
    const adapter = await registry.server.auth!.adapter();
    const orgId = await ownOrgId();
    const rolesIn = (userId: string): Promise<string[]> => rolesInOrg(orgId, userId);

    const otherOwner = await registry.join("bo", "onboarding-b.example");
    const elsewhere = await registry.consoleWrite(otherOwner, "POST", "/people/invitations", { email: "zed@onboarding.example", role: "member" });
    expect(elsewhere.status, elsewhere.text).toBe(200);
    const zed = await registry.join("zed", "onboarding.example");
    expect(await rolesIn(zed.userId)).toEqual(["member"]);
    expect((await registry.consoleWrite(otherOwner, "DELETE", `/people/invitations/${String((elsewhere.body as { invitationId: string }).invitationId)}`)).status).toBe(204);
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${zed.userId}`)).status).toBe(200);
    expect((await consoleSessionOf(await signIn(zed.email))).status).toBe(401);
    expect(await rolesIn(zed.userId)).toEqual([]);

    for (const [name, endInvitation] of [
      ["kim", async (id: string) => expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${id}`)).status).toBe(204)],
      ["max", async (id: string) => adapter.update({ model: "invitation", where: [{ field: "id", value: id }], update: { expiresAt: new Date(Date.now() - 60_000) } })],
    ] as const) {
      const { email, userId, cookie, invitationId } = await signUpInvited(name);
      expect(await rolesIn(userId)).toEqual([]);
      expect((await consoleSessionOf(cookie)).status).toBe(401);

      await endInvitation(invitationId);
      expect(await consoleSessionOf(await signIn(email))).toMatchObject({ status: 200, orgId, role: "member" });
      expect(await rolesIn(userId), name).toEqual(["member"]);
      if (name === "max") expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${invitationId}`)).status).toBe(204);
      expect((await registry.consoleWrite(owner, "DELETE", `/people/${userId}`)).status).toBe(200);
      expect((await consoleSessionOf(await signIn(email))).status, name).toBe(401);
      expect(await rolesIn(userId)).toEqual([]);
    }
  });

  it("keeps the account, its sessions and its deferral when the organisation fills between the re-join plan and the join, and joins on a later sign-in", async () => {
    const auth = registry.server.auth!;
    const adapter = await auth.adapter();
    const tenancy = registry.server.service.tenancy!;
    const orgId = await ownOrgId();
    const { email, userId, cookie, invitationId } = await signUpInvited("ada");
    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${invitationId}`)).status).toBe(204);
    auth.setJoinGate(async (join) => {
      if (join.email !== email) return;
      const count = (await adapter.findMany<unknown>({ model: "member", where: [{ field: "organizationId", value: orgId }] })).length;
      await tenancy.setUserLimit(orgId, count);
    });
    try {
      expect((await consoleSessionOf(await signIn(email))).status).toBe(401);
    } finally {
      auth.setJoinGate(undefined);
      await tenancy.setUserLimit(orgId, undefined);
    }
    expect(await adapter.findOne<{ id: string }>({ model: "user", where: [{ field: "id", value: userId }] })).toMatchObject({ id: userId });
    expect(await rolesInOrg(orgId, userId)).toEqual([]);
    const stillSignedIn = await fetch(`${registry.url}/api/auth/get-session`, { headers: { cookie } });
    expect(((await stillSignedIn.json()) as { user?: { id?: string } } | null)?.user?.id).toBe(userId);

    expect(await consoleSessionOf(await signIn(email))).toMatchObject({ status: 200, orgId, role: "member" });
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${userId}`)).status).toBe(200);
  });

  it("keeps the deferral cleared when a re-join fails after writing the member, and never fails the sign-in when the membership read fails", async () => {
    const auth = registry.server.auth!;
    const adapter = await auth.adapter();
    const members = auth.members;
    const orgId = await ownOrgId();
    const deferralOf = async (userId: string): Promise<unknown> =>
      (await adapter.findOne<{ joinDeferredAt?: unknown }>({ model: "user", where: [{ field: "id", value: userId }] }))?.joinDeferredAt ?? null;

    const cam = await signUpInvited("cam", "member");
    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${cam.invitationId}`)).status).toBe(204);
    const addMember = members.addMember.bind(members);
    members.addMember = async (row) => {
      await addMember(row);
      throw new Error("written, then failed");
    };
    try {
      expect(await consoleSessionOf(await signIn(cam.email))).toMatchObject({ status: 200, orgId, role: "member" });
    } finally {
      members.addMember = addMember;
    }
    expect(await deferralOf(cam.userId)).toBeNull();
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${cam.userId}`)).status).toBe(200);
    expect((await consoleSessionOf(await signIn(cam.email))).status).toBe(401);

    const dee = await signUpInvited("dee", "member");
    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${dee.invitationId}`)).status).toBe(204);
    const membershipOf = members.membershipOf.bind(members);
    members.membershipOf = async (userId, preferredOrgId) => {
      if (userId === dee.userId && preferredOrgId === orgId) throw new Error("read failed");
      return membershipOf(userId, preferredOrgId);
    };
    let cookie: string;
    try {
      cookie = await signIn(dee.email);
    } finally {
      members.membershipOf = membershipOf;
    }
    expect(await rolesInOrg(orgId, dee.userId)).toEqual(["member"]);
    expect(await deferralOf(dee.userId)).toBeNull();
    expect(await consoleSessionOf(cookie)).toMatchObject({ status: 200, orgId });
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${dee.userId}`)).status).toBe(200);
  });

  it("never re-joins a person who accepted their invitation and was then removed", async () => {
    const adapter = await registry.server.auth!.adapter();
    const orgId = await ownOrgId();
    const { email, userId, cookie, invitationId } = await signUpInvited("bea", "member");
    const accepted = await authPost("organization/accept-invitation", { invitationId }, cookie);
    expect(accepted.status, await accepted.clone().text()).toBe(200);
    expect(await rolesInOrg(orgId, userId)).toEqual(["member"]);
    expect(await adapter.findOne<{ joinDeferredAt?: unknown }>({ model: "user", where: [{ field: "id", value: userId }] })).not.toMatchObject({ joinDeferredAt: expect.anything() });

    expect((await registry.consoleWrite(owner, "DELETE", `/people/${userId}`)).status).toBe(200);
    expect((await consoleSessionOf(await signIn(email))).status).toBe(401);
    expect(await rolesInOrg(orgId, userId)).toEqual([]);
  });

  it("passes Better Auth's own refusal status through when a re-send is refused", async () => {
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "pat@onboarding.example", role: "member" });
    const invitationId = String((invited.body as { invitationId: string }).invitationId);
    const adapter = await registry.server.auth!.adapter();
    const orgId = String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId);
    const pat = await adapter.create<{ id: string }>({
      model: "user",
      data: { name: "pat", email: "pat@onboarding.example", emailVerified: true, createdAt: new Date(), updatedAt: new Date() },
    });
    await adapter.create({ model: "member", data: { organizationId: orgId, userId: pat.id, role: "member", createdAt: new Date() } });
    const refused = await registry.consoleWrite(owner, "POST", `/people/invitations/${invitationId}/resend`);
    expect(refused.status, refused.text).toBe(400);
    expect(refused.text).toContain("Nothing was sent");
    expect((await registry.consoleWrite(owner, "DELETE", `/people/invitations/${invitationId}`)).status).toBe(204);
    expect((await registry.consoleWrite(owner, "DELETE", `/people/${pat.id}`)).status).toBe(200);
  });

  it("keeps another organisation's invitations and people out of reach", async () => {
    const theirOwner = await registry.join("olu", "onboarding-elsewhere.example");
    const theirOrg = String(((await registry.consoleGet(theirOwner, "/session")).body as { orgId: string }).orgId);
    expect(theirOrg).not.toBe(String(((await registry.consoleGet(owner, "/session")).body as { orgId: string }).orgId));
    const invited = await registry.consoleWrite(theirOwner, "POST", "/people/invitations", { email: "ade@onboarding-elsewhere.example", role: "member" });
    const theirInvitation = String((invited.body as { invitationId: string }).invitationId);
    const theirRowBefore = rowFor(OnboardingPage.parse((await registry.consoleGet(theirOwner, "/people/onboarding")).body), "ade@onboarding-elsewhere.example");

    clock.advance(60_000);
    expect((await registry.consoleWrite(owner, "POST", `/people/invitations/${theirInvitation}/resend`)).status).toBe(404);
    expect((await registry.consoleWrite(owner, "POST", `/people/${theirOwner.userId}/onboarding/remind`)).status).toBe(404);
    expect(rowFor(OnboardingPage.parse((await registry.consoleGet(theirOwner, "/people/onboarding")).body), "ade@onboarding-elsewhere.example")).toEqual(theirRowBefore);

    const ours = JSON.stringify((await registry.consoleGet(owner, "/people/onboarding")).body);
    expect(ours).not.toContain("onboarding-elsewhere.example");
    expect(ours).not.toContain(theirInvitation);
    const theirs = JSON.stringify((await registry.consoleGet(theirOwner, "/people/onboarding")).body);
    expect(theirs).not.toContain(owner.email);
    expect(theirs).not.toContain(member.userId);
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
    expect(await chased()).not.toContain(email);
  });

  it("joins the chase list after chaseAfterDays, and a re-send records the new send time and restarts the count", async () => {
    clock.advance(3 * DAY + 60_000);
    expect(await chased()).toContain(email);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ kind: "invite", chase: true });
    const resent = await registry.consoleWrite(owner, "POST", `/people/invitations/${invitationId}/resend`);
    expect(resent.status, resent.text).toBe(200);
    expect(resent.body).toMatchObject({ invitationId, email, role: "member", delivery: "mail_off", emailed: false, inviteUrl: `${REGISTRY_ORIGIN}/login?invitation=${encodeURIComponent(invitationId)}` });
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ lastSentAt: clock.now().toISOString(), chase: false });
    clock.advance(3 * DAY);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ kind: "invite", chase: true });
  });

  it("is Signed in once they accept, and stays on the chase list until a Mac enrols", async () => {
    lee = await registry.join("lee", "onboarding.example", invitationId);
    const row = rowFor(await onboardingOf(), email);
    expect(row).toMatchObject({ kind: "person", userId: lee.userId, stage: "signed_in", chase: true });
    const people = (await registry.consoleGet(owner, "/people")).body as { rows: Array<{ subject: string; stage?: string }> };
    expect(people.rows.find((r) => r.subject === lee.userId)).toMatchObject({ stage: "signed_in", chase: true });
    const asMember = (await registry.consoleGet(member, "/people")).body as { rows: Array<{ subject: string; stage?: string }> };
    expect(asMember.rows.find((r) => r.subject === lee.userId)?.stage).toBeUndefined();
  });

  it("leaves the chase list when reminded, with the send time recorded, and returns after chaseAfterDays", async () => {
    const reminded = await registry.consoleWrite(owner, "POST", `/people/${lee.userId}/onboarding/remind`);
    expect(reminded.status, reminded.text).toBe(200);
    expect(reminded.body).toMatchObject({ userId: lee.userId, email, delivery: "mail_off", lastSentAt: clock.now().toISOString(), enrolUrl: expect.stringContaining("/guard/enrol/") });
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "signed_in", lastSentAt: clock.now().toISOString(), chase: false });
    clock.advance(3 * DAY);
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ kind: "person", chase: true });
  });

  it("is Enrolled once the Mac enrols, and leaves the chase list", async () => {
    mac = await enrolDevice(registry, owner, lee, "lee-mbp");
    expect(rowFor(await onboardingOf(), email)).toMatchObject({ stage: "enrolled", stageSince: clock.now().toISOString(), chase: false });
    const reminded = await registry.consoleWrite(owner, "POST", `/people/${lee.userId}/onboarding/remind`);
    expect([reminded.status, reminded.text]).toEqual([409, expect.stringContaining("is enrolled")]);
    expect(rowFor(await onboardingOf(), email)?.lastSentAt).not.toBe(clock.now().toISOString());
    expect(await chased()).not.toContain(email);
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
