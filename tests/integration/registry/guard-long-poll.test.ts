import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  GUARD_API_PREFIX,
  GUARD_PROTOCOL_VERSION,
  GuardPreflightResponse,
  GuardProtectionApplied,
  GuardProtectionPreview,
  GuardRuleDownloadResponse,
  GuardWaitResponse,
  type GuardDeviceFacts,
} from "@vibtra/guard-contract";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import { createGuardWaits } from "@vibtra/registry/src/guard/long-poll.ts";
import { createPgNoticeFeed } from "@vibtra/registry/src/guard/pg-listener.ts";
import { GUARD_POLICY_CHANNEL, type GuardNoticeSink } from "@vibtra/registry/src/guard/policy-notices.ts";
import { createGuardPostgresStore } from "@vibtra/registry/src/guard/postgres-store.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createCleanup } from "../../support/cleanup.ts";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, facts, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { startPgProxy } from "./pg-proxy.ts";
import { postgresMissing, sqlRows } from "./server-options.ts";

const P = "/people/protection";
const CAN_TURN_OFF: Partial<GuardDeviceFacts> = { capabilities: { protectionOff: 1 } };
const POSTGRES = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
const REGISTRY_DIR = path.join(fileURLToPath(new URL("../../../", import.meta.url)), "apps", "registry");
const WRITES = /\b(?:insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|merge\s+into)\b/i;

interface Started {
  readonly registry: TestRegistry;
  readonly databaseUrl: string | undefined;
  readonly logs: string[];
}

interface Answer {
  readonly status: number;
  readonly answer: string | undefined;
  readonly text: string;
  readonly ms: number;
  readonly endedAt: number;
}

const cleanup = createCleanup();
afterEach(() => cleanup.run());

const start = async (name: string, options: { storage?: "file"; databaseUrl?: (url: string) => string; listen?: (url: string) => string; level?: string } = {}): Promise<Started> => {
  const logs: string[] = [];
  let databaseUrl: string | undefined;
  const registry = await startRegistry({
    domain: `${name}.example`,
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    configure: (serverOptions) => {
      const config = required(serverOptions.config, "a registry config");
      const own = config.databaseUrl;
      databaseUrl = own;
      return {
        ...serverOptions,
        logger: { stream: { write: (line: string) => void logs.push(line) }, level: options.level ?? "info" },
        config: {
          ...config,
          ...(own === undefined || options.databaseUrl === undefined ? {} : { databaseUrl: options.databaseUrl(own) }),
          ...(own === undefined || options.listen === undefined ? {} : { listenDatabaseUrl: options.listen(own) }),
        },
      };
    },
  });
  cleanup.defer(() => registry.close());
  return { registry, databaseUrl, logs };
};

const until = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> => {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(50);
  }
};

const logged = (started: Started, msg: string): Array<Record<string, unknown>> =>
  started.logs.map((line) => JSON.parse(line) as Record<string, unknown>).filter((line) => typeof line.msg === "string" && line.msg.startsWith(msg));

const longPollingOn = (started: Started): Promise<true> => until("long polling to come on", async () => (logged(started, "guard long polling is on").length > 0 ? true : undefined));

const laptopFor = (registry: TestRegistry, who: Person, hostname: string): Promise<EnrolledDevice> => enrolDevice(registry, registry.people.owner, who, hostname, facts(hostname, CAN_TURN_OFF));

const stampOf = async (registry: TestRegistry, laptop: EnrolledDevice): Promise<string> => {
  const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
  expect(reply.status, reply.text).toBe(200);
  const bundle = required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a signed bundle").bundle;
  return `${bundle.bundleVersion}.${bundle.protectionRevision ?? 0}`;
};

