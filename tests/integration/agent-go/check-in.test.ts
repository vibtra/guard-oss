import { readFile, writeFile } from "node:fs/promises";
import { GuardDeviceFacts, GuardPreflightRequest } from "@vibtra/guard-contract";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { startCaSigner } from "../../fakes/ca-signer.ts";
import { startFakeSecurity } from "../../fakes/security.ts";
import { bundleDocument, catalogueDocument, createProfile, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, startOrigin, tempDir, waitUntil, type FakeRegistry, type Json, type PolicySigner, type RegistryCall } from "./harness.ts";
import { createRelaySigner, local, policyProfile, rawExchange, record, startRunning, useAgentSuite, viaProxy, writeRelayPin, type Running } from "./running.ts";

const suite = useAgentSuite();
const HOUR_S = 3600;
const now = (): number => Math.floor(Date.now() / 1000);
const PREFLIGHT_MESSAGE = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)";

interface CheckIn {
  readonly at: number;
  readonly call: RegistryCall;
}

const quietPreflight = (signer: PolicySigner): Json => ({ clientMode: "enforce", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: false, catalogueChanged: false, signingKeyId: signer.keyId });

const checkIns = (registry: FakeRegistry, signer: PolicySigner, answer: (call: RegistryCall) => Promise<Json | undefined> = async () => undefined): CheckIn[] => {
  const seen: CheckIn[] = [];
  registry.override(async (call) => {
    if (call.door !== "preflight") return undefined;
    seen.push({ at: performance.now(), call });
    const refusal = await answer(call);
    return refusal === undefined ? { status: 200, body: quietPreflight(signer) } : { status: 503, body: refusal };
  });
  return seen;
};

const healthOf = (checkIn: CheckIn | undefined): Json | undefined => {
  const health = record(checkIn?.call.body).health;
  return health === undefined ? undefined : record(health);
};

const count = (seen: readonly CheckIn[], n: number, timeoutMs = 20_000): Promise<CheckIn> =>
  waitUntil(`check-in ${n}`, async () => seen[n - 1], timeoutMs);

const RELAY = createRelaySigner();
const HEALTH = "PROXY UNKNOWN vibtra-health\r\n";
const HEALTH_OFF = "PROXY UNKNOWN vibtra-health off\r\n";
const probe = (agent: Running, line = HEALTH): Promise<Buffer> => rawExchange(agent.transparentPort, Buffer.concat([Buffer.from(line), RELAY.line(line, { signingId: "", teamId: "" }).line]), { until: (bytes) => bytes.includes(0x0a) });
const steeringExtension = (agent: Running): { say(line: string): void } => {
  let line = HEALTH;
  const timer = setInterval(() => void probe(agent, line).catch(() => undefined), 500);
  suite.cleanup.defer(async () => clearInterval(timer));
  return {
    say: (next) => {
      line = next;
    },
  };
};
const relayPinned = async (...args: Parameters<typeof policyProfile>) => {
  const profile = await policyProfile(...args);
  await writeRelayPin(profile, RELAY);
  return profile;
};

const clockFile = async (): Promise<{ file: string; jump(seconds: number): Promise<void> }> => {
  const file = path.join(await tempDir(suite.cleanup, "clock"), "skew");
  return { file, jump: (seconds) => writeFile(file, String(seconds)) };
};

