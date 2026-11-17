import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
import { createFileGuardStore, type GuardStore } from "@vibtra/registry/src/guard/store.ts";
import { createMemberDirectory } from "@vibtra/registry/src/tenancy/members.ts";
import { createFileOrgStore } from "@vibtra/registry/src/tenancy/store.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, facts, preflightBody, required } from "./guard-device.ts";
import { capturingStorage, manualClock, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

type Json = Record<string, any>;

const ONBOARDING_MIGRATION = "0116_onboarding_facts.sql";

const sessionCookieOf = (response: Response): string =>
  required(
    response.headers
      .getSetCookie()
      .map((line) => line.split(";")[0] ?? "")
      .find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)),
    "a session cookie",
  );

const integritySequence = async (store: GuardStore, orgId: string, deviceId: string) => {
  const integrity = async () => {
    const device = required(await store.getDevice(orgId, deviceId), "the device");
    return { failedAt: device.integrityFailedAt, checkedAt: device.integrityCheckedAt };
  };
  const seen: Array<{ failedAt: string | undefined; checkedAt: string | undefined }> = [];
  await store.updateDevice(orgId, deviceId, { integrity: { kind: "failed", at: "2026-11-08T09:00:00.000Z" } });
  seen.push(await integrity());
  await store.updateDevice(orgId, deviceId, { integrity: { kind: "failed", at: "2026-11-09T09:00:00.000Z" } });
  seen.push(await integrity());
  await store.updateDevice(orgId, deviceId, { integrity: { kind: "passed", at: "2026-11-10T09:00:00.000Z" } });
  seen.push(await integrity());
  await store.updateDevice(orgId, deviceId, { lastSeenAt: "2026-11-10T10:00:00.000Z" });
  seen.push(await integrity());
  await store.updateDevice(orgId, deviceId, { integrity: { kind: "failed", at: "2026-11-11T09:00:00.000Z" } });
  seen.push(await integrity());
  return seen;
};

const EXPECTED_INTEGRITY = [
  { failedAt: "2026-11-08T09:00:00.000Z", checkedAt: "2026-11-08T09:00:00.000Z" },
  { failedAt: "2026-11-08T09:00:00.000Z", checkedAt: "2026-11-09T09:00:00.000Z" },
  { failedAt: undefined, checkedAt: "2026-11-10T09:00:00.000Z" },
  { failedAt: undefined, checkedAt: "2026-11-10T09:00:00.000Z" },
  { failedAt: "2026-11-11T09:00:00.000Z", checkedAt: "2026-11-11T09:00:00.000Z" },
];

