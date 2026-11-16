import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  catalogueDocument,
  createProfile,
  createSigner,
  jsonObject,
  POLICY_PIN,
  runAgentCommand,
  signEnvelope,
  startFakeRegistry,
  tempDir,
  type FakeRegistry,
  type Json,
  type PolicySigner,
} from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const ENROL_TOKEN = `genr_${"0".repeat(32)}`;

const signedWith = (origin: string): Record<string, string> => ({ VIBTRA_GUARD_TEST_SIGNED_REGISTRY: origin });

const command = (dataDir: string, args: readonly string[], env: Record<string, string> = {}) => runAgentCommand(suite.binary(), args, { dataDir, env });
const json = async (dataDir: string, args: readonly string[], env: Record<string, string> = {}): Promise<Json> => {
  const result = await command(dataDir, args, env);
  expect(result.code, result.stderr).toBe(0);
  return jsonObject(result.stdout);
};
const status = (dataDir: string, env: Record<string, string> = {}) => json(dataDir, ["status", "--local", "127.0.0.1:9"], env);
const exists = (file: string) => stat(file).then(
  () => true,
  () => false,
);

const servedRegistry = async (signer: PolicySigner): Promise<FakeRegistry> => {
  const registry = await startFakeRegistry(suite.cleanup, signer);
  registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer)), catalogue: signEnvelope(signer, "catalogue", catalogueDocument()) });
  return registry;
};

describe("a team-signed agent calls only the registry it was built with", () => {
  it("refuses to enrol with another server, and enrols with its own when none is given", async () => {
    const signer = createSigner();
    const builtIn = await servedRegistry(signer);
    const other = await servedRegistry(createSigner());
    const dataDir = await tempDir(suite.cleanup, "origin-enrol");
    const env = signedWith(builtIn.url);

    const refused = await command(dataDir, ["enrol", "--server", other.url, "--token", ENROL_TOKEN], env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`this Guard talks only to its built-in registry ${builtIn.url}`);
    expect(other.calls, "the other server is never called").toHaveLength(0);
    expect(await exists(path.join(dataDir, "device.json"))).toBe(false);
    expect(await exists(path.join(dataDir, POLICY_PIN))).toBe(false);

    const enrolled = await command(dataDir, ["enrol", "--token", ENROL_TOKEN], env);
    expect(enrolled.code, enrolled.stderr).toBe(0);
    expect(record(record(JSON.parse(await readFile(path.join(dataDir, "device.json"), "utf8"))).server).baseUrl).toBe(builtIn.url);
    expect(await json(dataDir, ["registry"], env)).toEqual({ fixed: true, origin: builtIn.url });
    const now = await status(dataDir, env);
    expect(now.server).toBe(builtIn.url);
    expect(now.registry).toEqual({ fixed: true, origin: builtIn.url });
  });

  it("never fetches the key from, or syncs with, the server an edited device.json names", async () => {
    const signer = createSigner();
    const builtIn = await servedRegistry(signer);
    const attacker = await servedRegistry(signer);
    const env = signedWith(builtIn.url);
    const unpinned = await createProfile(suite.cleanup, { signer, serverUrl: attacker.url, pinned: false });

    const refused = await command(unpinned.dataDir, ["sync"], env);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain(`this Guard talks only to its built-in registry ${builtIn.url}`);
    expect(attacker.calls, "no call reaches the edited server, so it never sees the bearer").toHaveLength(0);
    expect(builtIn.calls).toHaveLength(0);
    expect(await exists(path.join(unpinned.dataDir, POLICY_PIN)), "no key is pinned").toBe(false);
    const fetching = await status(unpinned.dataDir, env);
    expect(fetching.registry).toEqual({ fixed: true, origin: builtIn.url, reason: "registry-origin-mismatch" });
    expect(fetching.server, "the status panel shows only the built-in server").toBe(builtIn.url);
    expect(record(fetching.policyKey)).toEqual({ store: "keychain", reason: "policy-key-fetching" });

    const pinned = await createProfile(suite.cleanup, { signer, serverUrl: builtIn.url });
    const synced = await command(pinned.dataDir, ["sync"], env);
    expect(synced.code, synced.stderr).toBe(0);
    await pinned.writeDevice({ server: { baseUrl: attacker.url, syncIntervalSeconds: 60, batchSize: 100 } });
    const edited = await command(pinned.dataDir, ["sync"], env);
    expect(edited.code).not.toBe(0);
    expect(edited.stderr).toContain("talks only to its built-in registry");
    expect(attacker.calls).toHaveLength(0);
    const kept = await status(pinned.dataDir, env);
    expect(kept.bundleVersion, "the rules the pinned key verified stay loaded").toBe(1);
    expect(record(kept.registry).reason).toBe("registry-origin-mismatch");
  });

  it("fails closed when it was built with no registry address, or an invalid one", async () => {
    const signer = createSigner();
    const registry = await servedRegistry(signer);
    for (const origin of ["", "not a url", "ftp://registry.example", `${registry.url}/with-a-path`]) {
      const env = signedWith(origin);
      const dataDir = await tempDir(suite.cleanup, "origin-missing");
      for (const args of [["enrol", "--token", ENROL_TOKEN], ["enrol", "--server", registry.url, "--token", ENROL_TOKEN]]) {
        const refused = await command(dataDir, args, env);
        expect(refused.code, `${origin}: ${args.join(" ")}`).not.toBe(0);
        expect(refused.stderr, origin).toContain("this team-signed Guard has no valid built-in registry address");
      }
      const answer = await json(dataDir, ["registry"], env);
      expect(answer, origin).toMatchObject({ fixed: true, reason: "registry-origin-missing" });
      expect(answer.origin, origin).toBeUndefined();

      const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, pinned: false });
      const sync = await command(profile.dataDir, ["sync"], env);
      expect(sync.code, origin).not.toBe(0);
      expect(sync.stderr, origin).toContain("has no valid built-in registry address");
      expect(record((await status(profile.dataDir, env)).registry).reason, origin).toBe("registry-origin-missing");
    }
    expect(registry.calls, "a build with no usable origin calls nothing").toHaveLength(0);
  });

  it("accepts the built-in origin however device.json spells it", async () => {
    const signer = createSigner();
    const registry = await servedRegistry(signer);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: `${registry.url}/` });
    const synced = await command(profile.dataDir, ["sync"], signedWith(registry.url.replace("http://", "HTTP://")));
    expect(synced.code, synced.stderr).toBe(0);
    expect(registry.calls.map((call) => call.door)).toContain("preflight");
  });
});

describe("an unsigned or ad-hoc agent calls any registry, as before", () => {
  it("enrols and syncs with any server and reports that nothing fixes it", async () => {
    const signer = createSigner();
    const first = await servedRegistry(signer);
    const next = createSigner();
    const second = await servedRegistry(next);
    const dataDir = await tempDir(suite.cleanup, "origin-unsigned");
    for (const registry of [first, second]) {
      const enrolled = await command(dataDir, ["enrol", "--server", registry.url, "--token", ENROL_TOKEN]);
      expect(enrolled.code, enrolled.stderr).toBe(0);
      expect(registry.calls.map((call) => call.door)).toContain("enrol");
    }
    expect(await json(dataDir, ["registry"])).toEqual({ fixed: false });
    const now = await status(dataDir);
    expect(now.server).toBe(second.url);
    expect(now.registry).toEqual({ fixed: false });

    const missing = await command(dataDir, ["enrol", "--token", ENROL_TOKEN]);
    expect(missing.code, "an unsigned build has no server of its own to default to").not.toBe(0);
    expect(missing.stderr).toContain("invalid registry address");
  });
});
