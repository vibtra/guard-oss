import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUARD_PROTOCOL_VERSION,
  GuardActivityPage,
  GuardDevicesPage,
  GuardOverviewPage,
  GuardPreflightResponse,
  GuardRuleDownloadResponse,
  GuardRuleTestResult,
  GuardSettings,
  GuardSettingsPage,
  GuardSignaturePayload,
  type GuardClientMode,
  type GuardDeviceFacts,
  type SignedGuardBundle,
} from "@vibtra/guard-contract";
import { digestOf, verifyGuardBundle } from "@vibtra/guard-contract/signing";
import { createGuardPostgresStore } from "@vibtra/registry/src/guard/postgres-store.ts";
import { GuardPersonProtectionRecord, GuardProtectionRevision, createFileGuardStore, type GuardStore } from "@vibtra/registry/src/guard/store.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createInProcessOrgLocks, createPostgresOrgLocks, orgOf, type OrgLockedTx, type OrgLocks } from "@vibtra/registry/src/store/org-lock.ts";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, eventId, facts, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

const SEVENTY_TWO_HOURS_S = 72 * 60 * 60;
const AT = "2026-11-23T09:00:00.000Z";
const CAN_TURN_OFF: Partial<GuardDeviceFacts> = { capabilities: { protectionOff: 1 } };

const snake = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

interface Opened {
  readonly store: GuardStore;
  readonly locks: OrgLocks;
}

interface OpenedStores {
  readonly databaseUrl?: string;
  readonly dir?: string;
  open(): Promise<Opened>;
  close(): Promise<void>;
}

const openFileStores = async (): Promise<OpenedStores & { readonly dir: string }> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-protection-"));
  const locks = createInProcessOrgLocks();
  return { dir, open: async () => ({ store: await createFileGuardStore(path.join(dir, "guard.json")), locks }), close: () => rm(dir, { recursive: true, force: true }) };
};

