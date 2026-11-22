import { writeFile } from "node:fs/promises";
import { GuardPreflightRequest } from "@vibtra/guard-contract";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bundleDocument, createProfile, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, tempDir, waitUntil, type FakeRegistry, type Json, type PolicySigner, type RegistryCall } from "./harness.ts";
import { local, policyProfile, rawExchange, record, startRunning, useAgentSuite, type Running } from "./running.ts";

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

const probe = (agent: Running): Promise<Buffer> => rawExchange(agent.transparentPort, Buffer.from("PROXY UNKNOWN vibtra-health\r\n"), { until: (bytes) => bytes.includes(0x0a) });

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
    const agent = await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }), { transparent: true, env: { VIBTRA_GUARD_TEST_HEALTH_EVERY: "5s" } });
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
  it("spreads its check-ins around the interval instead of keeping a fixed beat", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const seen = checkIns(registry, signer);
    await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }));
    await count(seen, 21, 60_000);
    const gaps = seen.slice(1, 21).map((checkIn, i) => (checkIn.at - (seen[i]?.at ?? 0)) / 1000);
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    expect(Math.max(...gaps) - Math.min(...gaps), `gaps ${gaps.map((gap) => gap.toFixed(2)).join(" ")}`).toBeGreaterThan(0.2);
    expect(mean, "the spread keeps the mean at the 1 s interval").toBeGreaterThan(0.85);
    expect(mean).toBeLessThan(1.25);
    expect(Math.max(...gaps), "no gap goes past the interval plus a fifth").toBeLessThan(1.6);
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
    const agent = await startRunning(suite, await policyProfile(suite, { signer, serverUrl: registry.url }), { transparent: true, args: ["--sync-every", "600"] });
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
    const agent = await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { VIBTRA_GUARD_TEST_CLOCK_FILE: clock.file } });
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

  it("falls back to the stricter mode only once the check-in after waking fails", { timeout: 60_000 }, async () => {
    const { agent, modes } = await sleptRig("fails");
    const seen = await modes();
    expect(seen.slice(0, 10), "Off held while the check-in after waking was in flight").toEqual(Array(10).fill("off"));
    expect(seen.at(-1)).toBe("enforce");
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "enforce", policyExpired: true });
  });
});
