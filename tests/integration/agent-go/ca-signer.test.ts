import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { startCaSigner, type CaSigner, type CaSignerMode } from "../../fakes/ca-signer.ts";
import { buildAgent } from "../../support/agent.ts";
import { GuardEnrolRequest, GuardPreflightRequest } from "@vibtra/guard-contract";
import { bundleDocument, catalogueDocument, createSigner, runAgentCommand, selfSignedCertificate, signEnvelope, startFakeRegistry, tempDir, waitUntil, type AgentProfile, type Json } from "./harness.ts";
import { local, policyProfile, record, startRunning, tlsThroughConnect, useAgentSuite, type Running } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });

const signerFor = async (mode: CaSignerMode = "ok"): Promise<CaSigner> => {
  const signer = await startCaSigner(mode);
  suite.cleanup.defer(signer.close);
  return signer;
};

const chatProfile = (): Promise<AgentProfile> => policyProfile(suite, { catalogue: CHAT });

const chatAgent = async (signer: CaSigner, profile?: AgentProfile, binary = suite.binary()): Promise<Running> =>
  startRunning({ ...suite, binary: () => binary }, profile ?? (await chatProfile()), { env: signer.env });

const statusOf = async (agent: Running): Promise<Json> => (await local(agent, "/status")).json();
const interception = async (agent: Running): Promise<Json> => record((await statusOf(agent)).interception);
const caStatus = async (agent: Running): Promise<Json> => record((await statusOf(agent)).ca);
const caPemOf = (agent: Running): Promise<string> => readFile(path.join(agent.dataDir, "ca.pem"), "utf8");

const connectReply = (agent: Running, host: string, port = 443): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const socket = net.connect(agent.proxyPort, "127.0.0.1");
    let received = "";
    socket.setTimeout(30_000, () => socket.destroy(new Error(`CONNECT ${host} timed out`)));
    socket.on("error", reject);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const end = received.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(received)?.[1]);
      const length = Number(/\r\ncontent-length: (\d+)/i.exec(received.slice(0, end))?.[1] ?? 0);
      if (status === 200 || received.length >= end + 4 + length) {
        socket.destroy();
        resolve({ status, body: received.slice(end + 4, end + 4 + length) });
      }
    });
    socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
  });

interface Origin {
  readonly port: number;
  readonly cert: string;
}

const startOrigin = async (): Promise<Origin> => {
  const { cert, key } = await selfSignedCertificate(suite.cleanup, "DNS:localhost");
  const server = tls.createServer({ cert, key }, (socket) => socket.end());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the TLS origin has no port");
  return { port: address.port, cert };
};

const passesThrough = async (agent: Running, origin: Origin): Promise<void> => {
  const socket = await tlsThroughConnect({ proxyPort: agent.proxyPort, caPem: origin.cert }, "localhost", origin.port);
  try {
    expect(socket.authorized, "the client reaches the origin and sees its own certificate").toBe(true);
    expect(new X509Certificate(socket.getPeerCertificate(true).raw).toString()).toBe(new X509Certificate(origin.cert).toString());
  } finally {
    socket.destroy();
  }
};

const intercepts = async (agent: Running, host: string, port = 443): Promise<X509Certificate> => {
  const socket = await tlsThroughConnect({ proxyPort: agent.proxyPort, caPem: await caPemOf(agent) }, host, port);
  try {
    expect(socket.authorized, `${host} verifies against the agent's CA`).toBe(true);
    return new X509Certificate(socket.getPeerCertificate(true).raw);
  } finally {
    socket.destroy();
  }
};

const isDerPrivateKey = (bytes: Buffer): boolean =>
  (["pkcs8", "sec1"] as const).some((type) => {
    try {
      createPrivateKey({ key: bytes, format: "der", type });
      return true;
    } catch {
      return false;
    }
  });

const pipelinedSession = async (signer: CaSigner, pipeline: "request-with-hello" | "oversize-before-hello" | "two-requests-after-ready"): Promise<string> => {
  const socket = net.connect(signer.socket);
  socket.on("error", () => undefined);
  const closed = once(socket, "close");
  let received = "";
  socket.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  const nonce = await waitUntil("the nonce", async () => /^nonce (\S+)\n/.exec(received)?.[1], 5_000);
  received = "";
  if (pipeline === "request-with-hello") socket.write(`hello ${nonce}\nkeys\n`);
  else if (pipeline === "oversize-before-hello") socket.write(`${"x".repeat(70_000)}\n`);
  else {
    socket.write(`hello ${nonce}\n`);
    await waitUntil("ready", async () => (received === "ready\n" ? true : undefined), 5_000);
    received = "";
    socket.write("keys\nkeys\n");
  }
  await closed;
  return received;
};

