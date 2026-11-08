import { createHash, createPrivateKey, X509Certificate } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { startCaSigner, type CaSigner, type CaSignerMode } from "../../fakes/ca-signer.ts";
import { FAIL_ENV, startFakeSecurity, type FakeSecurity } from "../../fakes/security.ts";
import { buildAgent } from "../../support/agent.ts";
import { GuardEnrolRequest, GuardPreflightRequest } from "@vibtra/guard-contract";
import { bundleDocument, catalogueDocument, createSigner, runAgentCommand, selfSignedCertificate, signEnvelope, startFakeRegistry, tempDir, waitUntil, type AgentProfile, type CommandResult, type Json } from "./harness.ts";
import { local, policyProfile, record, relayConnect, startRunning, tlsOn, tlsThroughConnect, useAgentSuite, type Running } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com", "localhost"], bundleIds: [], cliNames: [], custom: true }] });

const signerFor = async (mode: CaSignerMode = "ok"): Promise<CaSigner> => {
  const signer = await startCaSigner(mode);
  suite.cleanup.defer(signer.close);
  return signer;
};

const chatProfile = (): Promise<AgentProfile> => policyProfile(suite, { catalogue: CHAT });

const chatAgent = async (signer: CaSigner, profile?: AgentProfile, binary = suite.binary(), env: Readonly<Record<string, string>> = {}, transparent = false): Promise<Running> =>
  startRunning({ ...suite, binary: () => binary }, profile ?? (await chatProfile()), { env: { ...signer.env, ...env }, transparent });

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
  connections(): number;
}

const startOrigin = async (): Promise<Origin> => {
  const { cert, key } = await selfSignedCertificate(suite.cleanup, "DNS:localhost");
  const server = tls.createServer({ cert, key }, (socket) => socket.end());
  let connections = 0;
  server.on("connection", () => (connections += 1));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the TLS origin has no port");
  return { port: address.port, cert, connections: () => connections };
};

