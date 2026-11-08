import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, type Json } from "./harness.ts";
import { policyProfile, record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });

const syncAgainst = async (held: Json, served: Json): Promise<{ saved: Json; stderr: string }> => {
  const policy = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, policy);
  registry.serve({ bundle: signEnvelope(policy, "bundle", bundleDocument(policy, served)), catalogue: null });
  const profile = await policyProfile(suite, { catalogue: CHAT, serverUrl: registry.url, signer: policy, bundle: held });
  const result = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
  expect(registry.calls.some((call) => call.door === "ruledownload"), result.stderr).toBe(true);
  const saved = record(record(JSON.parse(await readFile(path.join(profile.dataDir, "bundle.json"), "utf8"))).bundle);
  return { saved, stderr: result.stderr };
};

describe("statechart C7: the policy save keeps the newest verified bundle", () => {
  it("I3: a sync never replaces a newer verified bundle with an older one", { timeout: 90_000 }, async () => {
    const { saved, stderr } = await syncAgainst({ bundleVersion: 2 }, { bundleVersion: 1 });
    expect(saved.bundleVersion, "the older v1 overwrote v2").toBe(2);
    expect(stderr, "the refusal is reported").toContain("older policy bundle");
  });

  it("a sync takes a bundle of the same version, because grants and mode change without a version bump", { timeout: 90_000 }, async () => {
    const { saved } = await syncAgainst({ bundleVersion: 2, clientMode: "enforce" }, { bundleVersion: 2, clientMode: "monitor" });
    expect(saved.clientMode, "the same-version bundle from the registry was saved").toBe("monitor");
  });
});