const waitAt = async (url: string, laptop: EnrolledDevice, stamp: string, hold = 55): Promise<Answer> => {
  const startedAt = performance.now();
  const response = await fetch(`${url}${GUARD_API_PREFIX}/sync/wait/${laptop.deviceId}?stamp=${stamp}&hold=${hold}`, { headers: { authorization: `Bearer ${laptop.token}` } });
  const text = await response.text();
  const endedAt = performance.now();
  return { status: response.status, answer: response.ok ? GuardWaitResponse.parse(JSON.parse(text)).answer : undefined, text, ms: endedAt - startedAt, endedAt };
};

const wait = (registry: TestRegistry, laptop: EnrolledDevice, stamp: string, hold = 55): Promise<Answer> => waitAt(registry.url, laptop, stamp, hold);

const pending = async <T>(promise: Promise<T>, ms = 300): Promise<boolean> => (await Promise.race([promise.then(() => false), delay(ms).then(() => true)]));

const apply = async (registry: TestRegistry, changes: unknown[]): Promise<number> => {
  const owner = registry.people.owner;
  const preview = await registry.consoleWrite(owner, "POST", `${P}/preview`, { changes });
  expect(preview.status, preview.text).toBe(200);
  const { revision, peopleDigest } = GuardProtectionPreview.parse(preview.body);
  const reply = await registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision, peopleDigest });
  expect(reply.status, reply.text).toBe(200);
  return GuardProtectionApplied.parse(reply.body).revision;
};

const saveRules = async (registry: TestRegistry): Promise<void> => {
  const owner = registry.people.owner;
  const current = await registry.consoleGet(owner, "/guard/rules");
  const baseVersion = Number((current.body as { document?: { version?: unknown } }).document?.version ?? 0);
  const saved = await registry.consoleWrite(owner, "PUT", "/guard/rules", { baseVersion, document: { defaultAction: "block", serviceRules: [], contentRules: [] } });
  expect(saved.status, saved.text).toBe(200);
};

const named = (databaseUrl: string, applicationName: string): string => {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  return url.toString();
};

