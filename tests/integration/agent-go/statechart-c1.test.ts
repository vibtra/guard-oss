import { createHash, X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import tls from "node:tls";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startCaSigner, type CaSigner, type CaSignerMode } from "../../fakes/ca-signer.ts";
import { startFakeSecurity } from "../../fakes/security.ts";
import { catalogueDocument, createSigner, runAgentCommand, selfSignedCertificate, startFakeRegistry, waitUntil, type AgentProfile, type Json } from "./harness.ts";
import { local, policyProfile, record, startRunning, tlsThroughConnect, useAgentSuite, type Running } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });
const AWAITING_TRUST = { on: false, reason: "awaiting-trust" };

const statusOf = async (agent: Running): Promise<Json> => (await local(agent, "/status")).json();
const interception = async (agent: Running): Promise<Json> => record((await statusOf(agent)).interception);
const caPemOf = (agent: Running): Promise<string> => readFile(path.join(agent.dataDir, "ca.pem"), "utf8");
const keyIdOfPem = (pem: string): string => createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("hex");

const leafOf = async (agent: Running, caPem: string, host: string, port = 443): Promise<X509Certificate> => {
  const socket = await tlsThroughConnect({ proxyPort: agent.proxyPort, caPem }, host, port, { rejectUnauthorized: false });
  try {
    return new X509Certificate(socket.getPeerCertificate(true).raw);
  } finally {
    socket.destroy();
  }
};

const afterSyncs = async (agent: Running, count: number): Promise<void> => {
  const seen = new Set<unknown>([record((await statusOf(agent)).lastSync).at]);
  await waitUntil(`${count} syncs`, async () => {
    seen.add(record((await statusOf(agent)).lastSync).at);
    return seen.size > count ? true : undefined;
  }, 55_000);
};

interface Trusted {
  readonly signer: CaSigner;
  readonly agent: Running;
  readonly oldPem: string;
  trustAgain(): Promise<void>;
}

const trustedAgentThatLosesItsKey = async (profile: AgentProfile, seen = { host: "chatgpt.com", port: 443 }, mode: CaSignerMode = "ok"): Promise<Trusted> => {
  const signer = await startCaSigner("ok");
  suite.cleanup.defer(signer.close);
  const security = await startFakeSecurity();
  suite.cleanup.defer(security.close);
  const agent = await startRunning(suite, profile, { env: { ...signer.env, ...security.env } });
  const trustAgain = async (): Promise<void> => {
    const trusted = await runAgentCommand(suite.binary(), ["ca", "trust", "--local", new URL(agent.localUrl).host], { dataDir: agent.dataDir, env: { ...signer.env, ...security.env } });
    expect(trusted.code, trusted.stderr).toBe(0);
  };
  await trustAgain();
  await leafOf(agent, await caPemOf(agent), seen.host, seen.port);
  expect(await interception(agent)).toEqual({ on: true });
  const oldPem = await caPemOf(agent);
  await signer.setMode(mode);
  await signer.removeKey(keyIdOfPem(oldPem));
  return { signer, agent, oldPem, trustAgain };
};

describe("statechart C1: a sync that finds the Secure Enclave key gone", () => {
  it("K2: stops reporting interception on and asks for trust in a new certificate", { timeout: 90_000 }, async () => {
    const { signer, agent, oldPem } = await trustedAgentThatLosesItsKey(await policyProfile(suite, { catalogue: CHAT }));
    await afterSyncs(agent, 2);
    expect(await interception(agent), "the key is gone, so the Mac must not say Protection is on").toEqual(AWAITING_TRUST);
    expect(await caPemOf(agent), "the sync made a new CA without waiting for a new site").not.toBe(oldPem);
    expect(await signer.keys()).toEqual([keyIdOfPem(await caPemOf(agent))]);
  });

  it("K3: the preflight after the key is gone does not tell the console interception is on", { timeout: 90_000 }, async () => {
    const policy = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, policy);
    registry.serve({ bundle: null, catalogue: null });
    const profile = await policyProfile(suite, { catalogue: CHAT, serverUrl: registry.url, signer: policy });
    await profile.writeDevice({ server: { baseUrl: registry.url, syncIntervalSeconds: 10, batchSize: 100 } });
    await trustedAgentThatLosesItsKey(profile);
    const before = registry.calls.length;
    const preflight = await waitUntil("the second preflight after the key loss", async () => registry.calls.slice(before).filter((call) => call.door === "preflight")[1], 55_000);
    expect(record(record(preflight.body).health).interception, "the console must not keep Protected for a Mac whose key is gone").toEqual(AWAITING_TRUST);
  });

  it("K4: a site seen before gets its certificate from the new CA, not from the lost key", { timeout: 90_000 }, async () => {
    const { agent, oldPem, trustAgain } = await trustedAgentThatLosesItsKey(await policyProfile(suite, { catalogue: CHAT }));
    await afterSyncs(agent, 2);
    await trustAgain();
    const leaf = await leafOf(agent, await caPemOf(agent), "chatgpt.com");
    expect(leaf.verify(new X509Certificate(oldPem).publicKey), "a leaf of the lost key was served from the cache").toBe(false);
    expect(leaf.verify(new X509Certificate(await caPemOf(agent)).publicKey), "the leaf comes from the new CA").toBe(true);
  });

  it("K4, no new CA: when the new CA cannot be made, a site seen before is not served a leaf of the lost key and the Mac says the key is unavailable", { timeout: 90_000 }, async () => {
    const { cert, key } = await selfSignedCertificate(suite.cleanup, "DNS:localhost");
    const origin = tls.createServer({ cert, key }, (socket) => socket.end());
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    suite.cleanup.defer(() => new Promise((resolve) => origin.close(resolve)));
    const address = origin.address();
    if (address === null || typeof address === "string") throw new Error("the TLS origin has no port");
    const { agent, oldPem } = await trustedAgentThatLosesItsKey(await policyProfile(suite, { catalogue: CHAT }), { host: "localhost", port: address.port }, "keychain-error");
    await afterSyncs(agent, 2);
    expect(await interception(agent)).toEqual({ on: false, reason: "key-unavailable" });
    const leaf = await leafOf(agent, oldPem, "localhost", address.port);
    expect(leaf.verify(new X509Certificate(oldPem).publicKey), "a leaf of the lost key was served from the cache").toBe(false);
    expect(leaf.toString(), "the request passed through to the origin").toBe(new X509Certificate(cert).toString());
  });
});
