import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { GuardPreflightRequest } from "@vibtra/guard-contract";
import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  catalogueDocument,
  createProfile,
  createSigner,
  deviceDocument,
  jsonLines,
  jsonObject,
  POLICY_PIN,
  runAgentCommand,
  signEnvelope,
  startFakeRegistry,
  tempDir,
  waitUntil,
  type AgentProfile,
  type FakeRegistry,
  type Json,
  type PolicySigner,
  type RegistryCall,
} from "./harness.ts";
import { launchAgent } from "../../support/agent.ts";
import { local, record, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const PIN = POLICY_PIN;
const CHECKPOINT = "active-policy.json";
const ENROL_TOKEN = `genr_${"0".repeat(32)}`;

const chatBundle = (signer: PolicySigner, version: number): Json => bundleDocument(signer, { bundleVersion: version, catalogueVersion: "v1", services: { chat: { action: "block" } } });
const chatCatalogue = (): Json =>
  catalogueDocument({ version: "v1", services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true, enabled: true }] });
const openBundle = (signer: PolicySigner, version: number): Json => bundleDocument(signer, { bundleVersion: version, catalogueVersion: "v1", services: { chat: { action: "allow" } } });

const command = (dataDir: string, args: readonly string[]) => runAgentCommand(suite.binary(), args, { dataDir });
const status = async (dataDir: string): Promise<Json> => {
  const result = await command(dataDir, ["status", "--local", "127.0.0.1:9"]);
  expect(result.code, result.stderr).toBe(0);
  return jsonObject(result.stdout);
};
const policyKey = async (dataDir: string): Promise<Json> => record((await status(dataDir)).policyKey);
const verdict = async (dataDir: string): Promise<string | undefined> => {
  const result = await command(dataDir, ["test", "--host", "chatgpt.com"]);
  return result.code === 0 ? String(jsonObject(result.stdout).verdict) : undefined;
};
const pinned = async (dataDir: string): Promise<Json> => record(JSON.parse(await readFile(path.join(dataDir, PIN), "utf8")));

const swapDeviceKey = async (profile: AgentProfile, forger: PolicySigner, keyId = profile.signer.keyId): Promise<void> => {
  const device = deviceDocument(profile.signer, profile.serverUrl);
  await profile.writeFile("device.json", JSON.stringify({ ...device, signing: { ...record(device.signing), keyId, publicKeyPem: forger.publicKeyPem } }));
};

const forgedBundle = (profile: AgentProfile, forger: PolicySigner, version: number, keyId = profile.signer.keyId): Json =>
  signEnvelope({ ...forger, orgId: profile.signer.orgId, deviceId: profile.signer.deviceId, keyId }, "bundle", openBundle(profile.signer, version));

const signedProfile = async (): Promise<AgentProfile> => {
  const signer = createSigner();
  return createProfile(suite.cleanup, { signer, bundle: chatBundle(signer, 1), catalogue: chatCatalogue() });
};

const signedProfileAt = (serverUrl: string, signer: PolicySigner): Promise<AgentProfile> => createProfile(suite.cleanup, { signer, serverUrl, bundle: chatBundle(signer, 1), catalogue: chatCatalogue() });

const enrolled = async (registry: FakeRegistry, signer: PolicySigner): Promise<string> => {
  registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 1)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
  const dataDir = await tempDir(suite.cleanup, "pin-enrol");
  const result = await command(dataDir, ["enrol", "--server", registry.url, "--token", ENROL_TOKEN]);
  expect(result.code, result.stderr).toBe(0);
  return dataDir;
};