const terminateBackends = (applicationName: string): Promise<unknown[]> =>
  sqlRows(POSTGRES, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = $1`, [applicationName]);

const moveDefaultWithoutNotice = (databaseUrl: string | undefined, orgId: string): Promise<unknown[]> =>
  sqlRows(required(databaseUrl, "the registry's database"), `INSERT INTO guard_protection_revision (org_id, revision, default_revision) VALUES ($1, 1, 1)
     ON CONFLICT (org_id) DO UPDATE SET revision = guard_protection_revision.revision + 1, default_revision = guard_protection_revision.revision + 1`, [orgId]);

const notifier = (afterMs = 0): { sent: Set<string>; notify(payload: string): Promise<void> } => {
  const stores = createPostgresRegistryStores(POSTGRES);
  cleanup.defer(() => stores.close());
  const sent = new Set<string>();
  return {
    sent,
    notify: async (payload) => {
      sent.add(payload);
      await stores.pool.query(`SELECT pg_notify($1, $2)`, [GUARD_POLICY_CHANNEL, payload]);
      await delay(afterMs);
    },
  };
};

const recording = (events: string[]): GuardNoticeSink => ({
  notice: () => undefined,
  live: () => void events.push("live"),
  lost: () => void events.push("lost"),
  restored: () => void events.push("restored"),
  off: () => void events.push("off"),
});

interface Served {
  readonly url: string;
  readonly exited: Promise<string>;
  signal(signal: NodeJS.Signals): void;
}

const serve = async (databaseUrl: string): Promise<Served> => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "guard-serve-"));
  cleanup.defer(() => rm(dataDir, { recursive: true, force: true }));
  const child = spawn(path.join(REGISTRY_DIR, "node_modules", ".bin", "tsx"), ["src/main.ts"], {
    cwd: REGISTRY_DIR,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH,
      ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
      HOME: dataDir,
      NODE_ENV: "test",
      PORT: "0",
      HOST: "127.0.0.1",
      VIBTRA_REGISTRY_DATA_DIR: dataDir,
      REGISTRY_MODE: "hosted",
      REGISTRY_BASE_URL: "http://registry.test.local",
      REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
      REGISTRY_OIDC_CLIENT_ID: "guard-tests-client-id.apps.example",
      REGISTRY_OIDC_CLIENT_SECRET: "guard-tests-client-secret-not-real",
      VIBTRA_VAULT_KEY: "a".repeat(64),
      DATABASE_URL: databaseUrl,
    },
  });
  let output = "";
  let ended: string | undefined;
  child.stdout.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => void (output += chunk.toString("utf8")));
  const exited = new Promise<string>((resolve) => child.once("exit", (code, signal) => resolve((ended = signal === null ? `code ${code}` : `signal ${signal}`))));
  cleanup.defer(async () => {
    if (ended === undefined && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
  });
  const url = await until(
    "the serve command to listen with long polling on",
    async () => {
      if (ended !== undefined) throw new Error(`the serve command ended (${ended}):\n${output.slice(-2000)}`);
      const listening = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1];
      return listening !== undefined && output.includes("guard long polling is on") ? listening : undefined;
    },
    90_000,
  );
  return { url, exited, signal: (signal) => void child.kill(signal) };
};

const TWINS = [
  { name: "Postgres", storage: undefined },
  { name: "JSON file", storage: "file" as const },
] as const;

for (const twin of TWINS) {
  describe.skipIf(twin.storage === undefined && postgresMissing())(`a parked wait (${twin.name})`, () => {
    it("is answered within about a second of each change that moves a person's stamp, and only for the people it moves", async () => {
      const started = await start(`long-poll-${twin.storage ?? "pg"}`, twin.storage === undefined ? {} : { storage: twin.storage });
      const { registry } = started;
      await longPollingOn(started);
      const ana = await registry.join("ana");
      const bo = await registry.join("bo");
      const anaMac = await laptopFor(registry, ana, "ana-mbp");
      const boMac = await laptopFor(registry, bo, "bo-mbp");
      const changes: ReadonlyArray<{ name: string; change(): Promise<unknown>; boMoves: boolean }> = [
        { name: "ana set to enforce", change: () => apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]), boMoves: false },
        { name: "ana cleared to the default", change: () => apply(registry, [{ userIds: [ana.userId], clear: true }]), boMoves: true },
        { name: "the default set to enforce", change: () => apply(registry, [{ default: "enforce" }]), boMoves: true },
        { name: "a rules save", change: () => saveRules(registry), boMoves: true },
        { name: "a second rules save", change: () => saveRules(registry), boMoves: true },
      ];
      const latencies: number[] = [];
      for (const step of changes) {
        const anaWait = wait(registry, anaMac, await stampOf(registry, anaMac));
        const boStamp = await stampOf(registry, boMac);
        const boWait = wait(registry, boMac, boStamp);
        expect(await pending(anaWait), `${step.name}: parked before the change`).toBe(true);
        const changedAt = performance.now();
        await step.change();
        const answered = await anaWait;
        expect([answered.status, answered.answer], step.name).toEqual([200, "changed"]);
        latencies.push(answered.endedAt - changedAt);
        expect(answered.endedAt - changedAt, `${step.name}: from the change request to the answer`).toBeLessThan(1000);
        if (step.boMoves) expect((await boWait).answer, `${step.name}: bo moved too`).toBe("changed");
        else {
          expect(await pending(boWait, 500), `${step.name}: bo's wait stays parked`).toBe(true);
          expect(await stampOf(registry, boMac), `${step.name}: bo's stamp did not move`).toBe(boStamp);
        }
      }
      console.info(`long-poll ${twin.name}: change request to wait answer, ms: ${latencies.map((ms) => ms.toFixed(0)).join(" ")}`);
    });
  });
}