describe("the heartbeat in each check-in", () => {
  const heldBy = async (bundle: Json, validUntil?: number) => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.override((call) => (call.door === "preflight" ? { status: 200, body: quietPreflight(signer) } : undefined));
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null });
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { bundleVersion: 7, ...bundle }), { iat: now() - HOUR_S, ...(validUntil === undefined ? {} : { validUntil }) })));
    return { registry, profile };
  };
  const preflights = (registry: FakeRegistry): Json[] => registry.calls.filter((call) => call.door === "preflight").map((call) => record(call.body));

  it("names the version, protection revision and mode it applies", async () => {
    for (const item of [
      { name: "in date", bundle: { clientMode: "monitor", defaultMode: "enforce", protectionRevision: 4 }, validUntil: now() + 48 * HOUR_S, mode: "monitor" },
      { name: "past its expiry", bundle: { clientMode: "off", defaultMode: "enforce", protectionRevision: 4 }, validUntil: now() - 60, mode: "enforce" },
    ]) {
      const { registry, profile } = await heldBy(item.bundle, item.validUntil);
      const synced = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
      expect(synced.code, synced.stderr).toBe(0);
      const [heartbeat] = preflights(registry);
      expect([heartbeat?.bundleVersion, heartbeat?.protectionRevision, heartbeat?.clientMode], item.name).toEqual([7, 4, item.mode]);
      expect(GuardPreflightRequest.safeParse(heartbeat).success, item.name).toBe(true);
    }
  });

  it("leaves the revision out for a registry that refuses it, and for nothing else", async () => {
    for (const item of [
      { name: "the older registry", detail: "(root): Unrecognized key(s) in object: 'protectionRevision'", retries: true },
      { name: "another key", detail: "(root): Unrecognized key(s) in object: 'protectionRevision', 'other'", retries: false },
    ]) {
      const { registry, profile } = await heldBy({ protectionRevision: 4 });
      registry.override((call) => {
        if (call.door !== "preflight") return undefined;
        return "protectionRevision" in record(call.body) ? { status: 400, body: { code: "VALIDATION", message: PREFLIGHT_MESSAGE, detail: item.detail } } : { status: 200, body: { clientMode: "enforce", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: false, catalogueChanged: false, signingKeyId: profile.signer.keyId } };
      });
      const synced = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
      const sent = preflights(registry);
      expect([synced.code === 0, sent.map((body) => "protectionRevision" in body)], item.name).toEqual(item.retries ? [true, [true, false]] : [false, [true]]);
      if (item.retries) expect({ ...sent[1], protectionRevision: 4 }).toEqual(sent[0]);
    }
  });

  it("leaves out the revision and the Off capability in one retry when an older registry refuses both at once", async () => {
    const older = GuardPreflightRequest.omit({ protectionRevision: true }).extend({ device: GuardDeviceFacts.extend({ capabilities: GuardDeviceFacts.shape.capabilities.unwrap().omit({ protectionOff: true }).optional() }) });
    const detailOf = (body: unknown): string | undefined => {
      const result = older.safeParse(body);
      return result.success ? undefined : result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ");
    };
    const { registry, profile } = await heldBy({ protectionRevision: 4 });
    registry.override((call) => {
      if (call.door !== "preflight") return undefined;
      const detail = detailOf(call.body);
      return detail === undefined ? { status: 200, body: quietPreflight(profile.signer) } : { status: 400, body: { code: "VALIDATION", message: PREFLIGHT_MESSAGE, detail } };
    });
    const synced = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
    expect(synced.code, synced.stderr).toBe(0);
    const sent = preflights(registry);
    expect(sent.map(detailOf)[0]?.split("; ").sort()).toEqual(["(root): Unrecognized key(s) in object: 'protectionRevision'", "device.capabilities: Unrecognized key(s) in object: 'protectionOff'"]);
    expect(sent.map(detailOf).slice(1), "one retry, accepted").toEqual([undefined]);
    const device = record(sent[1]?.device);
    expect({ ...sent[1], protectionRevision: 4, device: { ...device, capabilities: { ...record(device.capabilities), protectionOff: 1 } } }, "nothing else left out").toEqual(sent[0]);
  });

  it("leaves the revision out when the policy carries none", async () => {
    const { registry, profile } = await heldBy({});
    expect((await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir })).code).toBe(0);
    expect(Object.keys(preflights(registry)[0] ?? {})).not.toContain("protectionRevision");
  });
});

