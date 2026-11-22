import { GuardPreflightRequest } from "@vibtra/guard-contract";
import { describe, expect, it } from "vitest";
import { bundleDocument, createProfile, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, waitUntil, type FakeRegistry, type Json, type PolicySigner, type RegistryCall } from "./harness.ts";
import { policyProfile, rawExchange, record, startRunning, useAgentSuite, type Running } from "./running.ts";

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