describe("a wait on any store", () => {
  it("is answered with a 503 at once when the server closes, so Macs spread their reconnects", async () => {
    const { registry } = await start("long-poll-close", { storage: "file" });
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const parked = wait(registry, laptop, await stampOf(registry, laptop));
    expect(await pending(parked)).toBe(true);
    const closingAt = performance.now();
    const closed = registry.server.app.close();
    const answered = await parked;
    await closed;
    expect([answered.status, answered.answer]).toEqual([503, undefined]);
    expect(answered.endedAt - closingAt, "not held until the end of the hold").toBeLessThan(1000);
  });

  it("keeps one parked wait per Mac: a second wait from the same Mac answers the first, and another Mac's wait stays parked", async () => {
    const started = await start("long-poll-per-mac", { storage: "file" });
    const { registry } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const anaMac = await laptopFor(registry, ana, "ana-mbp");
    const anaMini = await laptopFor(registry, ana, "ana-mini");
    const stamp = await stampOf(registry, anaMac);
    const first = wait(registry, anaMac, stamp, 20);
    expect(await pending(first)).toBe(true);
    const mini = wait(registry, anaMini, await stampOf(registry, anaMini));
    expect(await pending(mini)).toBe(true);
    const secondAt = performance.now();
    const second = wait(registry, anaMac, stamp);
    const superseded = await first;
    expect([superseded.status, superseded.answer], "the earlier wait from the same Mac").toEqual([200, "unchanged"]);
    expect(superseded.endedAt - secondAt, "answered when the newer wait parks, not at the end of its hold").toBeLessThan(1000);
    expect(await pending(second), "the newer wait parks").toBe(true);
    await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    expect([(await second).answer, (await mini).answer]).toEqual(["changed", "changed"]);
  });

  it("holds a wait for at most 55 s, whatever hold the Mac asks for", { timeout: 90_000 }, async () => {
    const { registry } = await start("long-poll-cap", { storage: "file" });
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const answered = await wait(registry, laptop, await stampOf(registry, laptop), 600);
    expect([answered.status, answered.answer, Math.round(answered.ms / 1000)]).toEqual([200, "unchanged", 55]);
  });

  it("listens on GUARD_LISTEN_DATABASE_URL when it is set, and on DATABASE_URL otherwise", () => {
    const main = "postgres://guard@db.example:6432/guard";
    const direct = "postgres://guard@db.example:5432/guard";
    expect(loadRegistryConfig({ DATABASE_URL: main, GUARD_LISTEN_DATABASE_URL: ` ${direct} ` }).listenDatabaseUrl).toBe(direct);
    for (const unset of [undefined, "", "  "]) {
      expect(loadRegistryConfig({ DATABASE_URL: main, ...(unset === undefined ? {} : { GUARD_LISTEN_DATABASE_URL: unset }) }).listenDatabaseUrl, JSON.stringify(unset)).toBeUndefined();
    }
  });
});