describe("the health snapshot in each check-in", () => {
  it("sends its full health at start, on a change, after a failed check-in and once a period, and leaves it out otherwise", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let refuseNext = false;
    const seen = checkIns(registry, signer, async () => {
      if (!refuseNext) return undefined;
      refuseNext = false;
      return { code: "UNAVAILABLE", message: "the registry is restarting" };
    });
    const agent = await startRunning(suite, await relayPinned(suite, { signer, serverUrl: registry.url }), { transparent: true, env: { VIBTRA_GUARD_TEST_HEALTH_EVERY: "5s" } });
    const start = await count(seen, 1);
    expect(healthOf(start), "at start").toMatchObject({ proxyListening: true, extensionActive: false });
    await count(seen, 4);
    expect(seen.slice(1, 4).map(healthOf), "nothing changed, and the uptime alone is no change").toEqual([undefined, undefined, undefined]);

    const resent = await waitUntil("health sent again with nothing changed", async () => seen.slice(1).find((checkIn) => healthOf(checkIn) !== undefined));
    expect((resent.at - start.at) / 1000, "once the 5 s period is over").toBeGreaterThan(4.9);
    expect((resent.at - start.at) / 1000).toBeLessThan(7);
    expect({ ...healthOf(resent), uptimeSeconds: 0 }).toEqual({ ...healthOf(start), uptimeSeconds: 0 });

    refuseNext = true;
    const failed = seen.length + 1;
    await count(seen, failed + 1);
    expect(healthOf(seen[failed - 1]), "the refused check-in").toBeUndefined();
    expect(healthOf(seen[failed]), "the check-in after a failed one").toMatchObject({ extensionActive: false });

    await count(seen, failed + 2);
    const before = seen.length;
    await probe(agent);
    const changed = await waitUntil("health after the extension probed", async () => seen.slice(before).find((checkIn) => healthOf(checkIn) !== undefined), 5000);
    expect(healthOf(changed)?.extensionActive).toBe(true);
    expect((changed.at - (seen[failed]?.at ?? 0)) / 1000, "sooner than the period").toBeLessThan(4.9);
  });
});

describe("when the agent checks in", () => {
  it("waits a random 0.8 to 1.0 of the interval between check-ins, so no wait passes the interval", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const doors: { door: string; at: number }[] = [];
    registry.override((call) => {
      if (call.door !== "preflight" && call.door !== "postflight") return undefined;
      doors.push({ door: call.door, at: performance.now() });
      return call.door === "preflight" ? { status: 200, body: quietPreflight(signer) } : undefined;
    });
    await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }));
    await waitUntil("21 check-ins", async () => (doors.filter((d) => d.door === "preflight").length >= 21 ? true : undefined), 60_000);
    const waits = doors.flatMap((d, i) => (d.door === "preflight" && doors[i - 1]?.door === "postflight" ? [(d.at - (doors[i - 1]?.at ?? 0)) / 1000] : [])).slice(0, 20);
    const mean = waits.reduce((sum, wait) => sum + wait, 0) / waits.length;
    const shown = `waits ${waits.map((wait) => wait.toFixed(2)).join(" ")}`;
    expect(waits.length, shown).toBe(20);
    expect(Math.max(...waits) - Math.min(...waits), shown).toBeGreaterThan(0.1);
    expect(mean, `${shown}: the mean sits at nine tenths of the 1 s interval`).toBeGreaterThan(0.84);
    expect(mean, shown).toBeLessThan(0.97);
    expect(waits.filter((wait) => wait < 1).length, `${shown}: the agent schedules every wait inside the interval, so at least 15 of 20 land under 1 s even when a loaded runner adds delivery time to a few`).toBeGreaterThanOrEqual(15);
  });

  it("checks in at once when the wall clock jumps ahead of the monotonic clock, as it does after sleep", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const seen = checkIns(registry, signer);
    const clock = await clockFile();
    const agent = await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }), { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file } });
    await count(seen, 1);
    await delay(3000);
    expect(seen, "nothing is due for ten minutes").toHaveLength(1);
    await clock.jump(4 * HOUR_S);
    const jumped = performance.now();
    const woke = await count(seen, 2, 10_000);
    expect(woke.at - jumped, "the check-in after the jump is not held back by the 10 s limit on early check-ins").toBeLessThan(4000);
    expect(agent.log()).toContain("the Mac woke from sleep");
  });

  it("checks in at once when the Mac app asks, at most once every 10 s, and refuses a web page that asks", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const seen = checkIns(registry, signer);
    const agent = await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }), { args: ["--sync-every", "600"] });
    const first = await count(seen, 1);
    expect((await local(agent, "/sync")).status, "GET").toBe(405);
    expect((await local(agent, "/sync", { method: "POST", headers: { origin: "https://example.test" } })).status).toBe(403);
    await delay(Math.max(0, first.at + 10_500 - performance.now()));
    expect(seen).toHaveLength(1);
    const asked = performance.now();
    expect((await local(agent, "/sync", { method: "POST" })).status).toBe(202);
    const second = await count(seen, 2);
    expect(second.at - asked).toBeLessThan(1500);
    expect((await local(agent, "/sync", { method: "POST" })).status).toBe(202);
    const third = await count(seen, 3);
    expect(third.at - second.at, "a second ask waits out the 10 s limit").toBeGreaterThan(9700);
    expect(third.at - second.at).toBeLessThan(12_000);
  });

  it("checks in at once when protection breaks or recovers, at most once every 10 s", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const seen = checkIns(registry, signer);
    const agent = await startRunning(suite, await relayPinned(suite, { signer, serverUrl: registry.url }), { transparent: true, args: ["--sync-every", "600"] });
    const first = await count(seen, 1);
    expect(healthOf(first)?.extensionActive).toBe(false);
    await delay(Math.max(0, first.at + 10_500 - performance.now()));

    const probed = performance.now();
    await probe(agent);
    const recovered = await count(seen, 2);
    expect(recovered.at - probed, "the network extension started probing").toBeLessThan(3500);
    expect(healthOf(recovered)?.extensionActive).toBe(true);

    const broke = await count(seen, 3, 20_000);
    expect(broke.at - probed, "the probes stopped, so the extension is inactive 10 s after the last one").toBeGreaterThan(9500);
    expect(healthOf(broke)?.extensionActive).toBe(false);

    await probe(agent);
    const again = await count(seen, 4, 20_000);
    expect(again.at - broke.at, "a recovery right after a break waits out the 10 s limit").toBeGreaterThan(9700);
    expect(again.at - broke.at).toBeLessThan(13_000);
    expect(healthOf(again)?.extensionActive).toBe(true);
  });
});