describe("a device's integrity in the file store", () => {
  it("dates the current failure from its first report, clears it on a passing report, and keeps the last check", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "onboarding-integrity-"));
    try {
      const store = await createFileGuardStore(path.join(dir, "guard.json"));
      await store.insertDevice({
        deviceId: "gdev_00000000000000a1",
        orgId: "org_file",
        personUserId: "usr_file",
        personEmail: "file@example.com",
        tokenSha256: "ab".repeat(32),
        facts: facts("file-laptop"),
        status: "active",
        clientMode: "monitor",
        enrolledAt: "2026-11-01T09:00:00.000Z",
      });
      expect(await integritySequence(store, "org_file", "gdev_00000000000000a1")).toEqual(EXPECTED_INTEGRITY);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("an org's chase threshold in the file store", () => {
  it("keeps seven days until changed, refuses anything but whole days from 1 to 365, and keeps a change across a restart", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "onboarding-chase-"));
    try {
      const file = path.join(dir, "tenancy.json");
      const store = await createFileOrgStore(file);
      await store.createOrg({ orgId: "org_file_chase", name: "File chase", createdAt: "2026-11-01T09:00:00.000Z" });
      expect(required(await store.getOrg("org_file_chase"), "the org").chaseAfterDays).toBe(7);
      await store.setChaseAfterDays("org_file_chase", 30);
      for (const days of [0, 366, 2.5]) {
        await expect(store.setChaseAfterDays("org_file_chase", days)).rejects.toMatchObject({ code: "VALIDATION", message: "A chase threshold is a whole number of days from 1 to 365" });
      }
      await expect(store.setChaseAfterDays("org_nobody", 3)).rejects.toThrow(/No such org/);
      expect(required(await (await createFileOrgStore(file)).getOrg("org_file_chase"), "the reloaded org").chaseAfterDays).toBe(30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(postgresMissing())("the onboarding store in Postgres", () => {
  const clock = manualClock(new Date("2026-11-02T09:00:00.000Z"));
  let storage: Storage | undefined;
  let registry: TestRegistry;
  let orgId: string;
  let databaseUrl: string;

  const onboarding = () => required(registry.server.service.onboarding, "the onboarding store");
  const tenancy = () => required(registry.server.service.tenancy, "the tenancy store");
  const guard = () => required(registry.server.service.guard, "the guard store");
  const factsOf = async (org: string, userId: string) =>
    required((await onboarding().listOnboardingFacts(org)).people.find((row) => row.userId === userId), `the facts of ${userId}`);
  const personFacts = (person: Person) => factsOf(orgId, person.userId);
  const invite = async (inviter: Person, email: string, role: "member" | "admin" = "member"): Promise<string> => {
    const invited = await registry.consoleWrite(inviter, "POST", "/people/invitations", { email, role });
    expect(invited.status, invited.text).toBe(200);
    return (invited.body as Json).invitationId;
  };
  const seedMember = async (org: string, name: string, joinedAt: string): Promise<string> => {
    const userId = `usr_seed_${randomBytes(4).toString("hex")}`;
    await sqlRows(databaseUrl, `INSERT INTO "user" ("id", "name", "email", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $4)`, [userId, name, `${name}@seeded.example`, joinedAt]);
    await sqlRows(databaseUrl, `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, 'member', $4)`, [`mem_${userId}`, org, userId, joinedAt]);
    return userId;
  };
  const seedInvite = async (org: string, email: string, status: string, createdAt: string): Promise<string> => {
    const invitationId = `inv_seed_${randomBytes(4).toString("hex")}`;
    await sqlRows(
      databaseUrl,
      `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId") VALUES ($1, $2, $3, 'member', $4, $5::timestamptz + interval '7 days', $5, $6)`,
      [invitationId, org, email, status, createdAt, registry.people.owner.userId],
    );
    return invitationId;
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "onboarding-store.example", configure: capturingStorage((captured) => (storage = captured), (options) => ({ ...options, clock })) });
    orgId = ((await registry.consoleGet(registry.people.owner, "/session")).body as Json).orgId;
    databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("keeps an org's chase threshold at seven days until it is changed, and refuses one outside a day to a year", async () => {
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(7);
    await tenancy().setChaseAfterDays(orgId, 14);
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(14);
    for (const days of [0, 366, 2.5]) {
      await expect(tenancy().setChaseAfterDays(orgId, days)).rejects.toMatchObject({ code: "VALIDATION", message: "A chase threshold is a whole number of days from 1 to 365" });
    }
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(14);
    await expect(tenancy().setChaseAfterDays("org_nobody", 3)).rejects.toThrow(/No such org/);
    await expect(sqlRows(databaseUrl, "UPDATE orgs SET chase_after_days = 0 WHERE org_id = $1", [orgId])).rejects.toThrow(/check constraint/);
    await expect(sqlRows(databaseUrl, "UPDATE orgs SET chase_after_days = 366 WHERE org_id = $1", [orgId])).rejects.toThrow(/check constraint/);
  });

  it("lists a pending invite with when it was made and expires, and no send until one is recorded", async () => {
    const invitationId = await invite(registry.people.owner, "Pending.Person@Elsewhere.example");
    const listed = await onboarding().listOnboardingFacts(orgId);
    const row = required(listed.invites.find((entry) => entry.invitationId === invitationId), "the pending invite");
    expect(row).toEqual({ invitationId, email: "pending.person@elsewhere.example", role: "member", invitedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.parse(row.invitedAt));
    expect(listed.people.map((person) => person.email)).not.toContain("pending.person@elsewhere.example");
  });

  it("reads an owner invite back with its owner role", async () => {
    const invitationId = await seedInvite(orgId, "owner.to.be@elsewhere.example", "pending", "2026-11-01T09:00:00Z");
    await sqlRows(databaseUrl, `UPDATE "invitation" SET "role" = 'owner' WHERE "id" = $1`, [invitationId]);
    expect((await onboarding().listOnboardingFacts(orgId)).invites.find((entry) => entry.invitationId === invitationId)?.role).toBe("owner");
  });

  it("leaves rejected and cancelled invites out", async () => {
    const rejected = await seedInvite(orgId, "said.no@elsewhere.example", "rejected", "2026-11-01T09:00:00Z");
    const canceled = await seedInvite(orgId, "withdrawn@elsewhere.example", "canceled", "2026-11-01T09:00:00Z");
    const ids = (await onboarding().listOnboardingFacts(orgId)).invites.map((entry) => entry.invitationId);
    expect(ids).not.toContain(rejected);
    expect(ids).not.toContain(canceled);
  });

  it("records when an invite was last sent, and only for an invite of the org named", async () => {
    const invitationId = await invite(registry.people.owner, "resend.me@elsewhere.example");
    const sentAt = async () => (await onboarding().listOnboardingFacts(orgId)).invites.find((entry) => entry.invitationId === invitationId)?.lastSentAt;

    expect(await onboarding().recordInviteSent({ orgId: "org_somebody_else", invitationId, at: "2026-11-03T10:00:00.000Z" })).toBe(false);
    expect(await sentAt()).toBeUndefined();

    expect(await onboarding().recordInviteSent({ orgId, invitationId, at: "2026-11-03T10:00:00.000Z" })).toBe(true);
    expect(await sentAt()).toBe("2026-11-03T10:00:00.000Z");
    expect(await onboarding().recordInviteSent({ orgId, invitationId, at: "2026-11-05T10:00:00.000Z" })).toBe(true);
    expect(await sentAt()).toBe("2026-11-05T10:00:00.000Z");
    expect(await onboarding().recordInviteSent({ orgId, invitationId: "inv_missing", at: "2026-11-05T10:00:00.000Z" })).toBe(false);
  });

  it("gives a person who never signed in no first sign-in", async () => {
    const userId = await seedMember(orgId, "never-signed-in", "2026-11-01T09:00:00Z");
    expect(await factsOf(orgId, userId)).toMatchObject({ firstSignInAt: null, joinedAt: "2026-11-01T09:00:00.000Z", devices: [] });
  });

  it("records a person's first sign-in from their first session, and keeps it when they sign in again", async () => {
    const { member } = registry.people;
    const [firstSession] = await sqlRows<{ first: Date }>(databaseUrl, `SELECT min("createdAt") AS first FROM "session" WHERE "userId" = $1`, [member.userId]);
    const first = required(firstSession, "the member's first session").first.toISOString();
    expect((await personFacts(member)).firstSignInAt).toBe(first);

    await sqlRows(databaseUrl, `DELETE FROM "session" WHERE "userId" = $1`, [member.userId]);
    const again = await fetch(`${registry.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email: member.email, password: `vibtra-test-passphrase-${member.email}` }),
    });
    expect(again.status, await again.text()).toBe(200);
    expect(await sqlRows(databaseUrl, `SELECT 1 FROM "session" WHERE "userId" = $1`, [member.userId])).toHaveLength(1);
    expect((await personFacts(member)).firstSignInAt).toBe(first);
  });

  it("records only one first sign-in when several first sessions race", async () => {
    const { admin } = registry.people;
    await sqlRows(databaseUrl, `UPDATE "user" SET "firstSignInAt" = NULL WHERE "id" = $1`, [admin.userId]);
    const auth = required(registry.server.auth, "the registry's auth");
    const directory = createMemberDirectory(() => auth.adapter());
    const times = Array.from({ length: 10 }, (_, index) => `2026-11-12T09:00:0${index}.000Z`);
    const wrote = await Promise.all(times.map((at) => directory.recordSignIn(admin.userId, at)));
    expect(wrote.filter(Boolean)).toHaveLength(1);
    const winner = required(times[wrote.indexOf(true)], "the winning time");
    expect((await personFacts(admin)).firstSignInAt).toBe(winner);
    expect(await directory.recordSignIn(admin.userId, "2026-11-01T09:00:00.000Z")).toBe(false);
    expect((await personFacts(admin)).firstSignInAt).toBe(winner);
  });

  it("reads every member and invite of an org larger than one page of the auth database", async () => {
    const bigOrg = `org_big_${randomBytes(4).toString("hex")}`;
    await sqlRows(databaseUrl, `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, 'Big', $1, now())`, [bigOrg]);
    await sqlRows(
      databaseUrl,
      `INSERT INTO "user" ("id", "name", "email", "createdAt", "updatedAt")
       SELECT $1 || '_u' || n, 'big ' || n, $1 || '_' || n || '@big.example', now(), now() FROM generate_series(1, 130) AS n`,
      [bigOrg],
    );
    await sqlRows(
      databaseUrl,
      `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt")
       SELECT $1 || '_m' || n, $1, $1 || '_u' || n, 'member', now() - n * interval '1 minute' FROM generate_series(1, 130) AS n`,
      [bigOrg],
    );
    await sqlRows(
      databaseUrl,
      `INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "createdAt", "inviterId")
       SELECT $1 || '_i' || n, $1, $1 || '_invite_' || n || '@big.example', 'member', 'pending', now() + interval '7 days', now(), $2 FROM generate_series(1, 115) AS n`,
      [bigOrg, registry.people.owner.userId],
    );
    const listed = await onboarding().listOnboardingFacts(bigOrg);
    expect(new Set(listed.people.map((person) => person.userId)).size).toBe(130);
    expect(new Set(listed.invites.map((entry) => entry.invitationId)).size).toBe(115);
    expect(listed.people.every((person) => person.email.endsWith("@big.example"))).toBe(true);
    expect(await tenancy().listUsers(bigOrg)).toHaveLength(130);
  });

  it("gives an invited person the time of the invite they accepted", async () => {
    const email = "accepted@elsewhere.example";
    const invitationId = await invite(registry.people.owner, email);
    const invitedAt = required((await onboarding().listOnboardingFacts(orgId)).invites.find((entry) => entry.invitationId === invitationId), "the invite").invitedAt;
    const signUp = await fetch(`${registry.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email, password: "vibtra-test-passphrase-accepted", name: "accepted" }),
    });
    expect(signUp.ok, await signUp.clone().text()).toBe(true);
    const userId = ((await signUp.json()) as Json).user.id;
    const accepted = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, cookie: sessionCookieOf(signUp) },
      body: JSON.stringify({ invitationId }),
    });
    expect(accepted.status, await accepted.text()).toBe(200);

    const listed = await onboarding().listOnboardingFacts(orgId);
    expect(listed.invites.map((entry) => entry.invitationId)).not.toContain(invitationId);
    expect(required(listed.people.find((person) => person.userId === userId), "the accepted person")).toMatchObject({ email, invitedAt, firstSignInAt: expect.any(String), devices: [] });
  });

  it("takes the latest invite a person accepted before they joined, not an older one or a later one", async () => {
    const userId = await seedMember(orgId, "reinvited", "2026-10-20T09:00:00Z");
    await seedInvite(orgId, "reinvited@seeded.example", "accepted", "2026-10-01T09:00:00Z");
    await seedInvite(orgId, "reinvited@seeded.example", "accepted", "2026-10-15T09:00:00Z");
    await seedInvite(orgId, "reinvited@seeded.example", "accepted", "2026-10-25T09:00:00Z");
    expect((await factsOf(orgId, userId)).invitedAt).toBe("2026-10-15T09:00:00.000Z");
  });

  it("records when a device first reported a trusted certificate and an active extension, and reports the current state beside it", async () => {
    const { owner, member } = registry.people;
    const laptop = await enrolDevice(registry, owner, member, "member-onboarding");
    expect((await personFacts(member)).devices).toEqual([
      { deviceId: laptop.deviceId, enrolledAt: expect.any(String), caTrusted: false, extensionActive: false, lastSyncAt: expect.any(String) },
    ]);
    const preflight = async (at: string, health: { caTrusted: boolean; extensionActive: boolean }) => {
      clock.set(at);
      const reply = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-onboarding", { health }));
      expect(reply.status, reply.text).toBe(200);
    };

    await preflight("2026-11-04T09:00:00.000Z", { caTrusted: false, extensionActive: false });
    await preflight("2026-11-05T09:00:00.000Z", { caTrusted: true, extensionActive: false });
    await preflight("2026-11-06T09:00:00.000Z", { caTrusted: true, extensionActive: true });
    await preflight("2026-11-07T09:00:00.000Z", { caTrusted: true, extensionActive: true });
    expect((await personFacts(member)).devices).toEqual([
      {
        deviceId: laptop.deviceId,
        enrolledAt: expect.any(String),
        caTrusted: true,
        extensionActive: true,
        caTrustedAt: "2026-11-05T09:00:00.000Z",
        extensionApprovedAt: "2026-11-06T09:00:00.000Z",
        caTrustChangedAt: "2026-11-05T09:00:00.000Z",
        extensionChangedAt: "2026-11-06T09:00:00.000Z",
        lastSyncAt: "2026-11-07T09:00:00.000Z",
      },
    ]);

    await preflight("2026-11-08T09:00:00.000Z", { caTrusted: false, extensionActive: true });
    expect((await personFacts(member)).devices[0]).toMatchObject({
      caTrusted: false,
      extensionActive: true,
      caTrustedAt: "2026-11-05T09:00:00.000Z",
      caTrustChangedAt: "2026-11-08T09:00:00.000Z",
      extensionChangedAt: "2026-11-06T09:00:00.000Z",
      lastSyncAt: "2026-11-08T09:00:00.000Z",
    });
  });

  it("dates the current integrity failure from its first report, clears it on a passing report, and keeps the last check", async () => {
    const { owner, admin } = registry.people;
    const laptop = await enrolDevice(registry, owner, admin, "admin-integrity");
    expect(await integritySequence(guard(), orgId, laptop.deviceId)).toEqual(EXPECTED_INTEGRITY);
    expect((await personFacts(admin)).devices.find((device) => device.deviceId === laptop.deviceId)).toMatchObject({
      integrityFailedAt: "2026-11-11T09:00:00.000Z",
      integrityCheckedAt: "2026-11-11T09:00:00.000Z",
    });
    await expect(sqlRows(databaseUrl, "UPDATE guard_devices SET integrity_checked_at = NULL WHERE device_id = $1", [laptop.deviceId])).rejects.toThrow(/check constraint/);
  });

  it("leaves a revoked device out of a person's facts", async () => {
    const { owner } = registry.people;
    const kept = await enrolDevice(registry, owner, owner, "owner-kept");
    const revoked = await enrolDevice(registry, owner, owner, "owner-gone");
    expect((await personFacts(owner)).devices.map((device) => device.deviceId).sort()).toEqual([kept.deviceId, revoked.deviceId].sort());
    expect(await guard().revokeDevice(orgId, revoked.deviceId, owner.email, clock.now().toISOString())).toBeDefined();
    expect((await personFacts(owner)).devices.map((device) => device.deviceId)).toEqual([kept.deviceId]);
  });

  it("keeps two orgs in one database apart: people, invites and devices", async () => {
    const otherOwner = await registry.join("other-owner", "onboarding-other.example");
    const otherOrg = ((await registry.consoleGet(otherOwner, "/session")).body as Json).orgId;
    expect(otherOrg).not.toBe(orgId);
    const otherInvite = await invite(otherOwner, "only.other@elsewhere.example");
    const otherLaptop = await enrolDevice(registry, otherOwner, otherOwner, "other-owner-laptop");
    const ownInvite = await invite(registry.people.owner, "only.own@elsewhere.example");

    const own = await onboarding().listOnboardingFacts(orgId);
    const other = await onboarding().listOnboardingFacts(otherOrg);
    const ids = (listed: typeof own) => ({
      people: listed.people.map((person) => person.userId),
      invites: listed.invites.map((entry) => entry.invitationId),
      devices: listed.people.flatMap((person) => person.devices.map((device) => device.deviceId)),
    });

    expect(ids(other)).toEqual({ people: [otherOwner.userId], invites: [otherInvite], devices: [otherLaptop.deviceId] });
    expect(ids(own).people).not.toContain(otherOwner.userId);
    expect(ids(own).invites).not.toContain(otherInvite);
    expect(ids(own).devices).not.toContain(otherLaptop.deviceId);
    expect(ids(own).invites).toContain(ownInvite);
    expect(ids(own).people).toEqual(expect.arrayContaining([registry.people.owner.userId, registry.people.admin.userId, registry.people.member.userId]));
    expect(ids(own).devices.length).toBeGreaterThan(0);
  });
});

