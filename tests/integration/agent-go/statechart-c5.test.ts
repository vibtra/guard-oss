import { describe, expect, it } from "vitest";
import { startCaSigner } from "../../fakes/ca-signer.ts";
import { catalogueDocument, createSigner, startFakeRegistry, waitUntil } from "./harness.ts";
import { local, policyProfile, record, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });

describe("preflight mode", () => {
  it("reports the mode of the verified bundle the Mac runs, not the mode written at enrolment", { timeout: 90_000 }, async () => {
    const signer = await startCaSigner("ok");
    suite.cleanup.defer(signer.close);
    const policy = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, policy);
    registry.override((call) => (call.door === "ruledownload" ? { status: 500, body: { code: "INTERNAL", message: "download fails" } } : undefined));
    const profile = await policyProfile(suite, { catalogue: CHAT, serverUrl: registry.url, signer: policy, bundle: { clientMode: "enforce" } });
    await profile.writeDevice({ clientMode: "monitor", server: { baseUrl: registry.url, syncIntervalSeconds: 10, batchSize: 100 } });
    const agent = await startRunning(suite, profile, { env: signer.env });
    expect(record((await local(agent, "/status")).json()).bundleVersion).toBe(1);
    const preflight = await waitUntil("a preflight", async () => registry.calls.find((call) => call.door === "preflight"), 55_000);
    expect(record(preflight.body).clientMode, "the Mac enforces, so the console must not be told monitor").toBe("enforce");
  });
});