describe("a policy that expired while the Mac slept", () => {
  const sleptRig = async (afterWake: "answers" | "fails"): Promise<{ agent: Running; modes: () => Promise<string[]> }> => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let woke = false;
    checkIns(registry, signer, async () => {
      if (!woke) return undefined;
      await delay(2000);
      return afterWake === "fails" ? { code: "UNAVAILABLE", message: "the registry is down" } : undefined;
    });
    registry.serve({ bundle: null, catalogue: null });
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null });
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }), { iat: now() - HOUR_S, validUntil: now() + 30 * HOUR_S })));
    const clock = await clockFile();
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file, ...(afterWake === "fails" ? { VIBTRA_GUARD_TEST_WAKE_GRACE: "2s" } : {}) } });
    await waitUntil("the first check-in done", async () => (registry.calls.some((call) => call.door === "postflight") ? true : undefined));
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "off", policyExpired: false });
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { clientMode: "monitor", defaultMode: "enforce", protectionRevision: 2 }), { validUntil: now() + 100 * HOUR_S }), catalogue: null });
    woke = true;
    await clock.jump(31 * HOUR_S);
    const modes = async (): Promise<string[]> => {
      const seen: string[] = [];
      const until = performance.now() + 6000;
      while (performance.now() < until) {
        seen.push(String((await local(agent, "/status")).json().clientMode));
        await delay(50);
      }
      return seen;
    };
    return { agent, modes };
  };

  it("keeps its signed mode while it checks in, then takes the fresh policy and never the fallback", { timeout: 60_000 }, async () => {
    const { agent, modes } = await sleptRig("answers");
    const seen = await modes();
    expect(seen, "Off held while the check-in after waking was in flight").toContain("off");
    expect(seen, "the stricter fallback never applied").not.toContain("enforce");
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "monitor", policyExpired: false });
  });

  it("falls back to the stricter mode once the grace passes and the check-in after waking fails", { timeout: 60_000 }, async () => {
    const { agent, modes } = await sleptRig("fails");
    const seen = await modes();
    expect(seen.slice(0, 10), "Off held while the check-in after waking was in flight").toEqual(Array(10).fill("off"));
    expect(seen.at(-1)).toBe("enforce");
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "enforce", policyExpired: true });
  });
});

const LOCAL = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["localhost"], bundleIds: [], cliNames: [], custom: true }] });
const BLOCK_CHAT = { services: { chat: { action: "block", ruleId: "gsr_00000001" } } };

const holding = async (registry: FakeRegistry, signer: PolicySigner, bundle: Json, validUntil: number, catalogue?: Json) => {
  const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null, ...(catalogue === undefined ? {} : { catalogue }) });
  await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { bundleVersion: 7, ...bundle }), { iat: validUntil - 72 * HOUR_S, validUntil })));
  return profile;
};