describe("the policy-signing key pinned at enrolment or fetched from the registry", () => {
  it("enrolment pins the registry's key and re-enrolment replaces it", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const dataDir = await enrolled(registry, signer);
    expect(await pinned(dataDir)).toMatchObject({ deviceId: signer.deviceId, orgId: signer.orgId, source: "enrolment", signing: { keyId: signer.keyId, alg: "ES256", publicKeyPem: signer.publicKeyPem } });
    expect(await policyKey(dataDir)).toEqual({ store: "keychain", pinned: "enrolment" });
    expect(await verdict(dataDir)).toBe("blocked");

    const next = createSigner();
    const other = await startFakeRegistry(suite.cleanup, next);
    other.serve({ bundle: signEnvelope(next, "bundle", chatBundle(next, 1)), catalogue: signEnvelope(next, "catalogue", chatCatalogue()) });
    const again = await command(dataDir, ["enrol", "--server", other.url, "--token", ENROL_TOKEN]);
    expect(again.code, again.stderr).toBe(0);
    expect(await pinned(dataDir)).toMatchObject({ deviceId: next.deviceId, source: "enrolment", signing: { keyId: next.keyId, publicKeyPem: next.publicKeyPem } });
    expect(await policyKey(dataDir)).toEqual({ store: "keychain", pinned: "enrolment" });
    expect(await verdict(dataDir)).toBe("blocked");
  });

  it("refuses to enrol when the key cannot be pinned, and keeps the enrolment it had", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const dataDir = await enrolled(registry, signer);
    const before = await readFile(path.join(dataDir, PIN), "utf8");
    await writeFile(path.join(dataDir, `${PIN}.down`), "");
    const next = createSigner();
    const other = await startFakeRegistry(suite.cleanup, next);
    const refused = await command(dataDir, ["enrol", "--server", other.url, "--token", ENROL_TOKEN]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("could not pin the policy-signing key");
    await rm(path.join(dataDir, `${PIN}.down`));
    expect(await readFile(path.join(dataDir, PIN), "utf8")).toBe(before);
    expect(record(JSON.parse(await readFile(path.join(dataDir, "device.json"), "utf8"))).deviceId).toBe(signer.deviceId);
    expect(await verdict(dataDir)).toBe("blocked");
  });

  it("never reads a key from device.json: a forged key there changes nothing and its bundle never loads", async () => {
    const profile = await signedProfile();
    expect(await verdict(profile.dataDir)).toBe("blocked");
    const forger = createSigner();
    await swapDeviceKey(profile, forger);
    await profile.writeFile(CHECKPOINT, JSON.stringify({ bundle: forgedBundle(profile, forger, 9), catalogue: signEnvelope(profile.signer, "catalogue", chatCatalogue()) }));
    await profile.writeFile("bundle.json", JSON.stringify(forgedBundle(profile, forger, 9)));
    const current = await status(profile.dataDir);
    expect(current.bundleVersion, "the forged bundle never loads").toBeUndefined();
    expect(record(current.policyKey)).toEqual({ store: "keychain", pinned: "enrolment" });
    const scan = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
    expect(scan.code).not.toBe(0);
    expect(scan.stderr).toContain("signed bundle did not verify against the enrolled key");

    await profile.writeFile(CHECKPOINT, JSON.stringify({ bundle: signEnvelope(profile.signer, "bundle", chatBundle(profile.signer, 2)), catalogue: signEnvelope(profile.signer, "catalogue", chatCatalogue()) }));
    expect((await status(profile.dataDir)).bundleVersion, "the real bundle still verifies with the pinned key").toBe(2);
    expect(await verdict(profile.dataDir)).toBe("blocked");
  });

  it("enrolment no longer writes the key into device.json", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const dataDir = await enrolled(registry, signer);
    const device = record(JSON.parse(await readFile(path.join(dataDir, "device.json"), "utf8")));
    expect(device).toMatchObject({ deviceId: signer.deviceId, orgId: signer.orgId });
    expect(device.signing).toBeUndefined();
  });

  it("reports a mismatch only when device.json names another device or organisation, and keeps the last verified policy", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: chatBundle(signer, 1), catalogue: chatCatalogue() });
    const agent = await startRunning(suite, profile);
    const forger = createSigner();
    await swapDeviceKey(profile, forger);
    await waitUntil("the agent to reload", async () => ((await agent.status()).bundleVersion === 1 ? true : undefined));
    expect(record((await local(agent, "/status")).json().policyKey), "a key in device.json is ignored").toEqual({ store: "keychain", pinned: "enrolment" });

    await profile.writeDevice({ orgId: "org_somewhere_else" });
    const reported = await waitUntil("the agent to report the mismatch", async () => {
      const now = (await local(agent, "/status")).json();
      return record(now.policyKey).reason === "policy-key-mismatch" ? now : undefined;
    });
    expect(reported.bundleVersion, "the last verified policy is kept").toBe(1);
    await agent.close();
    const restarted = await status(profile.dataDir);
    expect(record(restarted.policyKey)).toEqual({ store: "keychain", pinned: "enrolment", reason: "policy-key-mismatch" });
    expect(await pinned(profile.dataDir), "a mismatch never re-pins").toMatchObject({ orgId: signer.orgId, source: "enrolment" });
  });

  it("loads no rules and policy-scan refuses while no key is pinned, then fetches the key from the registry, pins it and loads rules", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 3)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: chatBundle(signer, 1), catalogue: chatCatalogue(), pinned: false });

    const before = await status(profile.dataDir);
    expect(before.bundleVersion, "fail closed: nothing loads without a pin").toBeUndefined();
    expect(record(before.policyKey)).toEqual({ store: "keychain", reason: "policy-key-fetching" });
    expect(await verdict(profile.dataDir)).not.toBe("blocked");
    const files = (await readdir(profile.dataDir)).sort();
    const scan = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
    expect(scan.code).not.toBe(0);
    expect(scan.stderr).toContain("no policy-signing key is pinned; policy-scan never fetches one");
    expect((await readdir(profile.dataDir)).sort(), "policy-scan writes nothing").toEqual(files);
    expect(registry.calls, "policy-scan never asks the registry").toHaveLength(0);

    const synced = await command(profile.dataDir, ["sync"]);
    expect(synced.code, synced.stderr).toBe(0);
    const fetch = registry.calls.find((call) => call.door === "signing");
    expect(fetch).toMatchObject({ method: "GET", path: `/api/guard/v1/signing/${signer.deviceId}` });
    expect(fetch?.headers.authorization).toBe(`Bearer ${(await readFile(path.join(profile.dataDir, "device.token"), "utf8")).trim()}`);
    expect(registry.calls.map((call) => call.door).indexOf("signing"), "the key is fetched before the preflight").toBeLessThan(registry.calls.map((call) => call.door).indexOf("preflight"));
    expect(await pinned(profile.dataDir)).toMatchObject({ deviceId: signer.deviceId, orgId: signer.orgId, source: "registry", signing: { keyId: signer.keyId, publicKeyPem: signer.publicKeyPem } });
    const preflight = registry.calls.find((call) => call.door === "preflight");
    expect(record(record(preflight?.body).health).policyKey).toEqual({ store: "keychain", pinned: "registry" });
    expect(GuardPreflightRequest.safeParse(preflight?.body).success).toBe(true);
    const after = await status(profile.dataDir);
    expect(after.bundleVersion).toBe(3);
    expect(record(after.policyKey)).toEqual({ store: "keychain", pinned: "registry" });
    expect(await verdict(profile.dataDir)).toBe("blocked");
  });

  it("stays fail closed while the registry cannot give the key, and retries until it can", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 1)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
    const failing = (call: RegistryCall) => (call.door === "signing" ? { status: 503, body: { code: "UNAVAILABLE", message: "try later" } } : undefined);
    registry.override(failing);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, pinned: false });

    const refused = await command(profile.dataDir, ["sync"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("could not fetch the policy-signing key");
    expect(registry.calls.map((call) => call.door), "nothing else is sent without a pin").toEqual(["signing"]);
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });

    const forger = createSigner();
    registry.override((call) => (call.door === "signing" ? { status: 200, body: { deviceId: "gdev_ffffffffffffffff", orgId: signer.orgId, signing: { keyId: forger.keyId, alg: "ES256", publicKeyPem: forger.publicKeyPem } } } : undefined));
    const otherDevice = await command(profile.dataDir, ["sync"]);
    expect(otherDevice.stderr).toContain("the registry sent a policy-signing key for another enrolment");
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });

    registry.override(failing);
    const agent = await launchAgent({ binary: suite.binary(), dataDir: profile.dataDir, args: ["--sync-every", "1"] });
    suite.cleanup.defer(agent.close);
    await waitUntil("a second fetch", async () => (registry.calls.filter((call) => call.door === "signing").length >= 4 ? true : undefined));
    const down = (await local(agent, "/status")).json();
    expect(down.bundleVersion).toBeUndefined();
    expect(record(down.policyKey)).toEqual({ store: "keychain", reason: "policy-key-fetching" });

    registry.override(undefined);
    const loaded = await waitUntil("the fetched key to load rules", async () => {
      const now = (await local(agent, "/status")).json();
      return now.bundleVersion === 1 ? now : undefined;
    });
    expect(record(loaded.policyKey)).toEqual({ store: "keychain", pinned: "registry" });
  });

  it("a revoked device gets no key and stops", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.override((call) => (call.door === "signing" ? { status: 401, body: { code: "GUARD_DEVICE_REVOKED", message: "IT removed this laptop from Guard" } } : undefined));
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, pinned: false });
    const refused = await command(profile.dataDir, ["sync"]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("device revoked");
    expect(record(JSON.parse(await readFile(path.join(profile.dataDir, "device.json"), "utf8"))).revoked).toBe(true);
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });
    const again = await command(profile.dataDir, ["sync"]);
    expect(again.code).not.toBe(0);
    expect(registry.calls.filter((call) => call.door === "signing"), "a revoked device does not ask again").toHaveLength(1);
  });

  it("never fetches while the store cannot be read", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, pinned: false });
    await writeFile(path.join(profile.dataDir, `${PIN}.down`), "");
    await command(profile.dataDir, ["sync"]);
    expect(registry.calls.map((call) => call.door)).not.toContain("signing");
    const down = await status(profile.dataDir);
    expect(down.bundleVersion).toBeUndefined();
    expect(record(down.policyKey)).toEqual({ store: "keychain", reason: "policy-key-unavailable" });
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never replaces a pinned key with one from the registry", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const forger = createSigner();
    registry.override((call) => (call.door === "signing" ? { status: 200, body: { deviceId: signer.deviceId, orgId: signer.orgId, signing: { keyId: forger.keyId, alg: "ES256", publicKeyPem: forger.publicKeyPem } } } : undefined));
    registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 2)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
    const profile = await signedProfileAt(registry.url, signer);
    const before = await readFile(path.join(profile.dataDir, PIN), "utf8");
    const synced = await command(profile.dataDir, ["sync"]);
    expect(synced.code, synced.stderr).toBe(0);
    expect(registry.calls.map((call) => call.door)).not.toContain("signing");
    expect(await readFile(path.join(profile.dataDir, PIN), "utf8")).toBe(before);
    expect((await status(profile.dataDir)).bundleVersion).toBe(2);
  });

  it("treats a corrupt pin as unavailable, never as no pin, so no key is fetched over it", async () => {
    const profile = await signedProfile();
    for (const corrupt of ["{}", "not json"]) {
      await profile.writeFile(PIN, corrupt);
      const current = await status(profile.dataDir);
      expect(current.bundleVersion, corrupt).toBeUndefined();
      expect(record(current.policyKey), corrupt).toEqual({ store: "keychain", reason: "policy-key-unavailable" });
      const scan = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
      expect(scan.stderr, corrupt).toContain("the pinned policy-signing key is unavailable");
      expect(await readFile(path.join(profile.dataDir, PIN), "utf8"), corrupt).toBe(corrupt);
    }
  });

  it("loads nothing while the store cannot be read, and recovers when it can", async () => {
    const profile = await signedProfile();
    await writeFile(path.join(profile.dataDir, `${PIN}.down`), "");
    const down = await status(profile.dataDir);
    expect(down.bundleVersion).toBeUndefined();
    expect(record(down.policyKey)).toEqual({ store: "keychain", reason: "policy-key-unavailable" });
    const scan = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
    expect(scan.code).not.toBe(0);
    expect(scan.stderr).toContain("the pinned policy-signing key is unavailable");

    await rm(path.join(profile.dataDir, `${PIN}.down`));
    expect((await status(profile.dataDir)).bundleVersion).toBe(1);
    const scanned = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
    expect(scanned.code, scanned.stderr).toBe(0);
    expect(jsonLines(scanned.stdout)[0]?.verdict).toBe("blocked");
  });
});