describe.skipIf(postgresMissing())("a first sign-in that cannot be recorded", () => {
  let storage: Storage | undefined;
  let registry: TestRegistry;
  const written: string[] = [];

  beforeAll(async () => {
    registry = await startRegistry({
      domain: "onboarding-sign-in.example",
      configure: capturingStorage(
        (captured) => (storage = captured),
        (options) => ({ ...options, logger: { stream: { write: (line: string) => void written.push(line) }, level: "warn" } }),
      ),
    });
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("still signs the person in, logs a warning without their address, and records it on the next sign-in", async () => {
    const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
    await sqlRows(databaseUrl, `ALTER TABLE "user" ADD CONSTRAINT onboarding_test_refuses_first_sign_in CHECK ("firstSignInAt" IS NULL) NOT VALID`);
    const person = await registry.join("unrecorded");
    const orgId = ((await registry.consoleGet(person, "/session")).body as Json).orgId;
    const onboarding = required(registry.server.service.onboarding, "the onboarding store");
    const factsOfPerson = async () => required((await onboarding.listOnboardingFacts(orgId)).people.find((row) => row.userId === person.userId), "the person");
    expect((await factsOfPerson()).firstSignInAt).toBeNull();

    const warnings = written.map((line) => JSON.parse(line) as Json).filter((line) => line.step === "record_first_sign_in");
    expect(warnings).toEqual([expect.objectContaining({ msg: "the first sign-in was not recorded; the next sign-in retries", error: expect.any(String) })]);
    expect(written.join("\n")).not.toContain(person.email);

    await sqlRows(databaseUrl, `ALTER TABLE "user" DROP CONSTRAINT onboarding_test_refuses_first_sign_in`);
    const again = await fetch(`${registry.url}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email: person.email, password: `vibtra-test-passphrase-${person.email}` }),
    });
    expect(again.status, await again.text()).toBe(200);
    expect((await factsOfPerson()).firstSignInAt).toEqual(expect.any(String));
  });
});

describe.skipIf(postgresMissing())("migration 0116 in Postgres", () => {
  it("backfills first sign-in, trust and extension times, and leaves the rest empty", async () => {
    const shared = required(process.env.VIBTRA_TEST_DATABASE_URL, "VIBTRA_TEST_DATABASE_URL");
    const schema = `onboarding_mig_${randomBytes(6).toString("hex")}`;
    await sqlRows(shared, `CREATE SCHEMA ${schema}`);
    const databaseUrl = `${shared}${shared.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
    const migrate = async (): Promise<void> => {
      const stores = createPostgresRegistryStores(databaseUrl);
      try {
        await stores.migrate();
      } finally {
        await stores.close();
      }
    };
    try {
      await migrate();
      await sqlRows(
        databaseUrl,
        `ALTER TABLE guard_devices DROP COLUMN ca_trusted_at, DROP COLUMN extension_approved_at, DROP COLUMN integrity_failed_at, DROP COLUMN integrity_checked_at;
         ALTER TABLE orgs DROP COLUMN chase_after_days;
         ALTER TABLE "invitation" DROP COLUMN "lastSentAt";
         ALTER TABLE "user" DROP COLUMN "firstSignInAt"`,
      );
      await sqlRows(databaseUrl, "DELETE FROM registry_migrations WHERE name = $1", [ONBOARDING_MIGRATION]);

      const device = (id: string, health: unknown, lastSeenAt: string | null) =>
        sqlRows(
          databaseUrl,
          `INSERT INTO guard_devices (device_id, org_id, person_user_id, person_email, token_sha256, facts, health, status, client_mode, enrolled_at, last_seen_at)
           VALUES ($1, 'org_mig', 'usr_mig', 'mig@example.com', $2, '{}'::jsonb, $3::jsonb, 'active', 'monitor', '2026-10-01T00:00:00Z', $4)`,
          [id, "ab".repeat(32), health === null ? null : JSON.stringify(health), lastSeenAt],
        );
      await device("gdev_both", { caTrusted: true, extensionActive: true }, "2026-10-05T00:00:00Z");
      await device("gdev_trust_never_synced", { caTrusted: true, extensionActive: false }, null);
      await device("gdev_untrusted", { caTrusted: false }, "2026-10-06T00:00:00Z");
      await device("gdev_silent", null, null);

      const user = (id: string, createdAt: string) =>
        sqlRows(databaseUrl, `INSERT INTO "user" ("id", "name", "email", "createdAt", "updatedAt") VALUES ($1, $1, $1 || '@mig.example', $2, $2)`, [id, createdAt]);
      const session = (userId: string, createdAt: string) =>
        sqlRows(
          databaseUrl,
          `INSERT INTO "session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId") VALUES ($1, $2::timestamptz + interval '7 days', $1, $2, $2, $3)`,
          [`ses_${randomBytes(4).toString("hex")}`, createdAt, userId],
        );
      await sqlRows(databaseUrl, `INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org_mig', 'Mig', 'mig', now())`);
      await user("usr_sessions", "2026-09-01T00:00:00Z");
      await session("usr_sessions", "2026-09-03T00:00:00Z");
      await session("usr_sessions", "2026-09-02T00:00:00Z");
      await user("usr_member_no_session", "2026-09-04T00:00:00Z");
      await sqlRows(databaseUrl, `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ('mem_mig', 'org_mig', 'usr_member_no_session', 'member', now())`);
      await user("usr_neither", "2026-09-05T00:00:00Z");

      await migrate();

      expect(await sqlRows(databaseUrl, "SELECT name FROM registry_migrations WHERE name = $1", [ONBOARDING_MIGRATION])).toHaveLength(1);
      const devices = await sqlRows<Json>(databaseUrl, "SELECT device_id, ca_trusted_at, extension_approved_at, integrity_failed_at, integrity_checked_at FROM guard_devices ORDER BY device_id");
      expect(devices.map((row) => [row.device_id, row.ca_trusted_at?.toISOString() ?? null, row.extension_approved_at?.toISOString() ?? null, row.integrity_failed_at, row.integrity_checked_at])).toEqual([
        ["gdev_both", "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", null, null],
        ["gdev_silent", null, null, null, null],
        ["gdev_trust_never_synced", "2026-10-01T00:00:00.000Z", null, null, null],
        ["gdev_untrusted", null, null, null, null],
      ]);
      const users = await sqlRows<Json>(databaseUrl, `SELECT "id", "firstSignInAt" FROM "user" ORDER BY "id"`);
      expect(users.map((row) => [row.id, row.firstSignInAt?.toISOString() ?? null])).toEqual([
        ["usr_member_no_session", "2026-09-04T00:00:00.000Z"],
        ["usr_neither", null],
        ["usr_sessions", "2026-09-02T00:00:00.000Z"],
      ]);
      expect(await sqlRows(databaseUrl, "SELECT chase_after_days FROM orgs")).toEqual([]);
    } finally {
      await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