const freshPolicy = (signer: PolicySigner, bundle: Json): Json => signEnvelope(signer, "bundle", bundleDocument(signer, { bundleVersion: 8, defaultMode: "enforce", protectionRevision: 2, ...bundle }), { validUntil: now() + 100 * HOUR_S });

const statusSamples = async (agent: Running, ms: number): Promise<{ mode: string; bundleVersion: unknown }[]> => {
  const seen: { mode: string; bundleVersion: unknown }[] = [];
  const until = performance.now() + ms;
  while (performance.now() < until) {
    const status = await local(agent, "/status").then(
      (reply) => reply.json(),
      () => undefined,
    );
    if (status === undefined) break;
    seen.push({ mode: String(status.clientMode), bundleVersion: status.bundleVersion });
    await delay(50);
  }
  return seen;
};

const firstPostflight = (registry: FakeRegistry): Promise<true> => waitUntil("the first check-in done", async () => (registry.calls.some((call) => call.door === "postflight") ? true : undefined));

const modeIs = (agent: Running, mode: string): Promise<true> => waitUntil(`the agent in ${mode}`, async () => ((await local(agent, "/status")).json().clientMode === mode ? true : undefined), 40_000);

describe("check-ins after the Mac wakes", () => {
  it("keeps the signed mode while they fail, and runs each ask that follows a failed check-in at once", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let failing = 0;
    const seen = checkIns(registry, signer, async () => {
      if (failing === 0) return undefined;
      failing -= 1;
      return { code: "UNAVAILABLE", message: "no network yet" };
    });
    registry.serve({ bundle: null, catalogue: null });
    const profile = await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, now() + 30 * HOUR_S);
    const clock = await clockFile();
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file } });
    await firstPostflight(registry);
    registry.serve({ bundle: freshPolicy(signer, { clientMode: "monitor" }), catalogue: null });
    const before = seen.length;
    failing = 2;
    await clock.jump(31 * HOUR_S);
    const sampled = statusSamples(agent, 16_000);
    await count(seen, before + 1, 6000);
    await delay(1000);
    const asked = performance.now();
    expect((await local(agent, "/sync", { method: "POST" })).status).toBe(202);
    const second = await count(seen, before + 2, 6000);
    expect(second.at - asked, "the first ask after a failed check-in skips the 10 s limit").toBeLessThan(1500);
    await delay(1000);
    const networkUp = performance.now();
    expect((await local(agent, "/sync", { method: "POST" })).status).toBe(202);
    const third = await count(seen, before + 3, 15_000);
    expect(third.at - networkUp, "the ask after the next failed check-in skips the limit too").toBeLessThan(1500);
    expect((await local(agent, "/sync", { method: "POST" })).status).toBe(202);
    const fourth = await count(seen, before + 4, 15_000);
    expect(fourth.at - third.at, "an ask after a check-in that succeeded waits out the limit").toBeGreaterThan(9700);
    expect((await sampled).map((sample) => sample.mode), "the fallback never applied while the agent kept trying").not.toContain("enforce");
    expect(seen.slice(before, before + 3).map((checkIn) => record(checkIn.call.body).clientMode), "each heartbeat names the signed mode the agent applies").toEqual(["off", "off", "off"]);
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "monitor", policyExpired: false });
  });

  it("falls back once the grace passes with every check-in failing, and until then the proxy and the heartbeat keep the signed mode", { timeout: 60_000 }, async () => {
    const origin = await startOrigin(suite.cleanup);
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let woke = false;
    const seen = checkIns(registry, signer, async () => (woke ? { code: "UNAVAILABLE", message: "the registry is down" } : undefined));
    registry.serve({ bundle: null, catalogue: null });
    const profile = await holding(registry, signer, { ...BLOCK_CHAT, clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, now() + 30 * HOUR_S, LOCAL);
    const clock = await clockFile();
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file, VIBTRA_GUARD_TEST_WAKE_GRACE: "8s" } });
    await firstPostflight(registry);
    const post = () =>
      viaProxy(agent, { method: "POST", url: `http://localhost:${new URL(origin.url).port}/backend-api/conversation`, headers: { "content-type": "application/json", connection: "close" }, body: '{"prompt":"hello"}' });
    const before = seen.length;
    woke = true;
    await clock.jump(31 * HOUR_S);
    const failed = await count(seen, before + 1, 6000);
    expect(record(failed.call.body).clientMode, "the heartbeat names the signed mode").toBe("off");
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "off", policyExpired: false });
    expect((await post()).status, "the proxy passes the blocked service, as Off does").toBe(200);
    const retried = await count(seen, before + 2, 12_000);
    expect(retried.at - failed.at, "a retry within the grace, not after the long interval").toBeLessThan(11_000);
    await waitUntil("the fallback after the grace", async () => ((await local(agent, "/status")).json().clientMode === "enforce" ? true : undefined), 15_000);
    expect((performance.now() - failed.at) / 1000, "not before the 8 s grace").toBeGreaterThan(6);
    expect((await post()).status, "past the grace the organisation default blocks").toBe(403);
  });
});

