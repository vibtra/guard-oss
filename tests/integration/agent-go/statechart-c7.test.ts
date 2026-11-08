import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, createSigner, runAgentCommand, signEnvelope, startFakeRegistry, type Json } from "./harness.ts";
import { policyProfile, record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });
const SIGNED_AT = Math.floor(Date.now() / 1000);

interface Signed {
  readonly bundle: Json;
  readonly iat: number;
}

const syncAgainst = async (held: Signed, served: Signed): Promise<{ saved: Json; stderr: string }> => {
  const policy = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, policy);
  registry.serve({ bundle: signEnvelope(policy, "bundle", bundleDocument(policy, served.bundle), { iat: served.iat }), catalogue: null });
  const profile = await policyProfile(suite, { catalogue: CHAT, serverUrl: registry.url, signer: policy });
  await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(policy, "bundle", bundleDocument(policy, held.bundle), { iat: held.iat })));
  const result = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
  expect(registry.calls.some((call) => call.door === "ruledownload"), result.stderr).toBe(true);
  const saved = record(record(JSON.parse(await readFile(path.join(profile.dataDir, "bundle.json"), "utf8"))).bundle);
  return { saved, stderr: result.stderr };
};

describe("statechart C7: the policy save keeps the newest verified bundle", () => {
  it("I3: a sync never replaces a newer verified bundle with an older one", { timeout: 90_000 }, async () => {
    const { saved, stderr } = await syncAgainst({ bundle: { bundleVersion: 2 }, iat: SIGNED_AT }, { bundle: { bundleVersion: 1 }, iat: SIGNED_AT + 60 });
    expect(saved.bundleVersion, "the older v1 overwrote v2").toBe(2);
    expect(stderr, "the refusal is reported").toContain("older policy bundle");
  });

  it("a sync never replaces a bundle with one of the same version signed earlier, such as one that still carries a revoked grant", { timeout: 90_000 }, async () => {
    const grant = { grantId: "grant_revoked", serviceId: "chat", scope: "user", expiresAt: "2099-01-01T00:00:00.000Z" };
    const { saved, stderr } = await syncAgainst({ bundle: { bundleVersion: 2, exceptions: [] }, iat: SIGNED_AT }, { bundle: { bundleVersion: 2, exceptions: [grant] }, iat: SIGNED_AT - 60 });
    expect(saved.exceptions, "the earlier v2 brought the revoked grant back").toEqual([]);
    expect(stderr, "the refusal is reported").toContain("older policy bundle");
  });

  it("a sync takes a bundle of the same version signed later, because grants and mode change without a version bump", { timeout: 90_000 }, async () => {
    const { saved } = await syncAgainst({ bundle: { bundleVersion: 2, clientMode: "enforce" }, iat: SIGNED_AT }, { bundle: { bundleVersion: 2, clientMode: "monitor" }, iat: SIGNED_AT + 60 });
    expect(saved.clientMode, "the later same-version bundle from the registry was saved").toBe("monitor");
  });
});