const openPostgresStores = async (): Promise<OpenedStores & { readonly databaseUrl: string }> => {
  const shared = required(process.env.VIBTRA_TEST_DATABASE_URL, "VIBTRA_TEST_DATABASE_URL");
  const schema = `guard_protection_${randomBytes(6).toString("hex")}`;
  await sqlRows(shared, `CREATE SCHEMA ${schema}`);
  const databaseUrl = `${shared}${shared.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
  const pools: Array<ReturnType<typeof createPostgresRegistryStores>> = [];
  const migrated = createPostgresRegistryStores(databaseUrl);
  pools.push(migrated);
  await migrated.migrate();
  return {
    databaseUrl,
    open: async () => {
      const stores = createPostgresRegistryStores(databaseUrl);
      pools.push(stores);
      return { store: createGuardPostgresStore(stores.pool), locks: createPostgresOrgLocks(stores.pool) };
    },
    close: async () => {
      await Promise.all(pools.map((stores) => stores.close()));
      await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
};

const change = (orgId: string, set: Array<{ userId: string; mode: GuardClientMode }>, clear: string[] = []) => ({ orgId, set, clear, by: "it@example.com", at: AT });
const protect = ({ store, locks }: Opened, c: ReturnType<typeof change> & { clientMode?: GuardClientMode }) =>
  locks.withOrgLock(c.orgId, async (tx) => {
    const update = (current: GuardSettings) => (c.clientMode === undefined ? undefined : { ...current, clientMode: c.clientMode });
    return (await store.saveSettings(tx, { fallback: GuardSettings.parse({}), update, set: c.set, clear: c.clear, by: c.by, at: c.at })).revision;
  });
const row = (orgId: string, userId: string, mode: GuardClientMode, revision: number, off: { offSince?: string; offUntil?: string } = {}): GuardPersonProtectionRecord => ({
  orgId,
  userId,
  mode,
  revision,
  setBy: "it@example.com",
  setAt: AT,
  ...off,
});
const minute = (m: number): string => `2026-11-23T10:${String(m).padStart(2, "0")}:00.000Z`;
const plusMs = (at: string, ms: number): string => new Date(Date.parse(at) + ms).toISOString();

const TWINS = [
  { name: "JSON file", postgres: false },
  { name: "Postgres", postgres: true },
] as const;

for (const twin of TWINS) {
  describe.skipIf(twin.postgres && postgresMissing())(`each person's protection in the guard store (${twin.name})`, () => {
    const opened = () => (twin.postgres ? openPostgresStores() : openFileStores());

    it("counts one revision per org change, stamps set people with it, and moves the default revision only when someone returns to the default or the default changes", async () => {
      const stores = await opened();
      try {
        const opened = await stores.open();
        const { store } = opened;
        expect(await store.getProtectionRevision("org_a")).toEqual({ revision: 0, defaultRevision: 0 });
        expect(await store.getPersonProtection("org_a", "usr_ana")).toBeUndefined();
        expect(await store.listPersonProtection("org_a")).toEqual([]);

        expect(await protect(opened, change("org_a", [{ userId: "usr_bo", mode: "enforce" }, { userId: "usr_ana", mode: "off" }]))).toEqual({ revision: 1, defaultRevision: 0 });
        expect(await store.listPersonProtection("org_a")).toEqual([row("org_a", "usr_ana", "off", 1, { offSince: AT }), row("org_a", "usr_bo", "enforce", 1)]);
        expect(await protect(opened, change("org_b", [{ userId: "usr_ana", mode: "monitor" }]))).toEqual({ revision: 1, defaultRevision: 0 });

        expect(await protect(opened, change("org_a", [{ userId: "usr_ana", mode: "monitor" }]))).toEqual({ revision: 2, defaultRevision: 0 });
        expect(await store.getPersonProtection("org_a", "usr_ana")).toEqual(row("org_a", "usr_ana", "monitor", 2, { offSince: AT, offUntil: AT }));
        expect(await store.getPersonProtection("org_a", "usr_bo")).toEqual(row("org_a", "usr_bo", "enforce", 1));

        expect(await protect(opened, change("org_a", [], ["usr_ana"]))).toEqual({ revision: 3, defaultRevision: 3 });
        expect(await store.getPersonProtection("org_a", "usr_ana")).toBeUndefined();
        expect(await protect(opened, change("org_a", [], ["usr_nobody"]))).toEqual({ revision: 4, defaultRevision: 3 });

        expect(await protect(opened, { ...change("org_a", []), clientMode: "enforce" })).toEqual({ revision: 5, defaultRevision: 5 });
        expect((await store.getSettings("org_a"))?.settings.clientMode).toBe("enforce");

        const { store: reopened } = await stores.open();
        expect(await reopened.getProtectionRevision("org_a")).toEqual({ revision: 5, defaultRevision: 5 });
        expect(await reopened.listPersonProtection("org_a")).toEqual([row("org_a", "usr_bo", "enforce", 1)]);
        expect(await reopened.listPersonProtection("org_b")).toEqual([row("org_b", "usr_ana", "monitor", 1)]);
        expect(await reopened.getProtectionRevision("org_c")).toEqual({ revision: 0, defaultRevision: 0 });
      } finally {
        await stores.close();
      }
    });

    it("keeps when each person's latest Off and the org default's latest Off began and ended", async () => {
      const stores = await opened();
      const spanOf = (found: { offSince?: string; offUntil?: string; defaultOffSince?: string; defaultOffUntil?: string } | undefined) => ({
        since: found?.offSince ?? found?.defaultOffSince,
        until: found?.offUntil ?? found?.defaultOffUntil,
      });
      try {
        let opened = await stores.open();
        let { store } = opened;
        const setAt = (at: string, set: Array<{ userId: string; mode: GuardClientMode }>, clientMode?: GuardClientMode) => protect(opened, { ...change("org_a", set), at, ...(clientMode === undefined ? {} : { clientMode }) });
        const saveDefault = (clientMode: GuardClientMode, at: string) => protect(opened, { ...change("org_a", []), at, clientMode });

        await setAt(minute(1), [{ userId: "usr_ana", mode: "off" }]);
        await setAt(minute(2), [{ userId: "usr_ana", mode: "off" }]);
        expect(spanOf(await store.getPersonProtection("org_a", "usr_ana"))).toEqual({ since: minute(1), until: undefined });
        await setAt(minute(3), [{ userId: "usr_ana", mode: "monitor" }]);
        await setAt(minute(4), [{ userId: "usr_ana", mode: "enforce" }]);
        expect(spanOf(await store.getPersonProtection("org_a", "usr_ana"))).toEqual({ since: minute(1), until: minute(3) });

        await setAt(minute(5), [], "off");
        expect(spanOf(await store.getProtectionRevision("org_a"))).toEqual({ since: minute(5), until: undefined });
        await setAt(minute(6), [{ userId: "usr_bo", mode: "monitor" }]);
        expect(spanOf(await store.getPersonProtection("org_a", "usr_bo"))).toEqual({ since: minute(5), until: minute(6) });
        expect(spanOf((await store.getProtection("org_a", "usr_cy")).revision)).toEqual({ since: minute(5), until: undefined });

        await saveDefault("enforce", minute(7));
        expect(spanOf(await store.getProtectionRevision("org_a"))).toEqual({ since: minute(5), until: minute(7) });
        await saveDefault("monitor", minute(8));
        expect(spanOf(await store.getProtectionRevision("org_a"))).toEqual({ since: minute(5), until: minute(7) });
        await setAt(minute(9), [{ userId: "usr_cy", mode: "monitor" }]);
        expect(spanOf(await store.getPersonProtection("org_a", "usr_cy"))).toEqual({ since: minute(5), until: minute(7) });
        await saveDefault("off", minute(10));

        opened = await stores.open();
        ({ store } = opened);
        expect(spanOf(await store.getProtectionRevision("org_a"))).toEqual({ since: minute(10), until: undefined });
        expect(spanOf(await store.getPersonProtection("org_a", "usr_ana"))).toEqual({ since: minute(1), until: minute(3) });
        expect(spanOf((await store.getProtection("org_a", "usr_bo")).person)).toEqual({ since: minute(5), until: minute(6) });
        expect(await store.getProtectionRevision("org_b")).toEqual({ revision: 0, defaultRevision: 0 });
      } finally {
        await stores.close();
      }
    });

    it("keeps the Off period of a person one write both sets and clears, from the row they held before it", async () => {
      const stores = await opened();
      try {
        const opened = await stores.open();
        const { store } = opened;
        await protect(opened, { ...change("org_a", [{ userId: "usr_ana", mode: "off" }]), at: minute(1) });
        await protect(opened, { ...change("org_a", [{ userId: "usr_ana", mode: "monitor" }], ["usr_ana"]), at: minute(2) });
        expect(await store.getPersonProtection("org_a", "usr_ana")).toEqual({ ...row("org_a", "usr_ana", "monitor", 2, { offSince: minute(1), offUntil: minute(2) }), setAt: minute(2) });
      } finally {
        await stores.close();
      }
    });

    it("refuses a tx after its withOrgLock returned and a copy of one, keeps a held tx on the org it locked, and writes nothing to another org", async () => {
      const stores = await opened();
      try {
        const { store, locks } = await stores.open();
        const refused = { code: "INTERNAL", detail: expect.stringContaining("withOrgLock did not make or has already released") };
        const setAnaOff = (tx: OrgLockedTx) => store.saveSettings(tx, { fallback: GuardSettings.parse({}), update: () => undefined, set: [{ userId: "usr_ana", mode: "off" }], by: "it@example.com", at: AT });
        const leaked = await locks.withOrgLock("org_a", async (tx) => tx);
        await expect(setAnaOff(leaked)).rejects.toMatchObject(refused);
        await expect(store.getOrgProtection(leaked)).rejects.toMatchObject(refused);
        await expect(store.serveSigningKey(leaked, "gdev_00000000000000c1", "gsk_leaked", AT, async () => undefined)).rejects.toMatchObject(refused);
        await locks.withOrgLock("org_b", async (tx) => {
          await expect(setAnaOff({ ...tx })).rejects.toMatchObject(refused);
          expect(() => Object.assign(tx, { orgId: "org_a" })).toThrow(TypeError);
          await setAnaOff(tx);
        });
        expect(await store.listPersonProtection("org_a")).toEqual([]);
        expect(await store.getProtectionRevision("org_a")).toEqual({ revision: 0, defaultRevision: 0 });
        expect(await store.listPersonProtection("org_b")).toEqual([row("org_b", "usr_ana", "off", 1, { offSince: AT })]);
      } finally {
        await stores.close();
      }
    });

    it("refuses a withOrgLock nested in one for the same org instead of waiting on itself, and lets another org nest", async () => {
      const stores = await opened();
      try {
        const { locks } = await stores.open();
        expect(await locks.withOrgLock("org_a", (outer) => locks.withOrgLock("org_b", async (inner) => [orgOf(outer), orgOf(inner)]))).toEqual(["org_a", "org_b"]);
        await expect(locks.withOrgLock("org_a", () => locks.withOrgLock("org_a", async () => "ran"))).rejects.toMatchObject({ code: "INTERNAL", detail: expect.stringContaining("so it would wait on itself forever") });
        expect(await locks.withOrgLock("org_a", async () => "free again")).toBe("free again");
      } finally {
        await stores.close();
      }
    });

    it("lets a task started inside a lock body take that org's lock again once the body has returned", async () => {
      const stores = await opened();
      try {
        const { locks } = await stores.open();
        let bodyReturned = (): void => undefined;
        const returned = new Promise<void>((resolve) => (bodyReturned = resolve));
        const started = await locks.withOrgLock("org_a", async () => ({ task: returned.then(() => locks.withOrgLock("org_a", async () => "took org_a again")) }));
        bodyReturned();
        expect(await started.task).toBe("took org_a again");
      } finally {
        await stores.close();
      }
    });

    it("reads a stored mode it does not know as enforce", async () => {
      const stores = await opened();
      try {
        if (stores.databaseUrl !== undefined) {
          await sqlRows(stores.databaseUrl, "ALTER TABLE guard_person_protection DROP CONSTRAINT guard_person_protection_mode_check");
          await sqlRows(stores.databaseUrl, "INSERT INTO guard_person_protection (org_id, user_id, mode, revision, set_by, set_at) VALUES ('org_a', 'usr_ana', 'strict', 7, 'it@example.com', $1)", [AT]);
        } else {
          await writeFile(path.join(required(stores.dir, "the store folder"), "guard.json"), JSON.stringify({ personProtection: [{ ...row("org_a", "usr_ana", "off", 7), mode: "strict" }] }));
        }
        const { store } = await stores.open();
        expect(await store.getPersonProtection("org_a", "usr_ana")).toEqual(row("org_a", "usr_ana", "enforce", 7));
        expect(await store.listPersonProtection("org_a")).toEqual([row("org_a", "usr_ana", "enforce", 7)]);
      } finally {
        await stores.close();
      }
    });

    it("reads an org default and a device mode it does not know as enforce", async () => {
      const stores = await opened();
      const device = { deviceId: "gdev_00000000000000c1", orgId: "org_a", personUserId: "usr_ana", personEmail: "ana@example.com", tokenSha256: "ab".repeat(32), facts: facts("ana-mbp"), status: "active" as const, clientMode: "monitor" as const, enrolledAt: AT };
      try {
        if (stores.databaseUrl !== undefined) {
          await (await stores.open()).store.insertDevice(device);
          await sqlRows(stores.databaseUrl, "ALTER TABLE guard_devices DROP CONSTRAINT guard_devices_client_mode_check");
          await sqlRows(stores.databaseUrl, "UPDATE guard_devices SET client_mode = 'strict'");
          await sqlRows(stores.databaseUrl, "INSERT INTO guard_settings (org_id, settings, updated_at, updated_by) VALUES ('org_a', $1::jsonb, $2, 'it@example.com')", [JSON.stringify({ clientMode: "strict" }), AT]);
        } else {
          await writeFile(
            path.join(required(stores.dir, "the store folder"), "guard.json"),
            JSON.stringify({ devices: [{ ...device, clientMode: "strict" }], settings: { org_a: { orgId: "org_a", settings: { clientMode: "strict" }, updatedAt: AT, updatedBy: "it@example.com" } } }),
          );
        }
        const { store, locks } = await stores.open();
        expect((await store.getSettings("org_a"))?.settings.clientMode).toBe("enforce");
        expect((await store.getProtection("org_a", "usr_ana")).settings?.settings.clientMode).toBe("enforce");
        expect((await store.getDevice("org_a", device.deviceId))?.clientMode).toBe("enforce");
        expect((await store.getDeviceForSync(device.deviceId))?.clientMode).toBe("enforce");
        expect((await store.listDevices("org_a")).map((d) => d.clientMode)).toEqual(["enforce"]);
        expect((await store.updateDevice("org_a", device.deviceId, { lastSeenAt: AT }))?.clientMode).toBe("enforce");
        const saved = await locks.withOrgLock("org_a", (tx) => store.saveSettings(tx, { fallback: GuardSettings.parse({}), update: (current) => ({ ...current, quietAfterMinutes: 45 }), by: "it@example.com", at: AT }));
        expect(saved.before.clientMode).toBe("enforce");
        expect(saved.after).toMatchObject({ clientMode: "enforce", quietAfterMinutes: 45 });
      } finally {
        await stores.close();
      }
    });
  });
}

