import { GuardPreflightRequest } from "@vibtra/guard-contract";
import { describe, expect, it } from "vitest";
import { bundleDocument, createProfile, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, type FakeRegistry, type Json, type PolicySigner } from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const HOUR_S = 3600;
const now = (): number => Math.floor(Date.now() / 1000);
const PREFLIGHT_MESSAGE = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)";

const quietPreflight = (signer: PolicySigner): Json => ({ clientMode: "enforce", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: false, catalogueChanged: false, signingKeyId: signer.keyId });

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