describe("an expiry the agent was awake for", () => {
  for (const item of [
    { name: "stays applied through a sleep inside the grace of the wake before it", expiresIn: 30 * HOUR_S, wakesFirst: true },
    { name: "stays applied through a sleep inside the grace after start", expiresIn: 8, wakesFirst: false },
  ]) {
    it(item.name, { timeout: 60_000 }, async () => {
      const signer = createSigner();
      const registry = await startFakeRegistry(suite.cleanup, signer);
      let down = !item.wakesFirst;
      checkIns(registry, signer, async () => (down ? { code: "UNAVAILABLE", message: "the registry is down" } : undefined));
      registry.serve({ bundle: null, catalogue: null });
      const validUntil = now() + item.expiresIn;
      const profile = await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, validUntil);
      const clock = await clockFile();
      const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file, VIBTRA_GUARD_TEST_WAKE_GRACE: "30s" } });
      let skew = 0;
      if (item.wakesFirst) {
        await firstPostflight(registry);
        down = true;
        skew = validUntil - now() - 6;
        await clock.jump(skew);
      }
      await modeIs(agent, "enforce");
      await clock.jump(skew + 20);
      const modes = (await statusSamples(agent, 5000)).map((sample) => sample.mode);
      expect(modes, "the signed Off never comes back").not.toContain("off");
    });
  }
});

describe("sleeps repeated inside the grace", () => {
  it("share the one grace of the expiry they missed, and do not undo the fallback once it is spent", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let down = false;
    checkIns(registry, signer, async () => (down ? { code: "UNAVAILABLE", message: "the registry is down" } : undefined));
    registry.serve({ bundle: null, catalogue: null });
    const profile = await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, now() + 30 * HOUR_S);
    const clock = await clockFile();
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file, VIBTRA_GUARD_TEST_WAKE_GRACE: "5s" } });
    await firstPostflight(registry);
    down = true;
    await clock.jump(31 * HOUR_S);
    const slept = performance.now();
    const sleeps = (async () => {
      for (let n = 1; n <= 4; n += 1) {
        await delay(3000);
        await clock.jump(31 * HOUR_S + 15 * n);
      }
    })();
    await modeIs(agent, "enforce");
    expect((performance.now() - slept) / 1000, "the 5 s grace, though a sleep comes every 3 s").toBeLessThan(9);
    const after = (await statusSamples(agent, 15_500 - (performance.now() - slept))).map((sample) => sample.mode);
    await sleeps;
    expect(after, "the later sleeps keep the fallback").not.toContain("off");
  });
});

describe("a check-in that hangs", () => {
  it("does not hold back an expiry the agent is awake for", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const hung = Promise.withResolvers<void>();
    checkIns(registry, signer, async () => {
      await hung.promise;
      return { code: "UNAVAILABLE", message: "too late" };
    });
    const validUntil = now() + 6;
    const agent = await startRunning(suite, await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, validUntil));
    await modeIs(agent, "enforce");
    hung.resolve();
    expect(Date.now() / 1000 - validUntil, "seconds from validUntil to the fallback").toBeLessThan(3);
  });

  it("ends the grace for an expiry missed asleep on time", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    let hang = false;
    const hung = Promise.withResolvers<void>();
    checkIns(registry, signer, async () => {
      if (!hang) return undefined;
      await hung.promise;
      return { code: "UNAVAILABLE", message: "too late" };
    });
    registry.serve({ bundle: null, catalogue: null });
    const profile = await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, now() + 30 * HOUR_S);
    const clock = await clockFile();
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file, VIBTRA_GUARD_TEST_WAKE_GRACE: "4s" } });
    await firstPostflight(registry);
    hang = true;
    await clock.jump(31 * HOUR_S);
    const slept = performance.now();
    await modeIs(agent, "enforce");
    hung.resolve();
    const held = (performance.now() - slept) / 1000;
    expect(held, "the signed mode held through the grace").toBeGreaterThan(3.5);
    expect(held, "the 4 s grace, not the 30 s the check-in hangs").toBeLessThan(8);
  });
});