describe.skipIf(postgresMissing())("the person protection tables in Postgres", () => {
  it("have the columns of their row schemas, and a device may now report off", async () => {
    const stores = await openPostgresStores();
    try {
      const live = await sqlRows<{ table_name: string; column_name: string }>(
        stores.databaseUrl,
        "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY table_name, ordinal_position",
        [["guard_person_protection", "guard_protection_revision"]],
      );
      const columns = (table: string) => live.filter((entry) => entry.table_name === table).map((entry) => entry.column_name).sort();
      expect(columns("guard_person_protection")).toEqual(Object.keys(GuardPersonProtectionRecord.shape).map(snake).sort());
      expect(columns("guard_protection_revision")).toEqual(["org_id", ...Object.keys(GuardProtectionRevision.shape).map(snake)].sort());

      const { store } = await stores.open();
      await store.insertDevice({
        deviceId: "gdev_00000000000000b1",
        orgId: "org_a",
        personUserId: "usr_ana",
        personEmail: "ana@example.com",
        tokenSha256: "ab".repeat(32),
        facts: facts("ana-mbp"),
        status: "active",
        clientMode: "off",
        enrolledAt: AT,
      });
      expect((await store.getDevice("org_a", "gdev_00000000000000b1"))?.clientMode).toBe("off");
      await expect(sqlRows(stores.databaseUrl, "UPDATE guard_devices SET client_mode = 'paused' WHERE device_id = 'gdev_00000000000000b1'")).rejects.toThrow(/check constraint/);
      await expect(sqlRows(stores.databaseUrl, "INSERT INTO guard_person_protection (org_id, user_id, mode, revision, set_by, set_at) VALUES ('org_a', 'usr_bo', 'paused', 1, 'x', now())")).rejects.toThrow(/check constraint/);
    } finally {
      await stores.close();
    }
  });

  it("writes the settings and the revision in one transaction, so a failed settings write moves no revision and sets no one", async () => {
    const stores = await openPostgresStores();
    try {
      const opened = await stores.open();
      const { store } = opened;
      await protect(opened, change("org_a", [{ userId: "usr_bo", mode: "enforce" }]));
      await sqlRows(stores.databaseUrl, "CREATE FUNCTION refuse_settings() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'made-up settings failure'; END $$");
      await sqlRows(stores.databaseUrl, "CREATE TRIGGER refuse_settings BEFORE INSERT OR UPDATE ON guard_settings FOR EACH ROW EXECUTE FUNCTION refuse_settings()");
      await expect(protect(opened, { ...change("org_a", [{ userId: "usr_ana", mode: "off" }], ["usr_bo"]), clientMode: "enforce" })).rejects.toThrow(/made-up settings failure/);
      expect(await store.getProtectionRevision("org_a")).toEqual({ revision: 1, defaultRevision: 0 });
      expect(await store.listPersonProtection("org_a")).toEqual([row("org_a", "usr_bo", "enforce", 1)]);
      expect(await store.getSettings("org_a")).toBeUndefined();
    } finally {
      await stores.close();
    }
  });

  it("hands each of many concurrent changes from separate servers its own revision", async () => {
    const stores = await openPostgresStores();
    try {
      const servers = await Promise.all([stores.open(), stores.open(), stores.open()]);
      const revisions = await Promise.all(Array.from({ length: 12 }, (_, i) => protect(required(servers[i % servers.length], "a store"), change("org_race", [{ userId: `usr_${i}`, mode: "enforce" }]))));
      expect(revisions.map((r) => r.revision).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
      expect(await required(servers[0], "a store").store.getProtectionRevision("org_race")).toEqual({ revision: 12, defaultRevision: 0 });
      const rows = await required(servers[1], "a store").store.listPersonProtection("org_race");
      expect(new Set(rows.map((r) => r.revision))).toEqual(new Set(revisions.map((r) => r.revision)));
    } finally {
      await stores.close();
    }
  });
});

describe("each person's protection on the sync doors", () => {
  let registry: TestRegistry;
  let owner: Person;
  let admin: Person;
  let member: Person;
  let dee: Person;

  const store = (): GuardStore => required(registry.server.service.guard, "the guard store");
  const served = (): Opened => ({ store: store(), locks: registry.server.service.orgLocks });
  const orgIdOf = (laptop: EnrolledDevice): string => laptop.enrol.orgId;
  const setMode = (laptop: EnrolledDevice, mode: GuardClientMode) => protect(served(), change(orgIdOf(laptop), [{ userId: laptop.enrol.person.userId, mode }]));
  const clearMode = (laptop: EnrolledDevice) => protect(served(), change(orgIdOf(laptop), [], [laptop.enrol.person.userId]));
  const orgDefault = async (clientMode: GuardClientMode): Promise<void> => {
    const reply = await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode });
    expect(reply.status, reply.text).toBe(200);
  };

  const preflight = async (laptop: EnrolledDevice, device: GuardDeviceFacts, extra: Record<string, unknown> = {}) => {
    const reply = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody(device.hostname, { device, ...extra }));
    expect(reply.status, reply.text).toBe(200);
    return GuardPreflightResponse.parse(reply.body);
  };
  const download = async (laptop: EnrolledDevice): Promise<SignedGuardBundle> => {
    const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
    expect(reply.status, reply.text).toBe(200);
    return required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle");
  };
  const applied = async (laptop: EnrolledDevice, device: GuardDeviceFacts) => {
    await preflight(laptop, device);
    const signed = await download(laptop);
    const post = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      bundleVersion: signed.bundle.bundleVersion,
      catalogueVersion: signed.bundle.catalogueVersion,
      rulesReceived: signed.bundle.contentRules.length,
      rulesProcessed: signed.bundle.contentRules.length,
      clientMode: signed.bundle.clientMode,
      bundleDigest: digestOf(signed.bundle),
    });
    expect(post.status, post.text).toBe(200);
    return signed;
  };
  const policyOf = async (laptop: EnrolledDevice, device: GuardDeviceFacts) => {
    const pre = await preflight(laptop, device);
    const { bundle } = await download(laptop);
    return { preflight: pre.clientMode, clientMode: bundle.clientMode, defaultMode: bundle.defaultMode, stamp: bundle.protectionRevision };
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "guard-person-protection.example" });
    ({ owner, admin, member } = registry.people);
    dee = await registry.join("dee");
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("compiles each person's own mode into their preflight and policy, over the org default, and enrols a laptop in it", async () => {
    const capable = facts("member-mbp", CAN_TURN_OFF);
    const laptop = await enrolDevice(registry, owner, member, "member-mbp", capable);
    const adminFacts = facts("admin-mbp", CAN_TURN_OFF);
    const adminLaptop = await enrolDevice(registry, owner, admin, "admin-mbp", adminFacts);
    expect(laptop.enrol.clientMode).toBe("monitor");

    const { revision } = await setMode(laptop, "enforce");
    expect(await policyOf(laptop, capable)).toEqual({ preflight: "enforce", clientMode: "enforce", defaultMode: "monitor", stamp: revision });
    expect(await policyOf(adminLaptop, adminFacts)).toEqual({ preflight: "monitor", clientMode: "monitor", defaultMode: "monitor", stamp: 0 });

    await setMode(laptop, "off");
    expect(await policyOf(laptop, capable)).toMatchObject({ preflight: "off", clientMode: "off", defaultMode: "monitor" });
    const second = await enrolDevice(registry, owner, member, "member-mini", facts("member-mini", CAN_TURN_OFF));
    expect(second.enrol.clientMode).toBe("off");
    expect((await registry.consoleGet(owner, "/guard/rules")).body).toMatchObject({ clientMode: "monitor" });
    expect((await registry.consoleGet(owner, "/guard/overview?days=7")).body).toMatchObject({ clientMode: "monitor" });

    const tested = await registry.consoleWrite(owner, "POST", "/guard/rules/test", { serviceId: "openai-chatgpt", personEmail: member.email, text: "my tfn is 123 456 782" });
    expect(tested.status, tested.text).toBe(200);
    expect(GuardRuleTestResult.parse(tested.body)).toMatchObject({ intercepted: false, verdict: "not-intercepted", enforced: false, explanation: expect.stringContaining("Guard is off for this person") });
    await clearMode(laptop);
  });

  it("never sends off to a laptop that has not said it can turn protection off: it gets monitor, and its default is raised the same way", async () => {
    const legacy = facts("dee-old-mbp");
    const old = await enrolDevice(registry, owner, dee, "dee-old-mbp", legacy);
    const capable = facts("dee-new-mbp", CAN_TURN_OFF);
    const fresh = await enrolDevice(registry, owner, dee, "dee-new-mbp", capable);
    await setMode(old, "off");
    expect(await policyOf(old, legacy)).toMatchObject({ preflight: "monitor", clientMode: "monitor", defaultMode: "monitor" });
    expect(await policyOf(fresh, capable)).toMatchObject({ preflight: "off", clientMode: "off", defaultMode: "monitor" });

    await clearMode(old);
    await orgDefault("off");
    try {
      expect(await policyOf(old, legacy)).toMatchObject({ preflight: "monitor", clientMode: "monitor", defaultMode: "monitor" });
      expect(await policyOf(fresh, capable)).toMatchObject({ preflight: "off", clientMode: "off", defaultMode: "off" });
      expect((await enrolDevice(registry, owner, dee, "dee-older-mbp")).enrol.clientMode).toBe("monitor");
      await setMode(old, "enforce");
      expect(await policyOf(old, legacy)).toMatchObject({ clientMode: "enforce", defaultMode: "monitor" });
      expect(await policyOf(fresh, capable)).toMatchObject({ clientMode: "enforce", defaultMode: "off" });
    } finally {
      await clearMode(old);
      await orgDefault("monitor");
    }
  });

  it("raises a person's stamp on every change to them, set, clear and set again, and raises the default stamp when the org default changes", async () => {
    const capable = facts("owner-mbp", CAN_TURN_OFF);
    const laptop = await enrolDevice(registry, admin, owner, "owner-mbp", capable);
    const bystanderFacts = facts("admin-mbp-2", CAN_TURN_OFF);
    const bystander = await enrolDevice(registry, owner, admin, "admin-mbp-2", bystanderFacts);
    const stamps: number[] = [];
    const bystanderStamps: number[] = [];
    const record = async () => {
      stamps.push((await policyOf(laptop, capable)).stamp);
      bystanderStamps.push((await policyOf(bystander, bystanderFacts)).stamp);
    };
    await record();
    await setMode(laptop, "enforce");
    await record();
    await clearMode(laptop);
    await record();
    await setMode(laptop, "monitor");
    await record();
    await orgDefault("enforce");
    await record();
    await orgDefault("monitor");
    for (let i = 1; i < stamps.length - 1; i += 1) expect(stamps[i], `stamp ${i} of ${JSON.stringify(stamps)}`).toBeGreaterThan(stamps[i - 1] ?? Infinity);
    expect(stamps.at(-1)).toBe(stamps.at(-2));
    expect(bystanderStamps[1]).toBe(bystanderStamps[0]);
    expect(bystanderStamps[2]).toBeGreaterThan(bystanderStamps[1] ?? Infinity);
    expect(bystanderStamps[3]).toBe(bystanderStamps[2]);
    expect(bystanderStamps[4]).toBeGreaterThan(bystanderStamps[3] ?? Infinity);
    await clearMode(laptop);
  });

  it("signs each policy valid for 72 hours, keeps an unchanged policy unchanged across preflights, and reports a change of mode", async () => {
    const capable = facts("member-air", CAN_TURN_OFF);
    const laptop = await enrolDevice(registry, owner, member, "member-air", capable);
    const signed = await applied(laptop, capable);
    const { publicKeyPem, keyId } = laptop.enrol.signing;
    const verified = verifyGuardBundle(signed, publicKeyPem, keyId, laptop.deviceId);
    if (!verified.ok) throw new Error(`the policy did not verify: ${verified.reason}`);
    expect(verified.payload.validUntil).toBe(verified.payload.iat + SEVENTY_TWO_HOURS_S);
    const payload = GuardSignaturePayload.parse(JSON.parse(Buffer.from(signed.signature.jws.split(".")[1] ?? "", "base64url").toString("utf8")));
    expect(payload.validUntil).toBe(payload.iat + SEVENTY_TWO_HOURS_S);

    const held = { bundleVersion: signed.bundle.bundleVersion, catalogueVersion: signed.bundle.catalogueVersion };
    expect(await preflight(laptop, capable, held)).toMatchObject({ rulesChanged: false, cleanSync: false });
    expect(await preflight(laptop, capable, held)).toMatchObject({ rulesChanged: false, cleanSync: false });
    const again = await download(laptop);
    expect(digestOf(again.bundle)).toBe(digestOf(signed.bundle));

    await setMode(laptop, "enforce");
    expect(await preflight(laptop, capable, held)).toMatchObject({ rulesChanged: true, clientMode: "enforce" });
    const changed = await applied(laptop, capable);
    expect(changed.bundle.protectionRevision).toBeGreaterThan(signed.bundle.protectionRevision);
    expect(await preflight(laptop, capable, { bundleVersion: changed.bundle.bundleVersion, catalogueVersion: changed.bundle.catalogueVersion })).toMatchObject({ rulesChanged: false });
    await clearMode(laptop);
  });

  it("counts what Monitor would have blocked only for people whose own mode is monitor", async () => {
    const monitored = await enrolDevice(registry, owner, admin, "admin-would");
    const enforced = await enrolDevice(registry, owner, member, "member-would");
    await setMode(enforced, "enforce");
    const at = new Date().toISOString();
    const wouldBlock = () => ({ eventId: eventId(), kind: "content", action: "observed", wouldAction: "blocked", serviceId: "openai-chatgpt", host: "chatgpt.com", ruleKind: "content", ruleId: "gcr_00000000000000b1", occurredAt: at });
    const before = (await registry.consoleGet(owner, "/guard/overview?days=7")).body as { totals: { blocked: number } };
    for (const laptop of [monitored, enforced]) {
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events: [wouldBlock()] });
      expect(up.body).toEqual({ accepted: 1, rejected: [] });
    }
    const after = (await registry.consoleGet(owner, "/guard/overview?days=7")).body as { totals: { blocked: number } };
    expect(after.totals.blocked - before.totals.blocked).toBe(1);
    await clearMode(enforced);
    const cleared = (await registry.consoleGet(owner, "/guard/overview?days=7")).body as { totals: { blocked: number } };
    expect(cleared.totals.blocked - before.totals.blocked).toBe(2);
  });

  it("counts what was blocked apart from what Monitor would have blocked or asked, each by the person's own mode", async () => {
    const watched = await enrolDevice(registry, owner, dee, "dee-split-mbp");
    const enforced = await enrolDevice(registry, owner, admin, "admin-split-mbp");
    const at = new Date().toISOString();
    const decision = (ruleId: string, action: "blocked" | "observed", wouldAction?: "blocked" | "asked") => ({
      eventId: eventId(),
      kind: "content",
      action,
      ...(wouldAction === undefined ? {} : { wouldAction }),
      serviceId: "openai-chatgpt",
      host: "chatgpt.com",
      ruleKind: "content",
      ruleId,
      occurredAt: at,
    });
    const upload = async (laptop: EnrolledDevice, events: unknown[]) => {
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events });
      expect(up.body).toEqual({ accepted: events.length, rejected: [] });
    };
    const overview = async () => GuardOverviewPage.parse((await registry.consoleGet(owner, "/guard/overview?days=7")).body);
    const chatgpt = (page: GuardOverviewPage) => page.services.find((row) => row.serviceId === "openai-chatgpt") ?? { blocked: 0, wouldBlock: 0 };
    await orgDefault("enforce");
    try {
      await setMode(watched, "monitor");
      const before = await overview();
      await upload(watched, [decision("gcr_00000000000000c1", "observed", "blocked"), decision("gcr_00000000000000c2", "observed", "asked")]);
      await upload(enforced, [decision("gcr_00000000000000c3", "blocked"), decision("gcr_00000000000000c4", "observed", "blocked"), decision("gcr_00000000000000c5", "observed", "asked")]);
      const after = await overview();
      expect(after.clientMode).toBe("enforce");
      const { totals: was } = before;
      const { totals: now } = after;
      expect({ blocked: now.blocked - was.blocked, wouldBlock: now.wouldBlock - was.wouldBlock, asked: now.asked - was.asked, wouldAsk: now.wouldAsk - was.wouldAsk }).toEqual({ blocked: 2, wouldBlock: 1, asked: 0, wouldAsk: 1 });
      expect({ blocked: chatgpt(after).blocked - chatgpt(before).blocked, wouldBlock: chatgpt(after).wouldBlock - chatgpt(before).wouldBlock }).toEqual({ blocked: 2, wouldBlock: 1 });
      const counted = new Map(after.topBlocks.map((row) => [row.ruleId, row.count] as const));
      expect(["c1", "c2", "c3", "c4", "c5"].map((id) => counted.get(`gcr_00000000000000${id}`))).toEqual([1, 1, 1, undefined, undefined]);
    } finally {
      await clearMode(watched);
      await orgDefault("monitor");
    }
  });

  it("acknowledges the events of a person whose mode is Off and stores none, even from a Mac that cannot turn off", async () => {
    const legacy = facts("member-old-mbp");
    const laptop = await enrolDevice(registry, owner, member, "member-old-mbp", legacy);
    const at = AT;
    const events = () => [
      { eventId: eventId(), kind: "content", action: "observed", wouldAction: "blocked", serviceId: "openai-chatgpt", host: "chatgpt.com", ruleKind: "content", ruleId: "gcr_00000000000000d1", occurredAt: at },
      { eventId: eventId(), kind: "flow", action: "observed", serviceId: "openai-chatgpt", host: "chatgpt.com", occurredAt: at },
    ];
    const upload = async () => (await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events: events() })).body;
    const stored = async () => GuardActivityPage.parse((await registry.consoleGet(owner, `/guard/activity?deviceId=${laptop.deviceId}`)).body).rows.length;
    await setMode(laptop, "off");
    try {
      expect(await policyOf(laptop, legacy)).toMatchObject({ clientMode: "monitor" });
      expect(await upload()).toEqual({ accepted: 2, rejected: [] });
      expect(await stored()).toBe(0);
      await setMode(laptop, "monitor");
      expect(await upload()).toEqual({ accepted: 2, rejected: [] });
      expect(await stored()).toBe(2);
    } finally {
      await clearMode(laptop);
    }
  });

  it("keeps or drops each uploaded event by the mode its person had when it happened, not when it arrives", async () => {
    const legacy = facts("admin-late-mbp");
    const laptop = await enrolDevice(registry, owner, admin, "admin-late-mbp", legacy);
    const orgId = orgIdOf(laptop);
    const event = (label: string, occurredAt: string) => ({ label, eventId: eventId(), kind: "flow", action: "blocked", serviceId: "openai-chatgpt", host: "chatgpt.com", ruleKind: "service", occurredAt });
    const sent: Array<ReturnType<typeof event>> = [];
    const upload = async (...events: Array<ReturnType<typeof event>>) => {
      sent.push(...events);
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events: events.map(({ label: _label, ...e }) => e) });
      expect(up.body).toEqual({ accepted: events.length, rejected: [] });
    };
    const kept = async () => {
      const ids = new Set(GuardActivityPage.parse((await registry.consoleGet(owner, `/guard/activity?deviceId=${laptop.deviceId}`)).body).rows.map((r) => r.eventId));
      return sent.filter((e) => ids.has(e.eventId)).map((e) => e.label);
    };
    const offAt = minute(20);
    const onAt = minute(40);
    try {
      await protect(served(), { ...change(orgId, [{ userId: admin.userId, mode: "off" }]), at: offAt });
      await upload(event("blocked before Off began", plusMs(offAt, -1)), event("seen as Off began", offAt));
      await protect(served(), { ...change(orgId, [{ userId: admin.userId, mode: "monitor" }]), at: onAt });
      await upload(event("seen during Off, sent after it", plusMs(onAt, -1)), event("seen as Monitor began", onAt));
      expect(await kept()).toEqual(["blocked before Off began", "seen as Monitor began"]);
      await clearMode(laptop);

      await orgDefault("off");
      const defaultOff = required((await store().getProtectionRevision(orgId)).defaultOffSince, "when the default went Off");
      await upload(event("blocked before the default went Off", plusMs(defaultOff, -1)), event("seen as the default went Off", defaultOff));
      await orgDefault("monitor");
      const defaultOn = required((await store().getProtectionRevision(orgId)).defaultOffUntil, "when the default left Off");
      await upload(event("seen during the default's Off, sent after it", plusMs(defaultOn, -1)), event("seen as the default left Off", defaultOn));

      expect(await kept()).toEqual(["blocked before Off began", "seen as Monitor began", "blocked before the default went Off", "seen as the default left Off"]);
    } finally {
      await clearMode(laptop);
      await orgDefault("monitor");
    }
  });

  it("tells a Mac that cannot turn off to watch an Off person without blocking anything, uninspectable TLS included", async () => {
    const legacy = facts("member-tls-mbp");
    const old = await enrolDevice(registry, owner, member, "member-tls-mbp", legacy);
    const capable = facts("member-tls-air", CAN_TURN_OFF);
    const fresh = await enrolDevice(registry, owner, member, "member-tls-air", capable);
    const policy = async (laptop: EnrolledDevice, device: GuardDeviceFacts) => {
      await preflight(laptop, device);
      const { bundle } = await download(laptop);
      return { clientMode: bundle.clientMode, unreproducibleTls: bundle.settings.unreproducibleTls };
    };
    try {
      expect(await policy(old, legacy)).toEqual({ clientMode: "monitor", unreproducibleTls: "block" });
      await setMode(old, "off");
      expect(await policy(old, legacy)).toEqual({ clientMode: "monitor", unreproducibleTls: "tunnel" });
      expect((await policy(fresh, capable)).clientMode).toBe("off");
      await clearMode(old);
      await orgDefault("off");
      expect(await policy(old, legacy)).toEqual({ clientMode: "monitor", unreproducibleTls: "tunnel" });
      await setMode(old, "monitor");
      expect(await policy(old, legacy)).toEqual({ clientMode: "monitor", unreproducibleTls: "block" });
    } finally {
      await clearMode(old);
      await orgDefault("monitor");
    }
  });

  it("says in the rule tester whose Guard is off, and what a Mac too old to turn off does instead", async () => {
    const explain = async (body: Record<string, unknown>) => {
      const tested = await registry.consoleWrite(owner, "POST", "/guard/rules/test", { serviceId: "openai-chatgpt", text: "hello", ...body });
      expect(tested.status, tested.text).toBe(200);
      return GuardRuleTestResult.parse(tested.body).explanation;
    };
    const tooOld = "On a Mac running a Guard too old to turn off, Guard watches but does not block until Guard is updated on that Mac.";
    await orgDefault("off");
    try {
      const nobody = await explain({});
      expect(nobody).toContain("The organisation default is Off");
      expect(nobody).toContain(tooOld);
      expect(nobody).not.toContain("this person");
      const named = await explain({ personEmail: dee.email });
      expect(named).toContain("Guard is off for this person");
      expect(named).toContain(tooOld);
    } finally {
      await orgDefault("monitor");
    }
  });

  it("leaves the default stamp alone when a setting other than the org default changes", async () => {
    const capable = facts("owner-quiet-mbp", CAN_TURN_OFF);
    const laptop = await enrolDevice(registry, admin, owner, "owner-quiet-mbp", capable);
    const quietBefore = GuardSettingsPage.parse((await registry.consoleGet(owner, "/guard/settings")).body).settings.quietAfterMinutes;
    const stamp = (await policyOf(laptop, capable)).stamp;
    const revision = await store().getProtectionRevision(orgIdOf(laptop));
    try {
      const saved = await registry.consoleWrite(owner, "PUT", "/guard/settings", { quietAfterMinutes: quietBefore + 15 });
      expect(saved.status, saved.text).toBe(200);
      expect((await policyOf(laptop, capable)).stamp).toBe(stamp);
      expect(await store().getProtectionRevision(orgIdOf(laptop))).toEqual(revision);
    } finally {
      await registry.consoleWrite(owner, "PUT", "/guard/settings", { quietAfterMinutes: quietBefore });
    }
  });

  it("records on each device row the mode it enrolled in", async () => {
    const modeOnRow = async (laptop: EnrolledDevice) => GuardDevicesPage.parse((await registry.consoleGet(owner, "/guard/devices")).body).rows.find((row) => row.deviceId === laptop.deviceId)?.clientMode;
    const first = await enrolDevice(registry, owner, dee, "dee-row-mbp", facts("dee-row-mbp", CAN_TURN_OFF));
    expect(await modeOnRow(first)).toBe("monitor");
    try {
      await setMode(first, "enforce");
      expect(await modeOnRow(await enrolDevice(registry, owner, dee, "dee-row-air", facts("dee-row-air", CAN_TURN_OFF)))).toBe("enforce");
      await setMode(first, "off");
      expect(await modeOnRow(await enrolDevice(registry, owner, dee, "dee-row-mini", facts("dee-row-mini", CAN_TURN_OFF)))).toBe("off");
      expect(await modeOnRow(await enrolDevice(registry, owner, dee, "dee-row-old"))).toBe("monitor");
    } finally {
      await clearMode(first);
    }
  });
});