const privateKeyFiles = async (dir: string): Promise<string[]> => {
  const found: string[] = [];
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const bytes = await readFile(file);
    if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(bytes.toString("latin1")) || isDerPrivateKey(bytes)) found.push(file);
  }
  return found;
};

describe("the interception CA key lives in the Guard app's signer", () => {
  it("creates the CA through the signer, signs each site certificate there, and writes no private key under the agent's folder", async () => {
    const signer = await signerFor();
    const profile = await chatProfile();
    const agent = await chatAgent(signer, profile);
    expect(await interception(agent)).toEqual({ on: true });
    expect(await caStatus(agent)).toMatchObject({ keyStore: "secure-enclave", signer: "connected" });
    const caPem = await caPemOf(agent);
    const ca = new X509Certificate(caPem);
    expect(ca.ca).toBe(true);
    expect(ca.verify(ca.publicKey), "the CA is self-signed by the signer's key").toBe(true);

    const leaf = await intercepts(agent, "chatgpt.com");
    expect(leaf.checkIssued(ca) && leaf.verify(ca.publicKey), "the site certificate is signed by the CA").toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:chatgpt.com");
    await intercepts(agent, "chatgpt.com");
    expect(signer.requests("sign"), "the site certificate is cached").toBe(1);
    expect(await privateKeyFiles(agent.dataDir)).toEqual([]);

    await agent.close();
    const again = await chatAgent(signer, profile);
    expect(await caPemOf(again), "a restart keeps the CA").toBe(caPem);
    expect([signer.requests("create"), await interception(again)]).toEqual([1, { on: true }]);
    await intercepts(again, "api.chatgpt.com");
  });

  it.each([
    ["refuse-unsigned", "unsigned-build", "refused"],
    ["refuse-requirement", "unsigned-build", "refused"],
    ["no-se", "no-secure-enclave", "connected"],
    ["keychain-error", "key-unavailable", "connected"],
  ] as const)("signer %s at start: interception off (%s), inspected hosts pass through uninspected, and it intercepts once the signer works", async (mode, reason, state) => {
    const signer = await signerFor(mode);
    const origin = await startOrigin();
    const agent = await chatAgent(signer);
    expect(await interception(agent)).toEqual({ on: false, reason });
    expect(await caStatus(agent)).toMatchObject({ signer: state });
    expect(await caStatus(agent)).not.toHaveProperty("keyStore");
    await passesThrough(agent, origin);
    const cli = await runAgentCommand(suite.binary(), ["status", "--local", new URL(agent.localUrl).host], { dataDir: agent.dataDir, env: signer.env });
    expect([cli.code, cli.stderr.trim()]).toEqual([0, `interception off: ${reason.replaceAll("-", " ")}`]);

    await signer.setMode("ok");
    await waitUntil("the agent to intercept once the signer works", async () => {
      await connectReply(agent, "localhost", origin.port);
      return (await interception(agent)).on === true ? true : undefined;
    });
    await intercepts(agent, "localhost", origin.port);
    await intercepts(agent, "chatgpt.com");
  });

  it.each([
    ["refuse-binding", "refused"],
    ["down", "unavailable"],
  ] as const)("signer %s at start: interception off (signer-unavailable), inspected hosts get 502, and it recovers when the signer works", async (mode, state) => {
    const signer = await signerFor(mode);
    const agent = await chatAgent(signer);
    expect(await interception(agent)).toEqual({ on: false, reason: "signer-unavailable" });
    expect(await caStatus(agent)).toMatchObject({ signer: state });
    expect(await caStatus(agent)).not.toHaveProperty("keyStore");
    expect(await connectReply(agent, "chatgpt.com")).toEqual({ status: 502, body: "This Mac cannot protect AI traffic: signer unavailable\n" });
    const cli = await runAgentCommand(suite.binary(), ["status", "--local", new URL(agent.localUrl).host], { dataDir: agent.dataDir, env: signer.env });
    expect([cli.code, cli.stderr.trim()]).toEqual([0, "interception off: signer unavailable"]);

    await signer.setMode("ok");
    await waitUntil("the agent to intercept once the signer works", async () => ((await connectReply(agent, "chatgpt.com")).status === 200 ? true : undefined));
    await intercepts(agent, "chatgpt.com");
    expect(await interception(agent)).toEqual({ on: true });
  });

  it.each([
    ["bad-nonce-length", 0],
    ["bad-nonce-base64", 0],
    ["bad-ready", 1],
  ] as const)("signer %s at connect: the agent sends no request and reports signer-unavailable", async (mode, hellos) => {
    const signer = await signerFor(mode);
    const agent = await chatAgent(signer);
    expect(await interception(agent)).toEqual({ on: false, reason: "signer-unavailable" });
    expect(await caStatus(agent)).toMatchObject({ signer: "unavailable" });
    expect(await connectReply(agent, "chatgpt.com")).toEqual({ status: 502, body: "This Mac cannot protect AI traffic: signer unavailable\n" });
    expect(["hello", "keys", "create", "pub", "sign"].map((op) => signer.requests(op) > 0)).toEqual([hellos > 0, false, false, false, false]);
  });

  it.each([
    ["request-with-hello", "err unauthorised binding\n"],
    ["oversize-before-hello", "err unauthorised binding\n"],
    ["two-requests-after-ready", ""],
  ] as const)("the fake signer refuses a pipelining client the way the app does: %s", async (pipeline, reply) => {
    const signer = await signerFor();
    expect(await pipelinedSession(signer, pipeline)).toBe(reply);
    expect(signer.requests("keys"), "no pipelined request was answered").toBe(0);
  });

  it("leaves interception off when the signer refuses to sign the CA, passes inspected hosts through, prunes nothing, and makes a fresh CA once it does", async () => {
    const signer = await signerFor("refuse-ca");
    const origin = await startOrigin();
    const agent = await chatAgent(signer);
    expect(await interception(agent)).toEqual({ on: false, reason: "key-unavailable" });
    expect((await caStatus(agent)).lastSignError).toContain("err policy spki-mismatch");
    expect([signer.requests("keys"), signer.requests("prune")]).toEqual([0, 0]);
    expect((await readdir(agent.dataDir)).includes("ca.pem")).toBe(false);
    await passesThrough(agent, origin);

    await signer.setMode("ok");
    await waitUntil("a CA once the signer signs it", async () => {
      await connectReply(agent, "localhost", origin.port);
      return (await interception(agent)).on === true ? true : undefined;
    });
    await intercepts(agent, "localhost", origin.port);
    const ca = new X509Certificate(await caPemOf(agent));
    expect(await signer.keys()).toContain(createHash("sha256").update(ca.publicKey.export({ type: "spki", format: "der" })).digest("hex"));
    expect([signer.requests("keys"), signer.requests("prune")]).toEqual([0, 0]);
  });

  it("signer loses the key while running: interception off (key-unavailable), a new host passes through, and it intercepts again once the key is back", async () => {
    const signer = await signerFor();
    const origin = await startOrigin();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    await signer.setMode("no-key");
    await passesThrough(agent, origin);
    expect(await interception(agent)).toEqual({ on: false, reason: "key-unavailable" });
    expect((await connectReply(agent, "chatgpt.com")).status, "a cached host keeps its Guard certificate").toBe(200);

    await signer.setMode("ok");
    await waitUntil("the signer to sign again", async () => {
      await connectReply(agent, "localhost", origin.port);
      return (await interception(agent)).on === true ? true : undefined;
    });
    await intercepts(agent, "localhost", origin.port);
  });

  it.each([
    ["bad-signature", "the certificate could not be signed", { on: true }],
    ["keychain-error", "the certificate could not be signed", { on: true }],
    ["slow", "signer unavailable", { on: false, reason: "signer-unavailable" }],
  ] as const)("signer %s while running: the new host gets 502, nothing is cached, and the host works once the signer does", { timeout: 60_000 }, async (mode, words, state) => {
    const signer = await signerFor();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    await signer.setMode(mode);
    expect(await connectReply(agent, "api.chatgpt.com")).toEqual({ status: 502, body: `This Mac cannot protect AI traffic: ${words}\n` });
    expect(await interception(agent)).toEqual(state);
    expect((await caStatus(agent)).lastSignError).toEqual(expect.any(String));
    expect((await connectReply(agent, "chatgpt.com")).status, "a cached host keeps working").toBe(200);

    await signer.setMode("ok");
    const signs = signer.requests("sign");
    await waitUntil("the signer to sign again", async () => ((await connectReply(agent, "api.chatgpt.com")).status === 200 ? true : undefined));
    expect(signer.requests("sign"), "the failed host was not cached").toBeGreaterThan(signs);
    await intercepts(agent, "api.chatgpt.com");
    expect(await interception(agent)).toEqual({ on: true });
  });

  it("turns interception off, passes inspected hosts through and leaves the files alone when the signer lost the CA's key or a legacy ca.key is present", async () => {
    const signer = await signerFor();
    const origin = await startOrigin();
    const profile = await chatProfile();
    const first = await chatAgent(signer, profile);
    const caPem = await caPemOf(first);
    await first.close();
    await signer.setMode("no-key");
    const lost = await chatAgent(signer, profile);
    expect(await interception(lost)).toEqual({ on: false, reason: "key-unavailable" });
    await passesThrough(lost, origin);
    expect([await caPemOf(lost), signer.requests("create")]).toEqual([caPem, 1]);
    await lost.close();

    await signer.setMode("ok");
    const legacy = await chatProfile();
    await writeFile(path.join(legacy.dataDir, "ca.key"), "placeholder for a pre-Secure-Enclave key file\n");
    const agent = await chatAgent(signer, legacy);
    expect(await interception(agent)).toEqual({ on: false, reason: "key-unavailable" });
    await passesThrough(agent, origin);
    expect(await readFile(path.join(legacy.dataDir, "ca.key"), "utf8")).toBe("placeholder for a pre-Secure-Enclave key file\n");
    expect((await readdir(legacy.dataDir)).includes("ca.pem")).toBe(false);
    expect(signer.requests("create")).toBe(1);
  });

  it("enrols and syncs with no CA, leaving ca out of enrol and preflight as the contract allows", async () => {
    const signer = await signerFor("down");
    const policy = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, policy);
    registry.serve({ bundle: signEnvelope(policy, "bundle", bundleDocument(policy)), catalogue: signEnvelope(policy, "catalogue", catalogueDocument()) });
    const dataDir = await tempDir(suite.cleanup, "no-ca");
    for (const args of [["enrol", "--server", registry.url, "--token", `genr_${"0".repeat(32)}`], ["sync"]]) {
      const result = await runAgentCommand(suite.binary(), args, { dataDir, env: signer.env });
      expect(result.code, `${args[0] ?? ""}: ${result.stderr}`).toBe(0);
    }
    const enrols = registry.calls.filter((call) => call.door === "enrol");
    const preflights = registry.calls.filter((call) => call.door === "preflight");
    expect([enrols.length, preflights.length]).toEqual([1, 2]);
    for (const call of [...enrols, ...preflights]) expect(record(call.body)).not.toHaveProperty("ca");
    expect(GuardEnrolRequest.safeParse(enrols[0]?.body).error).toBeUndefined();
    for (const call of preflights) expect(GuardPreflightRequest.safeParse(call.body).error).toBeUndefined();
  });

  it.each(["down", "ok"] as const)("runs status and test with the signer %s, without asking it for anything", async (mode) => {
    const signer = await signerFor(mode);
    const profile = await chatProfile();
    for (const args of [["status", "--local", "127.0.0.1:9"], ["test", "--host", "chatgpt.com"]]) {
      const result = await runAgentCommand(suite.binary(), args, { dataDir: profile.dataDir, env: signer.env });
      expect(result.code, `${args.join(" ")}: ${result.stderr}`).toBe(0);
    }
    expect(["keys", "create", "pub", "sign"].map((op) => signer.requests(op))).toEqual([0, 0, 0, 0]);
  });

  it.runIf(process.platform === "linux")("a plain Linux build never intercepts, even over a legacy data folder: unsupported-platform, pass-through, no CA sent", { timeout: 600_000 }, async () => {
    const plain = await buildAgent({ withoutCaSigner: true });
    suite.cleanup.defer(plain.close);
    const signer = await signerFor();
    const origin = await startOrigin();
    const policy = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, policy);
    registry.serve({ bundle: signEnvelope(policy, "bundle", bundleDocument(policy)), catalogue: signEnvelope(policy, "catalogue", CHAT) });
    const legacyCa = await selfSignedCertificate(suite.cleanup, "DNS:legacy-ca.example");
    for (const legacy of [false, true]) {
      const profile = await policyProfile(suite, { catalogue: CHAT, serverUrl: registry.url, signer: policy });
      if (legacy) {
        await writeFile(path.join(profile.dataDir, "ca.key"), "placeholder for a pre-Secure-Enclave key file\n");
        await writeFile(path.join(profile.dataDir, "ca.pem"), legacyCa.cert);
      }
      const before = registry.calls.length;
      const agent = await chatAgent(signer, profile, plain.path);
      expect(await interception(agent), `legacy ${legacy}`).toEqual({ on: false, reason: "unsupported-platform" });
      await passesThrough(agent, origin);
      expect(await caStatus(agent)).not.toHaveProperty("fingerprintSha256");
      const preflight = await waitUntil("a preflight", async () => registry.calls.slice(before).find((call) => call.door === "preflight"));
      expect(record(preflight.body)).not.toHaveProperty("ca");
      expect(await readFile(path.join(profile.dataDir, "ca.pem"), "utf8").catch(() => undefined)).toBe(legacy ? legacyCa.cert : undefined);
      await agent.close();
    }
    expect(signer.requests("create") + signer.requests("pub")).toBe(0);
  });
});