describe("a policy that expired while the agent was not running", () => {
  for (const item of [
    { name: "keeps its signed mode until the first check-in brings a fresh one", answers: true },
    { name: "keeps its signed mode through the grace while check-ins fail, then falls back", answers: false },
  ]) {
    it(item.name, { timeout: 60_000 }, async () => {
      const signer = createSigner();
      const registry = await startFakeRegistry(suite.cleanup, signer);
      const seen = checkIns(registry, signer, async () => {
        if (!item.answers) return { code: "UNAVAILABLE", message: "the registry is down" };
        await delay(3000);
        return undefined;
      });
      registry.serve({ bundle: freshPolicy(signer, { clientMode: "monitor" }), catalogue: null });
      const profile = await holding(registry, signer, { clientMode: "off", defaultMode: "enforce", protectionRevision: 1 }, now() - 8 * HOUR_S);
      const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_WAKE_GRACE: "5s" } });
      const modes = (await statusSamples(agent, 8000)).map((sample) => sample.mode);
      expect(record(seen[0]?.call.body).clientMode, "the first heartbeat names the signed mode").toBe("off");
      expect(modes.slice(0, 20), "Off held at start").toEqual(Array(20).fill("off"));
      if (item.answers) {
        expect(modes, "the fallback never applied").not.toContain("enforce");
        expect(modes.at(-1)).toBe("monitor");
      } else {
        expect(modes.at(-1), "past the grace the fallback applies").toBe("enforce");
      }
    });
  }
});

describe("a change to Off that arrives after a sleep that outlived the policy", () => {
  for (const item of [
    { held: "monitor", name: "keeps the signed Monitor until the extension stops steering, never the Enforce fallback" },
    { held: "off", name: "takes the fresh Off at once when the signed mode was Off already" },
  ]) {
    it(item.name, { timeout: 60_000 }, async () => {
      const signer = createSigner();
      const registry = await startFakeRegistry(suite.cleanup, signer);
      checkIns(registry, signer);
      registry.serve({ bundle: null, catalogue: null });
      const profile = await holding(registry, signer, { clientMode: item.held, defaultMode: "enforce", protectionRevision: 1 }, now() + 30 * HOUR_S);
      await writeRelayPin(profile, RELAY);
      const clock = await clockFile();
      const agent = await startRunning(suite, profile, { transparent: true, args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file } });
      const extension = steeringExtension(agent);
      await firstPostflight(registry);
      await waitUntil("the extension steering", async () => ((await local(agent, "/status")).json().extensionActive === true ? true : undefined));
      registry.serve({ bundle: freshPolicy(signer, { clientMode: "off" }), catalogue: null });
      await clock.jump(31 * HOUR_S);
      const steering = await statusSamples(agent, 7000);
      extension.say(HEALTH_OFF);
      const stopped = await statusSamples(agent, 5000);
      const all = [...steering, ...stopped].map((sample) => sample.mode);
      expect(all, "the stricter fallback never applied").not.toContain("enforce");
      if (item.held === "monitor") {
        expect(steering.map((sample) => [sample.mode, sample.bundleVersion]), "Monitor and the old policy while the extension steers").toEqual(steering.map(() => ["monitor", 7]));
      } else {
        expect(steering.at(-1), "the fresh Off applied while the extension still steered").toEqual({ mode: "off", bundleVersion: 8 });
      }
      expect(stopped.at(-1)).toEqual({ mode: "off", bundleVersion: 8 });
    });
  }
});