describe.skipIf(postgresMissing())("a wait over Postgres", () => {
  it("answers at once when the stamp it carries is not the person's current one, and refuses a malformed stamp", async () => {
    const { registry } = await start("long-poll-stale");
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    for (const stamp of [held, "999.999"]) {
      const answered = await wait(registry, laptop, stamp);
      expect([answered.status, answered.answer], stamp).toEqual([200, "changed"]);
      expect(answered.ms, stamp).toBeLessThan(250);
    }
    for (const stamp of ["", "7", "7.x", "-1.0", "01.2"]) {
      expect((await wait(registry, laptop, stamp)).status, JSON.stringify(stamp)).toBe(400);
    }
  });

  it("costs only delay when a notice is missed: the wait ends unchanged and the next one carries the change", async () => {
    const started = await start("long-poll-missed");
    const { registry, databaseUrl } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    const parked = wait(registry, laptop, held, 5);
    expect(await pending(parked)).toBe(true);
    await moveDefaultWithoutNotice(databaseUrl, laptop.enrol.orgId);
    const missed = await parked;
    expect([missed.answer, Math.round(missed.ms / 1000)], "no notice was sent, so the hold runs out").toEqual(["unchanged", 5]);
    const next = await wait(registry, laptop, held, 5);
    expect([next.answer, next.ms < 250], "the next wait compares stamps and answers at once").toEqual(["changed", true]);
    expect(await stampOf(registry, laptop)).not.toBe(held);
  });

  it("lets go of a wait the Mac dropped, so the stamp it cached goes with it", async () => {
    const started = await start("long-poll-dropped", { level: "debug" });
    const { registry, databaseUrl } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    const finished = (): number => logged(started, "guard wait").length;
    const before = finished();
    const dropped = http.get(`${registry.url}${GUARD_API_PREFIX}/sync/wait/${laptop.deviceId}?stamp=${held}&hold=55`, { headers: { authorization: `Bearer ${laptop.token}` }, agent: false });
    dropped.on("error", () => undefined);
    await delay(300);
    expect(finished(), "still parked").toBe(before);
    dropped.destroy();
    await until("the server to finish the dropped wait", async () => (finished() > before ? true : undefined), 3000);
    await moveDefaultWithoutNotice(databaseUrl, laptop.enrol.orgId);
    const next = await wait(registry, laptop, held, 5);
    expect([next.answer, next.ms < 250], "the next wait reads the store, not a stamp the dropped wait kept").toEqual(["changed", true]);
  });

  it("wakes a parked wait when one change sets more people than fit in a notice", async () => {
    const started = await start("long-poll-big");
    const { registry, databaseUrl } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const parked = wait(registry, laptop, await stampOf(registry, laptop));
    expect(await pending(parked)).toBe(true);
    const stores = createPostgresRegistryStores(required(databaseUrl, "the registry's database"));
    cleanup.defer(() => stores.close());
    const people = [ana.userId, ...Array.from({ length: 299 }, (_, i) => `usr_not_a_member_${String(i).padStart(20, "0")}`)];
    await createGuardPostgresStore(stores.pool).applyProtection({ orgId: laptop.enrol.orgId, set: people.map((userId) => ({ userId, mode: "enforce" as const })), clear: [], by: "owner@example.test", at: new Date().toISOString() });
    expect((await parked).answer).toBe("changed");
  });

  it("writes nothing to Postgres while waits park and finish, and reads a person's stamp once while it is parked", async () => {
    const counter = await startPgProxy(cleanup, POSTGRES);
    const started = await start("long-poll-writes", { databaseUrl: counter.url });
    const { registry } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const bo = await registry.join("bo");
    const anaMac = await laptopFor(registry, ana, "ana-mbp");
    const anaPhone = await laptopFor(registry, ana, "ana-mini");
    const boMac = await laptopFor(registry, bo, "bo-mbp");
    const stamps = [await stampOf(registry, anaMac), await stampOf(registry, anaPhone), await stampOf(registry, boMac)] as const;
    expect(counter.statements.map((s) => s.sql), "with no GUARD_LISTEN_DATABASE_URL the listener uses DATABASE_URL").toContain("LISTEN guard_policy");
    const from = counter.statements.length;
    const first = wait(registry, anaMac, stamps[0], 5);
    expect(await pending(first)).toBe(true);
    const rest = [wait(registry, anaPhone, stamps[1], 5), wait(registry, boMac, stamps[2], 5)];
    const answers = await Promise.all([first, ...rest]);
    expect(answers.map((a) => a.answer)).toEqual(["unchanged", "unchanged", "unchanged"]);
    const during = counter.statements.slice(from).map((s) => s.sql);
    expect(during.filter((sql) => WRITES.test(sql)), "statements that write").toEqual([]);
    expect(during.filter((sql) => sql.includes("FROM guard_person_protection")).length, "one stamp read for ana, whose second wait used the parked one, and one for bo").toBe(2);
    expect(during.length, "every statement the three waits sent").toBeGreaterThan(0);
    console.info(`long-poll writes: ${during.length} statements for 3 waits, none writing: ${[...new Set(during.map((sql) => sql.replace(/\s+/g, " ").slice(0, 60)))].join(" | ")}`);
  });
});

