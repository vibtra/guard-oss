import { describe, expect, it } from "vitest";
import { launchAgent } from "../../support/agent.ts";
import { isRecord } from "../../support/guards.ts";
import { bundleDocument, catalogueDocument, createSigner, signEnvelope, waitUntil, type Json, type PolicySigner } from "./harness.ts";
import { local, policyProfile, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const REFUSED = "policy-rolled-back";
const now = (): number => Math.floor(Date.now() / 1000);

const signedPair = (signer: PolicySigner, bundle: Json, iat: number): string =>
  JSON.stringify({
    bundle: signEnvelope(signer, "bundle", bundleDocument(signer, bundle), { iat }),
    catalogue: signEnvelope(signer, "catalogue", catalogueDocument()),
  });

const statusOf = async (agent: { readonly localUrl: string }): Promise<Json> => (await local(agent, "/status")).json();
const loadReason = (status: Json): unknown => (isRecord(status.policyLoad) ? status.policyLoad.reason : undefined);

describe("a signed policy pair rolled back on disk", () => {
  it("never replaces the pair the agent accepted, and is refused again after a restart", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const profile = await policyProfile(suite, { signer, bundle: { bundleVersion: 2, protectionRevision: 5, clientMode: "enforce" } });
    const agent = await startRunning(suite, profile);
    const loaded = await statusOf(agent);
    expect([loaded.clientMode, loaded.bundleVersion]).toEqual(["enforce", 2]);

    await profile.writeFile("active-policy.json", signedPair(signer, { bundleVersion: 2, protectionRevision: 4, clientMode: "off" }, now()));
    await waitUntil(
      "the agent to refuse the rolled-back pair",
      async () => {
        const status = await statusOf(agent);
        expect(status.clientMode, "the agent went Off on a pair at a lower protection revision").toBe("enforce");
        return loadReason(status) === REFUSED ? true : undefined;
      },
      15_000,
    );
    expect((await statusOf(agent)).bundleVersion, "the agent kept the pair it verified").toBe(2);

    await agent.close();
    const restarted = await launchAgent({ binary: suite.binary(), dataDir: profile.dataDir });
    suite.cleanup.defer(restarted.close);
    const after = await statusOf(restarted);
    expect([after.clientMode, after.bundleVersion, loadReason(after)], "a restart loaded the rolled-back pair").toEqual(["enforce", undefined, REFUSED]);
  });

  it("stays refused when device.json names another organisation, because the floor belongs to the pinned key", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const profile = await policyProfile(suite, { signer, bundle: { bundleVersion: 2, protectionRevision: 5, clientMode: "enforce" } });
    const agent = await startRunning(suite, profile);
    expect((await statusOf(agent)).bundleVersion).toBe(2);
    await agent.close();

    await profile.writeFile("active-policy.json", signedPair(signer, { bundleVersion: 2, protectionRevision: 4, clientMode: "off" }, now()));
    await profile.writeDevice({ orgId: "org_other" });
    const restarted = await launchAgent({ binary: suite.binary(), dataDir: profile.dataDir });
    suite.cleanup.defer(restarted.close);
    const after = await statusOf(restarted);
    expect([after.clientMode, after.bundleVersion, loadReason(after)], "an edited device.json lifted the floor").toEqual(["enforce", undefined, REFUSED]);
  });
});