describe("a one-shot command beside the running agent", () => {
  it("does not leave the registry holding the command's health: the agent sends its own at its next check-in", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer)), catalogue: signEnvelope(signer, "catalogue", catalogueDocument()) });
    const seen = checkIns(registry, signer);
    const profile = await relayPinned(suite, { signer, serverUrl: registry.url });
    const agent = await startRunning(suite, profile, { transparent: true });
    steeringExtension(agent);
    await waitUntil("the agent reported the extension", async () => seen.find((checkIn) => healthOf(checkIn)?.extensionActive === true));
    for (const [name, args] of [
      ["sync", ["sync"]],
      ["enrol", ["enrol", "--server", registry.url, "--token", `genr_${"0".repeat(32)}`]],
    ] as const) {
      await delay(2000);
      const before = seen.length;
      const ran = await runAgentCommand(suite.binary(), [...args], { dataDir: profile.dataDir });
      expect(ran.code, `${name}: ${ran.stderr}`).toBe(0);
      const latest = await waitUntil(
        `${name}: the agent's own health after the command's`,
        async () => {
          const sent = seen.slice(before).filter((checkIn) => healthOf(checkIn) !== undefined);
          return sent.some((checkIn) => healthOf(checkIn)?.proxyListening === false) && healthOf(sent.at(-1))?.proxyListening === true ? sent.at(-1) : undefined;
        },
        5000,
      );
      expect(healthOf(latest), name).toMatchObject({ proxyListening: true, extensionActive: true });
    }
  });

  it("leaves the agent's own health last when the command runs while one of the agent's check-ins is in flight", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer)), catalogue: signEnvelope(signer, "catalogue", catalogueDocument()) });
    let holdNext = false;
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen = checkIns(registry, signer, async (call) => {
      if (holdNext && record(call.body).health === undefined) {
        holdNext = false;
        held.resolve();
        await release.promise;
      }
      return undefined;
    });
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url });
    await startRunning(suite, profile);
    await count(seen, 1);
    holdNext = true;
    await held.promise;
    const ran = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
    expect(ran.code, ran.stderr).toBe(0);
    expect(healthOf(seen.at(-1)), "the command sent its own health").toMatchObject({ proxyListening: false });
    release.resolve();
    await count(seen, seen.length + 4);
    expect(seen.map(healthOf).filter((health) => health !== undefined).at(-1), "the registry's last snapshot is the running agent's").toMatchObject({ proxyListening: true });
  });
});

describe("check-ins when the certificate or the policy breaks or recovers", () => {
  it("checks in once when the certificate becomes trusted or the policy stops or starts verifying, and not again while nothing changes", { timeout: 120_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const seen = checkIns(registry, signer);
    const caSigner = await startCaSigner("ok");
    suite.cleanup.defer(caSigner.close);
    const security = await startFakeSecurity();
    suite.cleanup.defer(security.close);
    const env = { ...caSigner.env, ...security.env };
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url });
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env });
    const first = await count(seen, 1);
    expect(healthOf(first)?.caTrusted).toBe(false);
    await delay(Math.max(0, first.at + 10_500 - performance.now()));
    expect(seen).toHaveLength(1);

    const trusting = performance.now();
    const trusted = await runAgentCommand(suite.binary(), ["ca", "trust", "--local", new URL(agent.localUrl).host], { dataDir: agent.dataDir, env });
    expect(trusted.code, trusted.stderr).toBe(0);
    const onTrust = await count(seen, 2, 15_000);
    expect(onTrust.at - trusting, "the certificate became trusted").toBeLessThan(10_000);
    expect(healthOf(onTrust)?.caTrusted).toBe(true);
    await delay(Math.max(0, onTrust.at + 12_000 - performance.now()));
    expect(seen, "nothing changed since, so no check-in every 10 s").toHaveLength(2);

    const checkpoint = path.join(profile.dataDir, "active-policy.json");
    const original = await readFile(checkpoint, "utf8");
    const forger = { ...createSigner(), orgId: signer.orgId, deviceId: signer.deviceId, keyId: signer.keyId };
    const breaking = performance.now();
    await writeFile(checkpoint, JSON.stringify({ ...record(JSON.parse(original)), bundle: signEnvelope(forger, "bundle", bundleDocument(signer)) }));
    const onBreak = await count(seen, 3, 10_000);
    expect(onBreak.at - breaking, "the policy stopped verifying").toBeLessThan(4000);
    expect(record((await local(agent, "/status")).json().policyLoad)).toEqual({ reason: "policy-verify-failed" });
    await writeFile(checkpoint, original);
    const onRecover = await count(seen, 4, 20_000);
    expect(onRecover.at - onBreak.at, "the recovery right after the break waits out the 10 s limit").toBeGreaterThan(9700);
    expect(onRecover.at - onBreak.at).toBeLessThan(13_000);
  });
});