describe.skipIf(postgresMissing())("the serve command", () => {
  it("answers a parked wait with its closing answer and exits 0 when it is told to stop with SIGTERM or SIGINT", { timeout: 240_000 }, async () => {
    const seeded = await start("long-poll-serve");
    const ana = await seeded.registry.join("ana");
    const laptop = await laptopFor(seeded.registry, ana, "ana-mbp");
    const held = await stampOf(seeded.registry, laptop);
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const served = await serve(required(seeded.databaseUrl, "the registry's database"));
      const parked = waitAt(served.url, laptop, held).then(
        (answered) => ({ status: answered.status, code: (JSON.parse(answered.text) as { code?: unknown }).code, endedAt: answered.endedAt }),
        (error: unknown) => ({ status: 0, code: `no HTTP answer: ${String((error as { cause?: unknown }).cause ?? error)}`, endedAt: performance.now() }),
      );
      expect(await pending(parked, 1500), `${signal}: the wait parks`).toBe(true);
      const signalledAt = performance.now();
      served.signal(signal);
      const answered = await parked;
      expect({ status: answered.status, code: answered.code }, signal).toEqual({ status: 503, code: "GUARD_CLOSING" });
      expect(answered.endedAt - signalledAt, `${signal}: answered as the server closes, not at the end of the hold`).toBeLessThan(5000);
      expect(await served.exited, `${signal}: how the serve command ended`).toBe("code 0");
      console.info(`long-poll serve ${signal}: closing answer ${(answered.endedAt - signalledAt).toFixed(0)} ms after the signal`);
    }
  });
});

