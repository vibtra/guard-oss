import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
import { agentDoor, enrolDevice, preflightBody, required } from "./guard-device.ts";
import { capturingStorage, manualClock, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

type Json = Record<string, any>;

const ONBOARDING_MIGRATION = "0116_onboarding_facts.sql";

describe("the onboarding store", () => {
  const clock = manualClock(new Date("2026-11-02T09:00:00.000Z"));
  let registry: TestRegistry;
  let orgId: string;

  const onboarding = () => required(registry.server.service.onboarding, "the onboarding store");
  const tenancy = () => required(registry.server.service.tenancy, "the tenancy store");
  const guard = () => required(registry.server.service.guard, "the guard store");
  const personFacts = async (person: Person) =>
    required((await onboarding().listOnboardingFacts(orgId)).people.find((row) => row.userId === person.userId), `the facts of ${person.email}`);
  const invite = async (email: string): Promise<string> => {
    const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email, role: "member" });
    expect(invited.status, invited.text).toBe(200);
    return (invited.body as Json).invitationId;
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "onboarding-store.example", configure: (options) => ({ ...options, clock }) });
    orgId = ((await registry.consoleGet(registry.people.owner, "/session")).body as Json).orgId;
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("keeps an org's chase threshold at seven days until it is changed, and refuses one outside a day to a year", async () => {
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(7);
    await tenancy().setChaseAfterDays(orgId, 14);
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(14);
    await expect(tenancy().setChaseAfterDays(orgId, 0)).rejects.toThrow();
    await expect(tenancy().setChaseAfterDays(orgId, 366)).rejects.toThrow();
    expect(required(await tenancy().getOrg(orgId), "the org").chaseAfterDays).toBe(14);
    await expect(tenancy().setChaseAfterDays("org_nobody", 3)).rejects.toThrow(/No such org/);
  });

  it("lists a pending invite with when it was made and expires, and no send until one is recorded", async () => {
    const invitationId = await invite("Pending.Person@Elsewhere.example");
    const facts = await onboarding().listOnboardingFacts(orgId);
    const row = required(facts.invites.find((entry) => entry.invitationId === invitationId), "the pending invite");
    expect(row).toEqual({ invitationId, email: "pending.person@elsewhere.example", role: "member", invitedAt: expect.any(String), expiresAt: expect.any(String) });
    expect(Date.parse(row.expiresAt)).toBeGreaterThan(Date.parse(row.invitedAt));
    expect(facts.people.map((person) => person.email)).not.toContain("pending.person@elsewhere.example");
  });

  it("records when an invite was last sent, and only for an invite of the org named", async () => {
    const invitationId = await invite("resend.me@elsewhere.example");
    const sentAt = async () => (await onboarding().listOnboardingFacts(orgId)).invites.find((entry) => entry.invitationId === invitationId)?.lastSentAt;

    expect(await onboarding().recordInviteSent({ orgId: "org_somebody_else", invitationId, at: "2026-11-03T10:00:00.000Z" })).toBe(false);
    expect(await sentAt()).toBeUndefined();

    expect(await onboarding().recordInviteSent({ orgId, invitationId, at: "2026-11-03T10:00:00.000Z" })).toBe(true);
    expect(await sentAt()).toBe("2026-11-03T10:00:00.000Z");
    expect(await onboarding().recordInviteSent({ orgId, invitationId, at: "2026-11-05T10:00:00.000Z" })).toBe(true);
    expect(await sentAt()).toBe("2026-11-05T10:00:00.000Z");
    expect(await onboarding().recordInviteSent({ orgId, invitationId: "inv_missing", at: "2026-11-05T10:00:00.000Z" })).toBe(false);
  });

  it("gives a person who joined without an invite the time they joined and first signed in, and no device before they enrol", async () => {
    const person = await registry.join("never-enrolled");
    const facts = await personFacts(person);
    expect(facts).toEqual({
      userId: person.userId,
      email: person.email,
      name: "never-enrolled",
      role: "member",
      joinedAt: expect.any(String),
      firstSignInAt: expect.any(String),
      devices: [],
    });
    expect(Date.parse(required(facts.firstSignInAt, "a first sign-in"))).toBeLessThanOrEqual(Date.parse(facts.joinedAt));
  });

  it("gives an invited person the time of the invite they accepted", async () => {
    const email = "accepted@elsewhere.example";
    const invitationId = await invite(email);
    const invitedAt = required((await onboarding().listOnboardingFacts(orgId)).invites.find((entry) => entry.invitationId === invitationId), "the invite").invitedAt;
    const signUp = await fetch(`${registry.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email, password: "vibtra-test-passphrase-accepted", name: "accepted" }),
    });
    expect(signUp.ok, await signUp.clone().text()).toBe(true);
    const userId = ((await signUp.json()) as Json).user.id;
    const cookie = required(
      signUp.headers
        .getSetCookie()
        .map((line) => line.split(";")[0] ?? "")
        .find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)),
      "a session cookie",
    );
    const accepted = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, cookie },
      body: JSON.stringify({ invitationId }),
    });
    expect(accepted.status, await accepted.text()).toBe(200);

    const facts = await onboarding().listOnboardingFacts(orgId);
    expect(facts.invites.map((entry) => entry.invitationId)).not.toContain(invitationId);
    expect(required(facts.people.find((person) => person.userId === userId), "the accepted person")).toMatchObject({ email, invitedAt, devices: [] });
  });

  it("records when a device first reported a trusted certificate and an active extension, and keeps that first report", async () => {
    const { owner, member } = registry.people;
    const laptop = await enrolDevice(registry, owner, member, "member-onboarding");
    expect((await personFacts(member)).devices).toEqual([{ deviceId: laptop.deviceId, enrolledAt: expect.any(String), lastSyncAt: expect.any(String) }]);

    clock.set("2026-11-04T09:00:00.000Z");
    const untrusted = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-onboarding", { health: { caTrusted: false, extensionActive: false } }));
    expect(untrusted.status, untrusted.text).toBe(200);
    expect((await personFacts(member)).devices[0]).not.toHaveProperty("caTrustedAt");

    clock.set("2026-11-05T09:00:00.000Z");
    const trusted = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-onboarding", { health: { caTrusted: true, extensionActive: false } }));
    expect(trusted.status, trusted.text).toBe(200);

    clock.set("2026-11-06T09:00:00.000Z");
    const approved = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-onboarding", { health: { caTrusted: true, extensionActive: true } }));
    expect(approved.status, approved.text).toBe(200);

    clock.set("2026-11-07T09:00:00.000Z");
    const later = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-onboarding", { health: { caTrusted: true, extensionActive: true } }));
    expect(later.status, later.text).toBe(200);

    expect((await personFacts(member)).devices).toEqual([
      {
        deviceId: laptop.deviceId,
        enrolledAt: expect.any(String),
        caTrustedAt: "2026-11-05T09:00:00.000Z",
        extensionApprovedAt: "2026-11-06T09:00:00.000Z",
        lastSyncAt: "2026-11-07T09:00:00.000Z",
      },
    ]);
  });

  it("keeps the first integrity failure a device reports", async () => {
    const { owner, admin } = registry.people;
    const laptop = await enrolDevice(registry, owner, admin, "admin-integrity");
    await guard().updateDevice(orgId, laptop.deviceId, { integrityFailedAt: "2026-11-08T09:00:00.000Z" });
    await guard().updateDevice(orgId, laptop.deviceId, { integrityFailedAt: "2026-11-09T09:00:00.000Z" });
    expect((await personFacts(admin)).devices.find((device) => device.deviceId === laptop.deviceId)?.integrityFailedAt).toBe("2026-11-08T09:00:00.000Z");
  });

  it("leaves a revoked device out of a person's facts", async () => {
    const { owner } = registry.people;
    const kept = await enrolDevice(registry, owner, owner, "owner-kept");
    const revoked = await enrolDevice(registry, owner, owner, "owner-gone");
    expect((await personFacts(owner)).devices.map((device) => device.deviceId).sort()).toEqual([kept.deviceId, revoked.deviceId].sort());
    expect(await guard().revokeDevice(orgId, revoked.deviceId, owner.email, clock.now().toISOString())).toBeDefined();
    expect((await personFacts(owner)).devices.map((device) => device.deviceId)).toEqual([kept.deviceId]);
  });

  it("keeps each org's facts to itself", async () => {
    const other = await startRegistry({ domain: "onboarding-other.example" });
    try {
      const otherOrg = ((await other.consoleGet(other.people.owner, "/session")).body as Json).orgId;
      const facts = required(other.server.service.onboarding, "the other onboarding store");
      expect((await facts.listOnboardingFacts(otherOrg)).people.map((person) => person.email).sort()).toEqual(
        [other.people.owner.email, other.people.admin.email, other.people.member.email].sort(),
      );
      expect((await facts.listOnboardingFacts(orgId)).people).toEqual([]);
    } finally {
      await other.close();
    }
  });
});

describe("migration 0116 in Postgres", () => {
  let storage: Storage | undefined;
  let registry: TestRegistry;

  beforeAll(async () => {
    registry = await startRegistry({ domain: "onboarding-migration.example", configure: capturingStorage((captured) => (storage = captured)) });
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("refuses a chase threshold outside a day to a year in the database itself", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
    const orgId = ((await registry.consoleGet(registry.people.owner, "/session")).body as Json).orgId;
    expect(await sqlRows(databaseUrl, "SELECT chase_after_days FROM orgs WHERE org_id = $1", [orgId])).toEqual([{ chase_after_days: 7 }]);
    await expect(sqlRows(databaseUrl, "UPDATE orgs SET chase_after_days = 0 WHERE org_id = $1", [orgId])).rejects.toThrow(/check constraint/);
    await expect(sqlRows(databaseUrl, "UPDATE orgs SET chase_after_days = 366 WHERE org_id = $1", [orgId])).rejects.toThrow(/check constraint/);
  });

  it("backfills trust and extension times on devices that already reported them, and leaves the rest empty", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
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
        `ALTER TABLE guard_devices DROP COLUMN ca_trusted_at, DROP COLUMN extension_approved_at, DROP COLUMN integrity_failed_at;
         ALTER TABLE orgs DROP COLUMN chase_after_days;
         ALTER TABLE "invitation" DROP COLUMN "lastSentAt"`,
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

      await migrate();

      expect(await sqlRows(databaseUrl, "SELECT name FROM registry_migrations WHERE name = $1", [ONBOARDING_MIGRATION])).toHaveLength(1);
      const rows = await sqlRows<Json>(
        databaseUrl,
        "SELECT device_id, ca_trusted_at, extension_approved_at, integrity_failed_at FROM guard_devices ORDER BY device_id",
      );
      expect(rows.map((row) => [row.device_id, row.ca_trusted_at?.toISOString() ?? null, row.extension_approved_at?.toISOString() ?? null, row.integrity_failed_at])).toEqual([
        ["gdev_both", "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z", null],
        ["gdev_silent", null, null, null],
        ["gdev_trust_never_synced", "2026-10-01T00:00:00.000Z", null, null],
        ["gdev_untrusted", null, null, null],
      ]);
    } finally {
      await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});
