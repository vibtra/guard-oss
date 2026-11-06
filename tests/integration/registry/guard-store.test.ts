import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GuardDevicesPage, GuardEnrolLinksPage } from "@vibtra/guard-contract";
import {
  DEVICE_COLUMNS,
  ENROL_LINK_COLUMNS,
  EVENT_COLUMNS,
  OVERRIDES_COLUMNS,
  RULES_COLUMNS,
  SETTINGS_COLUMNS,
  SIGNING_KEY_COLUMNS,
  createGuardPostgresStore,
} from "@vibtra/registry/src/guard/postgres-store.ts";
import {
  GuardDeviceRecord,
  GuardEnrolLinkRecord,
  GuardEventRecord,
  GuardOverridesRecord,
  GuardRulesRecord,
  GuardSettingsRecord,
  GuardSigningKeyRow,
  createFileGuardStore,
  type GuardStore,
} from "@vibtra/registry/src/guard/store.ts";
import type { RegistryServerOptions } from "@vibtra/registry/src/server.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { CA, agentDoor, enrolDevice, eventId, facts, mintEnrolLink, preflightBody, required } from "./guard-device.ts";
import { capturingStorage, manualClock, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

type Json = Record<string, any>;

const MIGRATIONS = fileURLToPath(new URL("../../../apps/registry/migrations/", import.meta.url));
const WOULD_ACTION_MIGRATION = "0110_guard_event_would_action.sql";
const STORE_TABLES = [
  { table: "guard_signing_keys", columns: SIGNING_KEY_COLUMNS, schema: GuardSigningKeyRow, keyOnly: ["slot"] },
  { table: "guard_enrol_links", columns: ENROL_LINK_COLUMNS, schema: GuardEnrolLinkRecord, keyOnly: [] },
  { table: "guard_devices", columns: DEVICE_COLUMNS, schema: GuardDeviceRecord, keyOnly: [] },
  { table: "guard_rules", columns: RULES_COLUMNS, schema: GuardRulesRecord, keyOnly: [] },
  { table: "guard_settings", columns: SETTINGS_COLUMNS, schema: GuardSettingsRecord, keyOnly: [] },
  { table: "guard_catalogue_overrides", columns: OVERRIDES_COLUMNS, schema: GuardOverridesRecord, keyOnly: [] },
  { table: "guard_events", columns: EVENT_COLUMNS, schema: GuardEventRecord, keyOnly: [] },
] as const;
const GUARD_TABLES = STORE_TABLES.map((entry) => entry.table);

const snake = (key: string): string => key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

const guardMigrations = async (): Promise<string> => {
  const names = (await readdir(MIGRATIONS)).filter((name) => name.endsWith(".sql") && name >= "0109_guard.sql").sort();
  return (await Promise.all(names.map((name) => readFile(path.join(MIGRATIONS, name), "utf8")))).join("\n");
};

const migratedColumns = (sql: string, table: string): string[] => {
  const head = `CREATE TABLE ${table} (`;
  const body = sql.slice(sql.indexOf(head) + head.length);
  const created = body
    .slice(0, body.indexOf("\n);"))
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0] ?? "")
    .filter((name) => /^[a-z_0-9]+$/.test(name) && !["unique", "primary", "check"].includes(name));
  const added = [...sql.matchAll(new RegExp(`ALTER TABLE ${table}\\s+ADD COLUMN ([a-z_0-9]+)`, "g"))].map((match) => match[1] ?? "");
  return [...created, ...added];
};

describe("the guard row schemas", () => {
  it.each(STORE_TABLES)("has one store column for every key of the $table row schema, and no other", ({ columns, schema, keyOnly }) => {
    expect([...keyOnly, ...Object.keys(schema.shape).map(snake)].sort()).toEqual([...columns].sort());
  });
});