describe.skipIf(postgresMissing())("settings and policies while another server changes them, in Postgres", () => {
  let registry: TestRegistry;
  let storage: Storage | undefined;
  let side: ReturnType<typeof createPostgresRegistryStores> | undefined;

  const databaseUrl = (): string => required(required(storage, "the captured storage").databaseUrl, "a database URL");
  const sidePool = () => required(side, "a second connection pool").pool;
  const store = (): GuardStore => required(registry.server.service.guard, "the guard store");
  const served = (): Opened => ({ store: store(), locks: registry.server.service.orgLocks });

  const waitingBehind = async (holder: number, lock: string, count: number): Promise<void> => {
    for (let tries = 0; tries < 400; tries += 1) {
      const { rows } = await sidePool().query<{ waiting: number }>(
        `WITH RECURSIVE behind(pid) AS (
           SELECT pid FROM pg_stat_activity WHERE $1::integer = ANY(pg_blocking_pids(pid))
           UNION
           SELECT waiter.pid FROM pg_stat_activity waiter JOIN behind ON behind.pid = ANY(pg_blocking_pids(waiter.pid))
         )
         SELECT count(*)::integer AS waiting FROM behind`,
        [holder],
      );
      if ((rows[0]?.waiting ?? 0) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`fewer than ${count} queries waited behind ${lock}, on it or on a query that waits on it`);
  };

  interface Held {
    sql(text: string, values: unknown[]): Promise<unknown>;
    waiting(count: number): Promise<void>;
  }

  const holding = async <T>(lock: string, started: () => Promise<T>, whileHeld: (held: Held) => Promise<void>): Promise<T> => {
    const client = await sidePool().connect();
    let work: Promise<T> | undefined;
    try {
      await client.query("BEGIN");
      await client.query(lock);
      const holder = required((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0], "the holder's backend").pid;
      work = started();
      await whileHeld({ sql: (text, values) => client.query(text, values), waiting: (count) => waitingBehind(holder, lock, count) });
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => undefined);
      await work?.catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return work;
  };

  beforeAll(async () => {
    registry = await startRegistry({ domain: "guard-protection-races.example", configure: capturingStorage((captured) => (storage = captured)) });
    side = createPostgresRegistryStores(databaseUrl());
  });

  afterAll(async () => {
    await side?.close();
    await registry?.close();
  });

  it("keeps both of two settings saves that race, so neither undoes the other's change to the org default", async () => {
    const { owner } = registry.people;
    const settings = async () => GuardSettingsPage.parse((await registry.consoleGet(owner, "/guard/settings")).body);
    const before = await settings();
    const revision = await store().getProtectionRevision(before.org.orgId);
    const saves = await holding(
      "LOCK TABLE guard_settings IN EXCLUSIVE MODE",
      async () =>
        Promise.all([
          registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: before.settings.clientMode === "enforce" ? "monitor" : "enforce" }),
          registry.consoleWrite(owner, "PUT", "/guard/settings", { quietAfterMinutes: before.settings.quietAfterMinutes + 30 }),
        ]),
      ({ waiting }) => waiting(2),
    );
    for (const save of saves) expect(save.status, save.text).toBe(200);
    const after = await settings();
    expect({ clientMode: after.settings.clientMode, quietAfterMinutes: after.settings.quietAfterMinutes }).toEqual({
      clientMode: before.settings.clientMode === "enforce" ? "monitor" : "enforce",
      quietAfterMinutes: before.settings.quietAfterMinutes + 30,
    });
    const moved = await store().getProtectionRevision(before.org.orgId);
    expect(moved.defaultRevision).toBe(revision.revision + 1);
  });

  it("hands out a policy whose mode and stamp come from one moment while another server clears the person", async () => {
    const { owner, member } = registry.people;
    const capable = facts("member-race-mbp", CAN_TURN_OFF);
    const laptop = await enrolDevice(registry, owner, member, "member-race-mbp", capable);
    const orgId = laptop.enrol.orgId;
    const download = async () => {
      const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(reply.status, reply.text).toBe(200);
      return required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle").bundle;
    };
    await protect(served(), change(orgId, [{ userId: member.userId, mode: "off" }]));
    const held = await download();
    expect(held.clientMode).toBe("off");
    const fresh = await holding("LOCK TABLE guard_person_protection IN ACCESS EXCLUSIVE MODE", download, async ({ sql, waiting }) => {
      await waiting(1);
      await sql("DELETE FROM guard_person_protection WHERE org_id = $1 AND user_id = $2", [orgId, member.userId]);
      await sql("UPDATE guard_protection_revision SET revision = revision + 1, default_revision = revision + 1 WHERE org_id = $1", [orgId]);
    });
    expect(fresh.clientMode).toBe(fresh.defaultMode);
    expect(fresh.protectionRevision).toBeGreaterThan(held.protectionRevision);
  });
});