const throughTransparent = async (agent: Running, origin: Origin): Promise<{ certificate: string } | { refused: string }> => {
  const raw = net.connect(agent.transparentPort, "127.0.0.1");
  await once(raw, "connect");
  raw.write(`PROXY TCP4 127.0.0.1 127.0.0.1 12345 ${origin.port}\r\n`);
  try {
    const socket = await tlsOn(raw, "localhost", { ca: origin.cert });
    try {
      return { certificate: new X509Certificate(socket.getPeerCertificate(true).raw).toString() };
    } finally {
      socket.destroy();
    }
  } catch (error) {
    raw.destroy();
    return { refused: error instanceof Error ? error.message : String(error) };
  }
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
    expect(await caStatus(agent)).toMatchObject({ state: "ready", staleCAs: 0, keyStore: "secure-enclave", signer: "connected" });
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

  it("transparent mode, signer no-se: the connection reaches the origin uninspected and sees the origin's own certificate", async () => {
    const signer = await signerFor("no-se");
    const origin = await startOrigin();
    const agent = await chatAgent(signer, undefined, undefined, {}, true);
    expect(await interception(agent)).toEqual({ on: false, reason: "no-secure-enclave" });
    expect(await throughTransparent(agent, origin)).toEqual({ certificate: new X509Certificate(origin.cert).toString() });
    expect(origin.connections()).toBe(1);
  });

  it("transparent mode, signer down: the connection is closed and the origin sees nothing", async () => {
    const signer = await signerFor("down");
    const origin = await startOrigin();
    const agent = await chatAgent(signer, undefined, undefined, {}, true);
    expect(await interception(agent)).toEqual({ on: false, reason: "signer-unavailable" });
    expect(await throughTransparent(agent, origin)).toEqual({ refused: expect.any(String) });
    expect(origin.connections()).toBe(0);
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

  it("leaves interception off, passes inspected hosts through and prunes nothing while the signer refuses to sign the CA, then makes a fresh CA and prunes the leftover key once it does", async () => {
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
    const id = keyIdOfPem(await caPemOf(agent));
    expect(signer.lines("prune"), "once a CA exists, the refused attempt's key is pruned").toEqual([`prune ${id}`]);
    expect(await signer.keys()).toEqual([id]);
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

  it("follows the signer at each sync with only a pub request: off (signer-unavailable) when it stops, on again when it is back, with no site certificate signed in between", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    const id = keyIdOfPem(await caPemOf(agent));
    const asked = (): number[] => ["create", "ca", "sign", "keys", "prune"].map((op) => signer.requests(op));
    const before = asked();

    await signer.setMode("down");
    await waitUntil("a sync to see the signer stopped", async () => ((await interception(agent)).on === false ? true : undefined));
    expect(await interception(agent)).toEqual({ on: false, reason: "signer-unavailable" });
    expect(await caStatus(agent)).toMatchObject({ state: "off", signer: "unavailable" });
    expect((await connectReply(agent, "chatgpt.com")).status, "the cached host is still inspected").toBe(200);

    const pubs = signer.requests("pub");
    await signer.setMode("ok");
    await waitUntil("a sync to see the signer is back", async () => ((await interception(agent)).on === true ? true : undefined));
    expect(await caStatus(agent)).toMatchObject({ state: "ready", signer: "connected", keyStore: "secure-enclave" });
    expect(signer.requests("pub"), "the sync asked the signer for its key").toBeGreaterThan(pubs);
    expect(new Set(signer.lines("pub"))).toEqual(new Set([`pub ${id}`]));
    expect(asked(), "the probe made no key, CA or site certificate, and pruned nothing").toEqual(before);
  });

  const holdsAcrossSyncs = async (agent: Running, want: Json, ca: Json): Promise<void> => {
    const syncs = new Set<unknown>();
    await waitUntil("three whole syncs after the change", async () => {
      const status = await statusOf(agent);
      expect(record(status.interception)).toEqual(want);
      expect(record(status.ca)).toMatchObject(ca);
      syncs.add(record(status.lastSync).at);
      return syncs.size > 4 ? true : undefined;
    });
  };
  const staysOnAcrossSyncs = (agent: Running): Promise<void> => holdsAcrossSyncs(agent, { on: true }, { state: "ready", signer: "connected" });

  it("makes a new CA at the sync that finds the signer no longer has the key, and signs a site seen before with it", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    const caPem = await caPemOf(agent);
    const fingerprint = createHash("sha256").update(new X509Certificate(caPem).raw).digest("hex");
    await signer.removeKey(keyIdOfPem(caPem));

    await waitUntil("a sync to make a new CA", async () => {
      const now = (await caStatus(agent)).fingerprintSha256;
      return now !== undefined && now !== fingerprint ? true : undefined;
    });
    expect(signer.requests("sign"), "the sync made the new CA without signing a site certificate").toBe(1);
    expect([signer.requests("create"), (await caStatus(agent)).staleCAs]).toEqual([2, 1]);

    const leaf = await intercepts(agent, "chatgpt.com");
    expect(leaf.verify(new X509Certificate(await caPemOf(agent)).publicKey), "the site certificate comes from the new CA, not the cache").toBe(true);
  });

  it("keeps interception on at sync while the signer answers pub with a keychain error", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    await signer.setMode("keychain-error");
    await staysOnAcrossSyncs(agent);
    expect(signer.requests("create")).toBe(1);
  });

  it("reports unsigned-build at sync when the app starts refusing an agent that holds a key, and keeps reporting it", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const agent = await chatAgent(signer);
    await intercepts(agent, "chatgpt.com");
    await signer.setMode("refuse-requirement");
    await waitUntil("a sync to see the refusal", async () => ((await interception(agent)).on === false ? true : undefined));
    await holdsAcrossSyncs(agent, { on: false, reason: "unsigned-build" }, { state: "off", signer: "refused" });
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

const CLOSED_PORT = 9;
const keyIdOfPem = (pem: string): string => createHash("sha256").update(new X509Certificate(pem).publicKey.export({ type: "spki", format: "der" })).digest("hex");
const staleName = (pem: string): string => `ca-stale-${createHash("sha256").update(new X509Certificate(pem).raw).digest("hex").slice(0, 12)}.pem`;
const pemBlocks = (text: string): string[] => text.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/g) ?? [];

describe("a new interception CA waits for trust, and earlier CAs are cleaned up", () => {
  const securityFor = async (): Promise<FakeSecurity> => {
    const security = await startFakeSecurity();
    suite.cleanup.defer(security.close);
    return security;
  };
  const caTrust = (agent: { readonly dataDir: string; readonly localUrl: string }, env: Readonly<Record<string, string>>, fail?: string): Promise<CommandResult> =>
    runAgentCommand(suite.binary(), ["ca", "trust", "--local", new URL(agent.localUrl).host], { dataDir: agent.dataDir, env: { ...env, ...(fail === undefined ? {} : { [FAIL_ENV]: fail }) } });
  const holdUntil = async (agent: Running): Promise<number> => Date.parse(String((await caStatus(agent)).holdUntil));
  const callLocal = (agent: Running, localPath: string, options: { method?: string; headers?: Readonly<Record<string, string>> } = {}): Promise<number> =>
    new Promise((resolve, reject) => {
      const url = new URL(localPath, agent.localUrl);
      const request = http.request({ host: url.hostname, port: url.port, path: url.pathname, method: options.method ?? "POST", headers: options.headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
  const pending = <T>(promise: Promise<T>): (() => boolean) => {
    let settled = false;
    void promise.finally(() => (settled = true));
    return () => !settled;
  };

  it("holds a request for a new CA and lets it through once ca trust trusts the CA", async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const env = { ...signer.env, ...security.env };
    const agent = await chatAgent(signer, undefined, undefined, security.env);
    expect(await interception(agent)).toEqual({ on: false, reason: "awaiting-trust" });
    const ca = await caStatus(agent);
    expect(ca).toMatchObject({ state: "awaiting-trust", staleCAs: 0, keyStore: "secure-enclave" });
    expect(Date.parse(String(ca.holdUntil))).toBeGreaterThan(Date.now());

    const held = connectReply(agent, "localhost", CLOSED_PORT);
    const stillHeld = pending(held);
    await delay(3_000);
    expect(stillHeld(), "the request waits for trust").toBe(true);
    const trusted = await caTrust(agent, env);
    expect(trusted.code, trusted.stderr).toBe(0);
    expect(await held, "the held request is intercepted, not passed through to a closed port").toEqual({ status: 200, body: "" });
    expect(security.trusted(await caPemOf(agent))).toBe(true);
    await intercepts(agent, "chatgpt.com");
    expect(await interception(agent)).toEqual({ on: true });
    expect(await caStatus(agent)).toMatchObject({ state: "ready" });
    expect(await caStatus(agent)).not.toHaveProperty("holdUntil");
  });

  it("passes the request through uninspected when the hold ends untrusted, at once after it, and ca trust opens the hold again", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const origin = await startOrigin();
    const env = { ...signer.env, ...security.env };
    const agent = await chatAgent(signer, undefined, undefined, { ...security.env, VIBTRA_GUARD_CA_HOLD_SECONDS: "6" });
    const until = await holdUntil(agent);
    await passesThrough(agent, origin);
    expect(Date.now(), "the request waited until the hold ended").toBeGreaterThanOrEqual(until);
    expect(await caStatus(agent)).not.toHaveProperty("holdUntil");
    const started = Date.now();
    await passesThrough(agent, origin);
    expect(Date.now() - started, "outside the hold the request passes through at once").toBeLessThan(1_500);
    expect(await interception(agent)).toEqual({ on: false, reason: "awaiting-trust" });
    expect(signer.requests("sign"), "nothing was signed").toBe(0);

    const cancelled = await caTrust(agent, env, "add-trusted-cert");
    expect(cancelled.code).not.toBe(0);
    expect(Date.parse(String((await caStatus(agent)).holdUntil)), "ca trust opened the hold again").toBeGreaterThan(Date.now());
    const held = connectReply(agent, "localhost", CLOSED_PORT);
    const trusted = await caTrust(agent, env);
    expect(trusted.code, trusted.stderr).toBe(0);
    expect(await held, "the held request is intercepted, not passed through to a closed port").toEqual({ status: 200, body: "" });
  });

  it.each(["the key was deleted", "a legacy ca.key is present"] as const)(
    "when %s: makes a new CA, keeps the old one only to untrust it, and ca trust removes it",
    { timeout: 60_000 },
    async (why) => {
      const signer = await signerFor();
      const security = await securityFor();
      const env = { ...signer.env, ...security.env };
      const profile = await chatProfile();
      const first = await chatAgent(signer, profile, undefined, security.env);
      expect((await caTrust(first, env)).code).toBe(0);
      const oldPem = await caPemOf(first);
      await first.close();
      const oldKey = await signer.removeKey(keyIdOfPem(oldPem));
      const legacyKey = path.join(profile.dataDir, "ca.key");
      if (why === "a legacy ca.key is present") await writeFile(legacyKey, oldKey, { mode: 0o600 });

      const agent = await chatAgent(signer, profile, undefined, security.env);
      const newPem = await caPemOf(agent);
      expect(newPem).not.toBe(oldPem);
      expect(await readFile(path.join(profile.dataDir, staleName(oldPem)), "utf8")).toBe(oldPem);
      expect(await interception(agent)).toEqual({ on: false, reason: "awaiting-trust" });
      expect(await caStatus(agent)).toMatchObject({ state: "awaiting-trust", staleCAs: 1 });
      expect(await signer.keys()).toEqual([keyIdOfPem(newPem)]);
      if (why === "a legacy ca.key is present") expect(await readFile(legacyKey, "utf8"), "ca.key is left until the new CA is trusted").toBe(oldKey);
      expect(security.trusted(oldPem)).toBe(true);

      const trusted = await caTrust(agent, env);
      expect(trusted.code, trusted.stderr).toBe(0);
      expect([security.trusted(newPem), security.trusted(oldPem), security.inKeychain(oldPem)]).toEqual([true, false, false]);
      expect((await readdir(profile.dataDir)).filter((name) => name.startsWith("ca-stale-") || name === "ca.key")).toEqual([]);
      expect(await caStatus(agent)).toMatchObject({ state: "ready", staleCAs: 0 });
      const leaf = await intercepts(agent, "chatgpt.com");
      expect(leaf.verify(new X509Certificate(newPem).publicKey), "the site certificate comes from the new CA").toBe(true);
      expect(await privateKeyFiles(profile.dataDir)).toEqual([]);
    },
  );

  it("makes a new CA when the signer says the key is gone while running, and holds the request until it is trusted", async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const env = { ...signer.env, ...security.env };
    const agent = await chatAgent(signer, undefined, undefined, security.env);
    expect((await caTrust(agent, env)).code).toBe(0);
    await intercepts(agent, "chatgpt.com");
    const oldPem = await caPemOf(agent);
    await signer.removeKey(keyIdOfPem(oldPem));

    const held = connectReply(agent, "localhost", CLOSED_PORT);
    await waitUntil("the agent to make a new CA", async () => ((await caStatus(agent)).state === "awaiting-trust" ? true : undefined));
    expect(await caPemOf(agent)).not.toBe(oldPem);
    expect((await caStatus(agent)).staleCAs).toBe(1);
    const trusted = await caTrust(agent, env);
    expect(trusted.code, trusted.stderr).toBe(0);
    expect(await held, "the held request is intercepted, not passed through to a closed port").toEqual({ status: 200, body: "" });
    await intercepts(agent, "api.chatgpt.com");
    expect(security.trusted(oldPem)).toBe(false);
  });

  it("resumes ca trust after a failure at each step without asking twice, and leaves the command-line trust files with only the current CA", { timeout: 120_000 }, async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const env = { ...signer.env, ...security.env };
    const profile = await chatProfile();
    const first = await chatAgent(signer, profile, undefined, security.env);
    expect((await caTrust(first, env)).code).toBe(0);
    const oldPem = await caPemOf(first);
    await first.close();
    await writeFile(path.join(profile.dataDir, "ca.key"), await signer.removeKey(keyIdOfPem(oldPem)), { mode: 0o600 });
    const otherRoot = (await selfSignedCertificate(suite.cleanup, "DNS:root.example")).cert;
    await writeFile(path.join(profile.dataDir, "guard-ca.pem"), oldPem);
    await writeFile(path.join(profile.dataDir, "guard-ca-bundle.pem"), `${otherRoot}\n${oldPem}`);
    const legacyFiles = async (): Promise<string[]> => (await readdir(profile.dataDir)).filter((name) => name.startsWith("ca-stale-") || name === "ca.key" || name === "ca.pem").sort();
    const refusals = [["down", "signer unavailable"], ["refuse-unsigned", "unsigned build"]] as const;
    const withSigner = async (mode: CaSignerMode, words: string, run: () => Promise<CommandResult>): Promise<void> => {
      await signer.setMode(mode);
      const result = await run();
      await signer.setMode("ok");
      expect([result.code === 0, result.stderr]).toEqual([false, expect.stringContaining(`Guard could not make its new certificate: ${words}`)]);
    };

    for (const [mode, words] of refusals) {
      await withSigner(mode, words, () => caTrust({ dataDir: profile.dataDir, localUrl: "http://127.0.0.1:9" }, env));
      expect(await legacyFiles(), `with the signer ${mode}, the legacy CA and ca.key are left alone`).toEqual(["ca.key", "ca.pem"]);
      expect([await caPemOf(first), await readFile(path.join(profile.dataDir, "guard-ca.pem"), "utf8"), security.trusted(oldPem)]).toEqual([oldPem, oldPem, true]);
    }
    expect(security.calls("add-trusted-cert").length, "no ca trust step ran without a Secure Enclave CA").toBe(1);

    const agent = await chatAgent(signer, profile, undefined, security.env);
    const newPem = await caPemOf(agent);
    const rotated = [staleName(oldPem), "ca.key", "ca.pem"].sort();
    expect(await legacyFiles()).toEqual(rotated);
    for (const fail of ["add-trusted-cert", "verify-cert", "remove-trusted-cert", "delete-certificate"]) {
      const result = await caTrust(agent, env, fail);
      expect(result.code, `ca trust stops when ${fail} fails`).not.toBe(0);
      expect(await legacyFiles(), `ca.key and the stale CA survive a ${fail} failure`).toEqual(rotated);
    }
    for (const [mode, words] of refusals) {
      await withSigner(mode, words, () => caTrust(agent, env));
      expect(await legacyFiles(), `ca.key and the stale CA survive the signer ${mode}`).toEqual(rotated);
    }
    const done = await caTrust(agent, env);
    expect(done.code, done.stderr).toBe(0);
    expect([security.trusted(newPem), security.trusted(oldPem), security.inKeychain(oldPem)]).toEqual([true, false, false]);
    expect((await readdir(profile.dataDir)).filter((name) => name.startsWith("ca-stale-") || name === "ca.key")).toEqual([]);
    await waitUntil("a sync to see the signer back after its redial backoff", async () => ((await caStatus(agent)).state === "off" ? undefined : true));
    expect(await caStatus(agent)).toMatchObject({ state: "ready", staleCAs: 0 });
    const changes = (): number[] => ["add-trusted-cert", "remove-trusted-cert", "delete-certificate"].map((op) => security.calls(op).length);
    expect(changes(), "after the first CA's one trust, each step ran again only after it failed").toEqual([3, 2, 2]);

    const again = await caTrust(agent, env);
    expect(again.code, again.stderr).toBe(0);
    expect(changes(), "a finished ca trust changes nothing").toEqual([3, 2, 2]);
    expect(await readFile(path.join(profile.dataDir, "guard-ca.pem"), "utf8")).toBe(newPem);
    const bundle = pemBlocks(await readFile(path.join(profile.dataDir, "guard-ca-bundle.pem"), "utf8"));
    expect(bundle.map((pem) => new X509Certificate(pem).fingerprint256)).toEqual([otherRoot, newPem].map((pem) => new X509Certificate(pem).fingerprint256));
  });

  it("prunes only for the default data folder: an agent on another folder leaves another profile's key on the shelf", async () => {
    const signer = await signerFor();
    const otherProfile = await signer.addKey();
    const home = await mkdtemp("/tmp/guard-home-");
    suite.cleanup.defer(() => rm(home, { recursive: true, force: true }));
    const defaultDir = path.join(home, "Library", "Application Support", "Vibtra Guard");
    await mkdir(defaultDir, { recursive: true });
    await symlink(signer.socket, path.join(defaultDir, "ca-signer.sock"));
    const shipped = { HOME: home, VIBTRA_GUARD_CA_SIGNER_SOCK: "" };

    const elsewhere = await runAgentCommand(suite.binary(), ["ca", "export"], { dataDir: await tempDir(suite.cleanup, "elsewhere"), env: shipped });
    expect(elsewhere.code, elsewhere.stderr).toBe(0);
    expect(signer.lines("prune"), "an agent on a --data-dir or VIBTRA_GUARD_DIR folder never prunes").toEqual([]);
    expect((await signer.keys()).sort()).toEqual([otherProfile, keyIdOfPem(elsewhere.stdout)].sort());

    const real = await runAgentCommand(suite.binary(), ["ca", "export"], { dataDir: defaultDir, env: { ...shipped, VIBTRA_GUARD_DIR: "" } });
    expect(real.code, real.stderr).toBe(0);
    const id = keyIdOfPem(real.stdout);
    expect(signer.lines("prune"), "the default folder's agent prunes the rest").toEqual([`prune ${id}`]);
    expect(await signer.keys()).toEqual([id]);
  });

  it("prunes every signer key except the one ca.pem names, at start and when an old key comes back", async () => {
    const signer = await signerFor();
    const profile = await chatProfile();
    await signer.addKey();
    const agent = await chatAgent(signer, profile);
    const id = keyIdOfPem(await caPemOf(agent));
    expect(signer.lines("prune")).toEqual([`prune ${id}`]);
    expect(await signer.keys()).toEqual([id]);
    await agent.close();

    await signer.addKey();
    await chatAgent(signer, profile);
    expect(signer.lines("prune")).toEqual([`prune ${id}`, `prune ${id}`]);
    expect(await signer.keys()).toEqual([id]);
  });

  it("refuses hold and reload from web pages or other methods, and passes a held request through after one hold length however often the hold is reopened", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const agent = await chatAgent(signer, undefined, undefined, { ...security.env, VIBTRA_GUARD_CA_HOLD_SECONDS: "6" });
    const before = await holdUntil(agent);
    await delay(1_100);
    for (const [path_, options, status] of [
      ["/ca/hold", { headers: { Origin: "https://attacker.example" } }, 403],
      ["/ca/hold", { headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
      ["/ca/reload", { headers: { Origin: "https://attacker.example" } }, 403],
      ["/ca/hold", { headers: { Host: "attacker.example" } }, 403],
      ["/ca/hold", { method: "GET" }, 405],
      ["/ca/reload", { method: "GET" }, 405],
    ] as const) {
      expect(await callLocal(agent, path_, options), `${options.method ?? "POST"} ${path_} ${JSON.stringify(options)}`).toBe(status);
    }
    expect(await holdUntil(agent), "a refused hold changes nothing").toBe(before);
    expect(await callLocal(agent, "/ca/hold", { headers: { "Sec-Fetch-Site": "none" } }), "a hold typed by the person is accepted").toBe(204);
    expect(await callLocal(agent, "/ca/hold"), "the command line sends no Origin and is accepted").toBe(204);
    expect(await holdUntil(agent)).toBeGreaterThan(before);

    const origin = await startOrigin();
    const started = Date.now();
    const held = passesThrough(agent, origin);
    const stillHeld = pending(held);
    while (stillHeld() && Date.now() - started < 20_000) {
      expect(await callLocal(agent, "/ca/hold")).toBe(204);
      await delay(1_000);
    }
    await held;
    const waited = Date.now() - started;
    expect(waited, "the request waited about one hold length, though the hold kept reopening").toBeGreaterThanOrEqual(5_500);
    expect(waited).toBeLessThan(9_000);
  });

  it("relays a transparent connection to its origin uninspected when the hold ends untrusted", { timeout: 60_000 }, async () => {
    const signer = await signerFor();
    const security = await securityFor();
    const origin = await startOrigin();
    const agent = await startRunning(suite, await chatProfile(), { transparent: true, env: { ...signer.env, ...security.env, VIBTRA_GUARD_CA_HOLD_SECONDS: "4" } });
    const until = await holdUntil(agent);
    const socket = await relayConnect(agent, { proxyLine: `PROXY TCP4 127.0.0.1 127.0.0.1 12345 ${origin.port}\r\n`, servername: "localhost", ca: origin.cert });
    try {
      expect(Date.now(), "the connection was held until the hold ended").toBeGreaterThanOrEqual(until);
      expect(socket.authorized, "the client reaches the origin and sees its own certificate").toBe(true);
      expect(new X509Certificate(socket.getPeerCertificate(true).raw).toString()).toBe(new X509Certificate(origin.cert).toString());
    } finally {
      socket.destroy();
    }
    expect(signer.requests("sign"), "nothing was signed").toBe(0);
  });
});