describe("the guard tables in Postgres", () => {
  let storage: Storage | undefined;
  let registry: TestRegistry;

  beforeAll(async () => {
    registry = await startRegistry({ domain: "guard-tables.example", configure: capturingStorage((captured) => (storage = captured)) });
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("has exactly the columns the guard migrations declare, none named for content, an append-only event table and a capped snippet", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
    const sql = await guardMigrations();
    const live = await sqlRows<{ table_name: string; column_name: string }>(
      databaseUrl,
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ANY($1) ORDER BY table_name, ordinal_position",
      [GUARD_TABLES],
    );
    for (const { table, columns } of STORE_TABLES) {
      const declared = migratedColumns(sql, table);
      const liveColumns = live.filter((row) => row.table_name === table).map((row) => row.column_name);
      expect(declared.length, table).toBeGreaterThan(3);
      expect([table, liveColumns]).toEqual([table, declared]);
      expect([table, liveColumns]).toEqual([table, [...columns]]);
    }
    for (const row of live.filter((entry) => entry.table_name === "guard_events")) {
      expect(row.column_name).not.toMatch(/body|prompt|url|query|text|content|token|secret|password/);
    }

    const laptop = await enrolDevice(registry, registry.people.owner, registry.people.member, "member-tables");
    const kept = eventId();
    const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [{ eventId: kept, occurredAt: new Date().toISOString(), kind: "agent", action: "observed" }],
    });
    expect(up.body).toEqual({ accepted: 1, rejected: [] });
    await expect(sqlRows(databaseUrl, "UPDATE guard_events SET reason = 'edited' WHERE event_id = $1", [kept])).rejects.toThrow();
    await expect(sqlRows(databaseUrl, "DELETE FROM guard_events WHERE event_id = $1", [kept])).rejects.toThrow();
    await expect(
      sqlRows(
        databaseUrl,
        "INSERT INTO guard_events (org_id, event_id, device_id, person_user_id, person_email, occurred_at, received_at, kind, action, snippet) SELECT org_id, $1, device_id, person_user_id, person_email, occurred_at, received_at, kind, action, $2 FROM guard_events WHERE event_id = $3",
        [eventId(), "*".repeat(81), kept],
      ),
    ).rejects.toThrow(/check constraint/);
    expect(await sqlRows(databaseUrl, "SELECT event_id FROM guard_events WHERE event_id = $1 AND reason IS NULL", [kept])).toHaveLength(1);
  });

  it("adds would_action to a populated event table without touching a row, checks its values, and keeps the table append-only", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    const shared = required(process.env.VIBTRA_TEST_DATABASE_URL, "VIBTRA_TEST_DATABASE_URL");
    const schema = `guard_mig_${randomBytes(6).toString("hex")}`;
    await sqlRows(shared, `CREATE SCHEMA ${schema}`);
    const databaseUrl = `${shared}${shared.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
    try {
      const migrate = async (): Promise<void> => {
        const stores = createPostgresRegistryStores(databaseUrl);
        try {
          await stores.migrate();
        } finally {
          await stores.close();
        }
      };
      await migrate();
      await sqlRows(databaseUrl, "ALTER TABLE guard_events DROP COLUMN would_action");
      await sqlRows(databaseUrl, "DELETE FROM registry_migrations WHERE name = $1", [WOULD_ACTION_MIGRATION]);
      await sqlRows(
        databaseUrl,
        `INSERT INTO guard_events (org_id, event_id, device_id, person_user_id, person_email, occurred_at, received_at, kind, action, service_id, rule_kind, app, reason)
         SELECT 'org_mig', 'gev_' || lpad(to_hex(n), 16, '0'), 'gdev_mig', 'usr_mig', 'mig@example.com', now() - n * interval '1 minute', now(),
           (ARRAY['flow', 'content', 'agent'])[1 + n % 3], (ARRAY['observed', 'blocked', 'asked', 'allowed'])[1 + n % 4],
           CASE WHEN n % 2 = 0 THEN 'openai-chatgpt' END, CASE WHEN n % 4 IN (1, 2) THEN 'service' END,
           CASE WHEN n % 5 = 0 THEN '{"name":"Google Chrome"}'::jsonb END, CASE WHEN n % 7 = 0 THEN 'started' END
         FROM generate_series(1, 1000) AS n`,
      );
      const before = await sqlRows<Json>(databaseUrl, "SELECT * FROM guard_events ORDER BY event_id");
      expect(before).toHaveLength(1000);

      await migrate();
      expect(await sqlRows(databaseUrl, "SELECT name FROM registry_migrations WHERE name = $1", [WOULD_ACTION_MIGRATION])).toHaveLength(1);
      const after = await sqlRows<Json>(databaseUrl, "SELECT * FROM guard_events ORDER BY event_id");
      expect(after.map(({ would_action: _added, ...row }) => row)).toEqual(before);
      expect(after.every((row) => row.would_action === null)).toBe(true);

      const copy = (id: string, wouldAction: string) =>
        sqlRows(
          databaseUrl,
          "INSERT INTO guard_events (org_id, event_id, device_id, person_user_id, person_email, occurred_at, received_at, kind, action, would_action) SELECT org_id, $1, device_id, person_user_id, person_email, occurred_at, received_at, kind, 'observed', $2 FROM guard_events WHERE event_id = $3",
          [id, wouldAction, before[0]?.event_id],
        );
      await copy("gev_aaaaaaaaaaaaaaa1", "blocked");
      await copy("gev_aaaaaaaaaaaaaaa2", "asked");
      await expect(copy("gev_aaaaaaaaaaaaaaa3", "allowed")).rejects.toThrow(/check constraint/);
      expect(await sqlRows(databaseUrl, "SELECT event_id, would_action FROM guard_events WHERE would_action IS NOT NULL ORDER BY event_id")).toEqual([
        { event_id: "gev_aaaaaaaaaaaaaaa1", would_action: "blocked" },
        { event_id: "gev_aaaaaaaaaaaaaaa2", would_action: "asked" },
      ]);
      await expect(sqlRows(databaseUrl, "UPDATE guard_events SET would_action = 'blocked' WHERE event_id = $1", [before[0]?.event_id])).rejects.toThrow(/append-only table: UPDATE on guard_events/);
      await expect(sqlRows(databaseUrl, "DELETE FROM guard_events WHERE event_id = $1", [before[0]?.event_id])).rejects.toThrow(/append-only table: DELETE on guard_events/);
      expect(await sqlRows(databaseUrl, "SELECT count(*)::int AS n FROM guard_events WHERE would_action IS NULL")).toEqual([{ n: 1000 }]);
    } finally {
      await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});

const TWINS = [
  { name: "JSON file", slug: "json", postgres: false },
  { name: "Postgres", slug: "pg", postgres: true },
] as const;

interface OpenedStores {
  open(): Promise<GuardStore>;
  close(): Promise<void>;
}

const openFileStores = async (): Promise<OpenedStores> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-store-direct-"));
  return { open: () => createFileGuardStore(path.join(dir, "guard.json")), close: () => rm(dir, { recursive: true, force: true }) };
};

const openPostgresStores = async (): Promise<OpenedStores & { readonly databaseUrl: string }> => {
  const shared = required(process.env.VIBTRA_TEST_DATABASE_URL, "VIBTRA_TEST_DATABASE_URL");
  const schema = `guard_store_direct_${randomBytes(6).toString("hex")}`;
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
      return createGuardPostgresStore(stores.pool);
    },
    close: async () => {
      await Promise.all(pools.map((stores) => stores.close()));
      await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    },
  };
};

const PEM = `-----BEGIN PUBLIC KEY-----\n${"M".repeat(120)}\n-----END PUBLIC KEY-----\n`;
const signingKey = (n: number): GuardSigningKeyRow => ({
  keyId: `gk_${n.toString(16).padStart(8, "0")}`,
  publicKeyPem: PEM.replace("MMMM", `MM${n}M`),
  sealedPrivateKey: `made-up-sealed-key-${n}`,
  createdAt: new Date(Date.UTC(2026, 9, 16, 9, 0, n)).toISOString(),
});

for (const twin of TWINS) {
  describe.skipIf(twin.postgres && postgresMissing())(`the guard store opened directly (${twin.name})`, () => {
    it("keeps the first signing key when a second key is put, and for a second store opened on the same data", async () => {
      const stores = twin.postgres ? await openPostgresStores() : await openFileStores();
      try {
        const store = await stores.open();
        expect(await store.getSigningKey()).toBeUndefined();
        const first = await store.putSigningKeyIfAbsent(signingKey(1));
        expect(first).toEqual(signingKey(1));
        expect(await store.putSigningKeyIfAbsent(signingKey(2))).toEqual(first);
        expect(await store.getSigningKey()).toEqual(first);
        const reopened = await stores.open();
        expect(await reopened.putSigningKeyIfAbsent(signingKey(3))).toEqual(first);
        expect(await reopened.getSigningKey()).toEqual(first);
      } finally {
        await stores.close();
      }
    });

    if (twin.postgres) {
      it("gives every racing first writer the same key and stores one row", async () => {
        const stores = await openPostgresStores();
        try {
          for (let round = 0; round < 5; round += 1) {
            await sqlRows(stores.databaseUrl, "DELETE FROM guard_signing_keys");
            const racers = await Promise.all([stores.open(), stores.open(), stores.open()]);
            const keys = await Promise.all(racers.map((store, index) => store.putSigningKeyIfAbsent(signingKey(10 * round + index + 1))));
            expect(new Set(keys.map((key) => key.keyId)).size, `round ${round}`).toBe(1);
            expect(keys.every((key) => key.publicKeyPem === keys[0]?.publicKeyPem)).toBe(true);
            expect(await sqlRows(stores.databaseUrl, "SELECT key_id FROM guard_signing_keys")).toEqual([{ key_id: keys[0]?.keyId }]);
          }
        } finally {
          await stores.close();
        }
      });
    }
  });
}

const withStore = (options: RegistryServerOptions, postgres: boolean, databaseUrl?: string): RegistryServerOptions => {
  const { databaseUrl: ownUrl, ...config } = required(options.config, "a configuration");
  return { ...options, config: postgres ? { ...config, databaseUrl: required(databaseUrl ?? ownUrl, "a database URL") } : config };
};

for (const twin of TWINS) {
  describe.skipIf(twin.postgres && postgresMissing())(`the guard store behind the doors (${twin.name})`, () => {
    const clock = manualClock();
    let storage: Storage | undefined;
    let registry: TestRegistry;

    beforeAll(async () => {
      registry = await startRegistry({
        domain: `guard-store-${twin.slug}.example`,
        configure: capturingStorage((captured) => (storage = captured), (options) => ({ ...withStore(options, twin.postgres), clock })),
      });
    });

    afterAll(async () => {
      await registry?.close();
    });

    it("keeps the first signing key for concurrent first enrolments and for a second server on the same store", async () => {
      const { owner, admin, member } = registry.people;
      const laptops = await Promise.all([
        enrolDevice(registry, owner, member, "member-key-1"),
        enrolDevice(registry, owner, admin, "admin-key-1"),
        enrolDevice(registry, admin, owner, "owner-key-1"),
      ]);
      const keyIds = new Set(laptops.map((laptop) => laptop.enrol.signing.keyId));
      expect(keyIds.size).toBe(1);
      const keyId = laptops[0]?.enrol.signing.keyId;

      const shared = required(storage, "the captured storage");
      const second = await startRegistry({
        domain: `guard-store-${twin.slug}-second.example`,
        configure: (options) => ({ ...withStore(options, twin.postgres, shared.databaseUrl), dataDir: shared.dataDir }),
      });
      try {
        const other = await enrolDevice(second, second.people.owner, second.people.member, "second-server");
        expect(other.enrol.signing.keyId).toBe(keyId);
        expect(other.enrol.signing.publicKeyPem).toBe(laptops[0]?.enrol.signing.publicKeyPem);
      } finally {
        await second.close();
      }
    });

    it("consumes an enrol link once, refuses it from the instant it expires, and lists links per organisation", async () => {
      const { owner, member } = registry.people;
      const late = await mintEnrolLink(registry, owner, member, { note: "Made-up late laptop" });
      const onTime = await mintEnrolLink(registry, owner, member, { note: "Made-up on-time laptop" });
      const enrol = (token: string, hostname: string) =>
        agentDoor(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: token, device: facts(hostname), ca: CA });

      clock.set(new Date(new Date(onTime.expiresAt).getTime() - 1).toISOString());
      const first = await enrol(onTime.token, "member-on-time");
      expect(first.status, first.text).toBe(201);
      const replay = await enrol(onTime.token, "member-replay");
      expect([replay.status, (replay.body as Json).code]).toEqual([400, "GUARD_ENROL_TOKEN_INVALID"]);
      clock.set(late.expiresAt);
      const expired = await enrol(late.token, "member-late");
      expect([expired.status, (expired.body as Json).code]).toEqual([400, "GUARD_ENROL_TOKEN_INVALID"]);

      const links = GuardEnrolLinksPage.parse((await registry.consoleGet(owner, "/guard/devices/enrol-links")).body).rows;
      expect(links.find((row) => row.note === "Made-up on-time laptop")).toMatchObject({ usedByDevice: (first.body as Json).deviceId });
      expect(links.find((row) => row.note === "Made-up late laptop")?.usedByDevice).toBeUndefined();
      const outsider = await registry.join("olive", `guard-store-${twin.slug}-other.example`);
      const foreign = await registry.consoleGet(outsider, "/guard/devices/enrol-links");
      expect(foreign.status, foreign.text).toBe(200);
      expect(GuardEnrolLinksPage.parse(foreign.body).rows).toEqual([]);
    });

    it("keeps devices per organisation and patches the health and bundle a laptop reports", async () => {
      const { owner, member } = registry.people;
      const laptop = await enrolDevice(registry, owner, member, "member-health");
      const pre = await agentDoor(
        registry,
        "POST",
        `/preflight/${laptop.deviceId}`,
        laptop.token,
        preflightBody("member-health", { health: { caTrusted: true, proxyListening: true, extensionActive: false, uptimeSeconds: 5 } }),
      );
      expect(pre.status, pre.text).toBe(200);
      const post = await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
        protocol: GUARD_PROTOCOL_VERSION,
        bundleVersion: 3,
        catalogueVersion: "made-up-catalogue",
        rulesReceived: 0,
        rulesProcessed: 0,
        clientMode: "enforce",
        bundleDigest: "b".repeat(64),
      });
      expect(post.status, post.text).toBe(200);
      const row = GuardDevicesPage.parse((await registry.consoleGet(owner, "/guard/devices")).body).rows.find((device) => device.deviceId === laptop.deviceId);
      expect(row).toMatchObject({
        bundleVersion: 3,
        bundleDigest: "b".repeat(64),
        clientMode: "enforce",
        health: { caTrusted: true, proxyListening: true, extensionActive: false },
        lastPostflightAt: clock.now().toISOString(),
      });
      const outsider = await registry.join("pia", `guard-store-${twin.slug}-third.example`);
      const foreign = GuardDevicesPage.parse((await registry.consoleGet(outsider, "/guard/devices")).body).rows;
      expect(foreign.some((device) => device.deviceId === laptop.deviceId)).toBe(false);
      expect((await registry.consoleGet(outsider, "/guard/settings")).body).toMatchObject({ settings: { clientMode: "monitor" } });
    });

    it("carries the model health a laptop reports to the console, rejects unknown model keys, and still accepts agents without it", async () => {
      const { owner, member } = registry.people;
      const laptop = await enrolDevice(registry, owner, member, "member-model-health");
      const send = (health: Json) => agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-model-health", { health }));
      const model = { phase: "downloading", progress: 0.5, reason: "http_503", since: "2026-01-01T00:00:00.000Z", retryAt: "2026-01-01T11:05:00+11:00", manifest: "m1" };
      const rowOf = async () => GuardDevicesPage.parse((await registry.consoleGet(owner, "/guard/devices")).body).rows.find((device) => device.deviceId === laptop.deviceId);

      const old = await send({ caTrusted: true });
      expect(old.status, old.text).toBe(200);
      expect((await rowOf())?.health).toEqual({ caTrusted: true });

      const bad = await send({ caTrusted: true, model: { ...model, surprise: 1 } });
      expect(bad.status).toBe(400);
      expect((await send({ model: { phase: "nope" } })).status).toBe(400);
      expect((await send({ model: { phase: "failed", reason: "http_99" } })).status).toBe(400);
      expect((await send({ model: { phase: "downloading", progress: 1.5 } })).status).toBe(400);
      expect((await rowOf())?.health).toEqual({ caTrusted: true });

      const ok = await send({ caTrusted: true, model });
      expect(ok.status, ok.text).toBe(200);
      expect((await rowOf())?.health).toEqual({ caTrusted: true, model });
    });

    it("carries whether a laptop intercepts, and why not, to the console, refuses a bad shape by VALIDATION, and still accepts agents without it", async () => {
      const { owner, member } = registry.people;
      const laptop = await enrolDevice(registry, owner, member, "member-interception");
      const send = (health: Json) => agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("member-interception", { health }));
      const rowOf = async () => GuardDevicesPage.parse((await registry.consoleGet(owner, "/guard/devices")).body).rows.find((device) => device.deviceId === laptop.deviceId);

      const off = { on: false, reason: "no-secure-enclave" };
      const reported = await send({ caTrusted: false, interception: off });
      expect(reported.status, reported.text).toBe(200);
      expect((await rowOf())?.health).toEqual({ caTrusted: false, interception: off });

      for (const interception of [{ on: true, reason: "awaiting-trust" }, { on: false }, { on: false, reason: "made-up" }, { ...off, detail: "made-up" }, { on: "no" }]) {
        const bad = await send({ caTrusted: true, interception });
        expect([bad.status, bad.body], JSON.stringify(interception)).toEqual([400, expect.objectContaining({ code: "VALIDATION" })]);
      }
      expect((await rowOf())?.health).toEqual({ caTrusted: false, interception: off });

      const on = await send({ caTrusted: true, interception: { on: true } });
      expect(on.status, on.text).toBe(200);
      expect((await rowOf())?.health).toEqual({ caTrusted: true, interception: { on: true } });

      const old = await send({ caTrusted: true });
      expect(old.status, old.text).toBe(200);
      expect((await rowOf())?.health).toEqual({ caTrusted: true });
    });

    it("applies every concurrent catalogue change without losing one, and keeps the last settings write", async () => {
      const { owner, admin } = registry.people;
      const services = ["perplexity", "deepseek", "xai-grok", "google-gemini", "anthropic-claude"];
      const replies = await Promise.all(services.map((serviceId) => registry.consoleWrite(owner, "PUT", `/guard/services/${serviceId}`, { enabled: false })));
      const applied = services.filter((_serviceId, index) => replies[index]?.status === 200);
      for (const reply of replies) expect([200, 409], reply.text).toContain(reply.status);
      const page = (await registry.consoleGet(owner, "/guard/services")).body as Json;
      const off = (page.rows as Json[]).filter((row) => services.includes(row.serviceId) && row.enabled === false).map((row) => row.serviceId);
      expect(off.sort()).toEqual([...applied].sort());
      expect(page.catalogueVersion).toMatch(new RegExp(`\\+org\\.${applied.length}$`));

      expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: "enforce" })).status).toBe(200);
      expect((await registry.consoleWrite(admin, "PUT", "/guard/settings", { clientMode: "monitor" })).status).toBe(200);
      expect((await registry.consoleGet(owner, "/guard/settings")).body).toMatchObject({ settings: { clientMode: "monitor" } });
    });

    it("pages events that share an instant by event id, with no row twice and none skipped", async () => {
      const { owner, admin } = registry.people;
      const laptop = await enrolDevice(registry, owner, admin, "admin-paging");
      const occurredAt = clock.now().toISOString();
      const ids = Array.from({ length: 5 }, () => eventId());
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
        protocol: GUARD_PROTOCOL_VERSION,
        events: ids.map((id) => ({ eventId: id, occurredAt, kind: "flow", action: "observed", serviceId: "openai-chatgpt", host: "chatgpt.com" })),
      });
      expect(up.body).toEqual({ accepted: 5, rejected: [] });
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const query = `/guard/activity?deviceId=${laptop.deviceId}&limit=2${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page = (await registry.consoleGet(owner, query)).body as { rows: Array<{ eventId: string }>; nextCursor?: string };
        seen.push(...page.rows.map((row) => row.eventId));
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      expect(seen).toEqual([...ids].sort().reverse());
    });
  });
}
