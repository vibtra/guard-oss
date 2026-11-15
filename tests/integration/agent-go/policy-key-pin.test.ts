import { readFile, rm, stat, writeFile } from "node:fs/promises";
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
  runAgentCommand,
  signEnvelope,
  startFakeRegistry,
  tempDir,
  waitUntil,
  type AgentProfile,
  type FakeRegistry,
  type Json,
  type PolicySigner,
} from "./harness.ts";
import { local, record, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const PIN = "test-policy-pin.json";
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

const enrolled = async (registry: FakeRegistry, signer: PolicySigner): Promise<string> => {
  registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 1)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
  const dataDir = await tempDir(suite.cleanup, "pin-enrol");
  const result = await command(dataDir, ["enrol", "--server", registry.url, "--token", ENROL_TOKEN]);
  expect(result.code, result.stderr).toBe(0);
  return dataDir;
};

describe("the policy-signing key pinned at enrolment", () => {
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

  it("rejects a forged bundle signed by a key swapped into device.json and still accepts the real one", async () => {
    const profile = await signedProfile();
    expect(await verdict(profile.dataDir)).toBe("blocked");
    const forger = createSigner();
    await swapDeviceKey(profile, forger);
    await profile.writeFile(CHECKPOINT, JSON.stringify({ bundle: forgedBundle(profile, forger, 9), catalogue: signEnvelope(profile.signer, "catalogue", chatCatalogue()) }));
    await profile.writeFile("bundle.json", JSON.stringify(forgedBundle(profile, forger, 9)));
    const current = await status(profile.dataDir);
    expect(current.bundleVersion, "the forged bundle never loads").toBeUndefined();
    expect(record(current.policyKey)).toEqual({ store: "keychain", pinned: "first-use", reason: "policy-key-mismatch" });
    const scan = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
    expect(scan.code).not.toBe(0);
    expect(scan.stderr).toContain("signed bundle did not verify against the enrolled key");

    await profile.writeFile(CHECKPOINT, JSON.stringify({ bundle: signEnvelope(profile.signer, "bundle", chatBundle(profile.signer, 2)), catalogue: signEnvelope(profile.signer, "catalogue", chatCatalogue()) }));
    expect((await status(profile.dataDir)).bundleVersion, "the real bundle still verifies with the pinned key").toBe(2);
    expect(await verdict(profile.dataDir)).toBe("blocked");
  });

  it("keeps the last verified policy when device.json's key changes under a running agent, reports why, and refuses forged downloads", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: chatBundle(signer, 1), catalogue: chatCatalogue() });
    const agent = await startRunning(suite, profile);
    const forger = createSigner();
    await swapDeviceKey(profile, forger);
    const reported = await waitUntil("the agent to report the mismatch", async () => {
      const now = (await local(agent, "/status")).json();
      return record(now.policyKey).reason === "policy-key-mismatch" ? now : undefined;
    });
    expect(reported.bundleVersion, "the last verified policy is kept").toBe(1);

    registry.serve({ bundle: forgedBundle(profile, forger, 5), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
    const seen = registry.calls.length;
    const refused = await command(profile.dataDir, ["sync"]);
    expect(refused.code, "a download signed by the swapped key is refused").not.toBe(0);
    const preflight = registry.calls.slice(seen).find((call) => call.door === "preflight");
    expect(record(record(preflight?.body).health).policyKey).toEqual({ store: "keychain", pinned: "first-use", reason: "policy-key-mismatch" });
    expect(record(preflight?.body).signingKeyId).toBe(signer.keyId);
    expect(GuardPreflightRequest.safeParse(preflight?.body).success).toBe(true);
    expect(registry.calls.slice(seen).map((call) => call.door)).toContain("ruledownload");
    expect((await agent.status()).bundleVersion).toBe(1);

    registry.serve({ bundle: signEnvelope(signer, "bundle", chatBundle(signer, 6)), catalogue: signEnvelope(signer, "catalogue", chatCatalogue()) });
    const synced = await command(profile.dataDir, ["sync"]);
    expect(synced.code, synced.stderr).toBe(0);
    await waitUntil("the real update to load", async () => ((await agent.status()).bundleVersion === 6 ? true : undefined));
    await agent.close();
    const restarted = await status(profile.dataDir);
    expect([restarted.bundleVersion, record(restarted.policyKey).reason], "and after a restart").toEqual([6, "policy-key-mismatch"]);
  });

  it("pins device.json's key once for a Mac enrolled before pinning, and never re-pins over it", async () => {
    const profile = await signedProfile();
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await status(profile.dataDir)).bundleVersion).toBe(1);
    expect(await pinned(profile.dataDir)).toMatchObject({ deviceId: profile.signer.deviceId, source: "first-use", signing: { publicKeyPem: profile.signer.publicKeyPem } });
    const first = await readFile(path.join(profile.dataDir, PIN), "utf8");

    const forger = createSigner();
    await swapDeviceKey(profile, forger, forger.keyId);
    await profile.writeFile(CHECKPOINT, JSON.stringify({ bundle: forgedBundle(profile, forger, 9, forger.keyId), catalogue: signEnvelope(profile.signer, "catalogue", chatCatalogue()) }));
    expect((await status(profile.dataDir)).bundleVersion).toBeUndefined();
    expect(await readFile(path.join(profile.dataDir, PIN), "utf8"), "the first-use pin is never replaced from device.json").toBe(first);
  });

  it("treats a corrupt pin as unavailable, never as no pin, so device.json's key is not pinned over it", async () => {
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

  it("trusts no key from device.json while the store cannot be read, and recovers when it can", async () => {
    const profile = await signedProfile();
    await writeFile(path.join(profile.dataDir, `${PIN}.down`), "");
    const down = await status(profile.dataDir);
    expect(down.bundleVersion).toBeUndefined();
    expect(record(down.policyKey)).toEqual({ store: "keychain", reason: "policy-key-unavailable" });
    await expect(stat(path.join(profile.dataDir, PIN))).rejects.toMatchObject({ code: "ENOENT" });
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