describe.skipIf(postgresMissing())("the policy listener", () => {
  it("turns long polling off with one warning when a pooler drops LISTEN, and the check-in still delivers the change", async () => {
    const pooler = await startPgProxy(cleanup, POSTGRES, { dropListen: true });
    const started = await start("long-poll-pooler", { listen: pooler.url });
    const { registry } = started;
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    await until("waits to answer unsupported", async () => ((await wait(registry, laptop, held, 5)).answer === "unsupported" ? true : undefined));
    const refused = await wait(registry, laptop, held);
    expect([refused.answer, refused.ms < 250], "an unsupported wait answers at once").toEqual(["unsupported", true]);
    expect(pooler.statements.map((s) => s.sql)).toContain("LISTEN guard_policy");
    const warnings = logged(started, "guard long polling is off");
    expect(warnings.map((line) => line.level)).toEqual([40]);
    expect(String(warnings[0]?.msg)).toContain("GUARD_LISTEN_DATABASE_URL");

    const [bundleVersion, protectionRevision] = held.split(".").map(Number);
    const revision = await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    const checkIn = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("ana-mbp", { device: facts("ana-mbp", CAN_TURN_OFF), clientMode: "monitor", bundleVersion, protectionRevision }));
    expect(checkIn.status, checkIn.text).toBe(200);
    expect(GuardPreflightResponse.parse(checkIn.body).clientMode, "the check-in carries the new mode").toBe("enforce");
    expect(await stampOf(registry, laptop), "and the policy it downloads carries the new stamp").toBe(`${bundleVersion}.${revision}`);
  });

  it("tells parked waits to recheck once the listener is back, so a change made while it was down still arrives", async () => {
    const line = await startPgProxy(cleanup, POSTGRES);
    const listener = `guard-long-poll-${randomBytes(4).toString("hex")}`;
    const started = await start("long-poll-kill", { listen: (url) => named(line.url(url), listener) });
    const { registry } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    const parked = wait(registry, laptop, held);
    expect(await pending(parked)).toBe(true);

    line.refuse(true);
    expect((await terminateBackends(listener)).length, "the listener's backend").toBe(1);
    await until("the server to notice the listener is gone", async () => (logged(started, "guard policy listener lost").length > 0 ? true : undefined));
    await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    expect(await pending(parked, 1500), "the change's notice had no listener to reach").toBe(true);

    const backAt = performance.now();
    line.refuse(false);
    const answered = await parked;
    expect(answered.answer).toBe("recheck");
    expect(answered.endedAt - backAt, "answered soon after the listener is back, not at the end of the hold").toBeLessThan(10_000);
    expect((await wait(registry, laptop, held)).answer, "the Mac's next wait sees the change at once").toBe("changed");
  });

  it("compares every wait with the store while the listener is down, not with a stamp an earlier wait read", async () => {
    const line = await startPgProxy(cleanup, POSTGRES);
    const listener = `guard-long-poll-${randomBytes(4).toString("hex")}`;
    const started = await start("long-poll-down", { listen: (url) => named(line.url(url), listener) });
    const { registry } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const anaMac = await laptopFor(registry, ana, "ana-mbp");
    const anaMini = await laptopFor(registry, ana, "ana-mini");
    const held = await stampOf(registry, anaMac);

    line.refuse(true);
    expect((await terminateBackends(listener)).length, "the listener's backend").toBe(1);
    await until("the server to notice the listener is gone", async () => (logged(started, "guard policy listener lost").length > 0 ? true : undefined));
    const parked = wait(registry, anaMac, held);
    expect(await pending(parked), "the MacBook's wait parks while the listener is down").toBe(true);
    await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    const current = await stampOf(registry, anaMini);
    expect(current, "the change moved ana's stamp in the store").not.toBe(held);

    const stale = await Promise.race([wait(registry, anaMini, held, 5), delay(1000).then(() => undefined)]);
    expect([stale?.answer, (stale?.ms ?? Infinity) < 400], "a wait carrying the old stamp").toEqual(["changed", true]);
    expect(await pending(wait(registry, anaMini, current, 5), 800), "a wait carrying the current stamp parks").toBe(true);
  });

  it("keeps a healthy listener while the main pool is busy past the heartbeat deadline", async () => {
    const stores = createPostgresRegistryStores(POSTGRES);
    cleanup.defer(() => stores.close());
    const events: string[] = [];
    const feed = createPgNoticeFeed({
      connectionString: named(POSTGRES, `guard-long-poll-${randomBytes(4).toString("hex")}`),
      notify: (payload) => stores.pool.query(`SELECT pg_notify($1, $2)`, [GUARD_POLICY_CHANNEL, payload]),
      heartbeatMs: 300,
      heartbeatTimeoutMs: 1000,
    });
    cleanup.defer(() => feed.close());
    feed.start({ ...recording(events), notice: (notice) => void events.push(`notice ${notice.org}`) });
    await until("the listener to come live", async () => (events.includes("live") ? true : undefined));
    const connections = stores.pool.options.max ?? 10;
    await Promise.all(Array.from({ length: connections + 1 }, () => stores.pool.query(`SELECT pg_sleep(3)`)));
    await stores.pool.query(`SELECT pg_notify($1, $2)`, [GUARD_POLICY_CHANNEL, JSON.stringify({ org: "org_busy", peopleChanged: true })]);
    await until("the notice sent after the busy spell", async () => (events.includes("notice org_busy") ? true : undefined), 3000);
    expect(events, "what the feed told the waits").toEqual(["live", "notice org_busy"]);
  });

  it("keeps the listener when Postgres ends idle sessions (idle_session_timeout)", async () => {
    const events: string[] = [];
    const url = new URL(named(POSTGRES, `guard-long-poll-${randomBytes(4).toString("hex")}`));
    url.searchParams.set("options", "-c idle_session_timeout=1500");
    const feed = createPgNoticeFeed({ connectionString: url.toString(), notify: notifier().notify, heartbeatMs: 300, heartbeatTimeoutMs: 1000 });
    cleanup.defer(() => feed.close());
    feed.start(recording(events));
    await until("the listener to come live", async () => (events.includes("live") ? true : undefined));
    await delay(5000);
    expect(events, "what the feed told the waits over three idle timeouts").toEqual(["live"]);
  });

  it("turns long polling off and leaves no listener connection when the listener drops during the startup self-test", async () => {
    const line = await startPgProxy(cleanup, POSTGRES, { cutFirstAfter: "LISTEN" });
    const listener = `guard-long-poll-${randomBytes(4).toString("hex")}`;
    const events: string[] = [];
    const feed = createPgNoticeFeed({ connectionString: named(line.url(POSTGRES), listener), notify: notifier().notify });
    cleanup.defer(() => feed.close());
    feed.start(recording(events));
    await until("long polling to turn off", async () => (events.includes("off") ? true : undefined));
    await delay(2_500);
    expect(events, "what the feed told the waits").toEqual(["off"]);
    expect(line.connections(), "connections the listener opened").toBe(1);
    expect(await terminateBackends(listener), "listener backends left open").toEqual([]);
  });

  it("tells parked waits to recheck when the listener drops just after the startup test notice and comes back", async () => {
    const pings = notifier(300);
    const line = await startPgProxy(cleanup, POSTGRES, { cutFirstAfter: (notice) => pings.sent.has(notice) });
    const logs: string[] = [];
    const note = (...args: unknown[]): void => void logs.push(String(args.at(-1)));
    const waits = createGuardWaits({
      feed: createPgNoticeFeed({ connectionString: line.url(POSTGRES), notify: pings.notify }),
      load: async (_orgId, userIds) => new Map(userIds.map((userId) => [userId, { rules: 1, revision: 4 }] as const)),
      log: { info: note, warn: note },
    });
    cleanup.defer(() => waits.close());
    waits.start();
    await until("the listener to connect", async () => (line.connections() > 0 ? true : undefined));
    line.refuse(true);
    await until("long polling to come on", async () => (logs.includes("guard long polling is on") ? true : undefined));
    const parked = waits.wait({ orgId: "org_drop", userId: "ana", deviceId: "dev_ana" }, { rules: 1, revision: 4 }, 20_000, () => undefined);
    expect(await pending(parked), "parked while the listener reconnects").toBe(true);
    line.refuse(false);
    expect(await parked).toBe("recheck");
    expect(logs.filter((entry) => entry.startsWith("guard policy listener"))).toEqual([
      "guard policy listener lost; reconnecting, and Macs keep their 60 s check-in",
      "guard policy listener back; parked waits told to ask again",
    ]);
  });

  it("notices a black-holed listener within about a minute, reconnects, and tells parked waits to recheck", { timeout: 120_000 }, async () => {
    const line = await startPgProxy(cleanup, POSTGRES);
    const started = await start("long-poll-dark", { listen: line.url });
    const { registry } = started;
    await longPollingOn(started);
    const ana = await registry.join("ana");
    const laptop = await laptopFor(registry, ana, "ana-mbp");
    const held = await stampOf(registry, laptop);
    const parked = wait(registry, laptop, held);
    expect(await pending(parked)).toBe(true);

    const darkAt = performance.now();
    line.blackhole();
    await apply(registry, [{ userIds: [ana.userId], mode: "enforce" }]);
    const answered = await parked;
    const detectedMs = answered.endedAt - darkAt;
    expect(answered.answer).toBe("recheck");
    expect(detectedMs, "a 30 s heartbeat with a 10 s deadline finds it within 40 s, plus the reconnect").toBeLessThan(45_000);
    expect(logged(started, "guard policy listener lost").map((entry) => entry.reason)).toEqual(["a heartbeat notice did not come back"]);
    expect((await wait(registry, laptop, held)).answer).toBe("changed");
    console.info(`long-poll black hole: recheck ${(detectedMs / 1000).toFixed(1)} s after the listener went dark`);
  });
});
