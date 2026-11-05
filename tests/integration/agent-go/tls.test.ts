import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { isRecord } from "../../support/guards.ts";
import { catalogueDocument, selfSignedCertificate, waitUntil, type Json } from "./harness.ts";
import { clientHelloOf, comparableShape, framedTls, helloShape, startHelloCapture, UNSAFE_EXTENSIONS, type CapturedHello } from "./hello.ts";
import { activityRows, h2Client, local, openTunnel, policyProfile, record, requestOnSocket, startRunning, tlsRows, tlsThroughConnect, useAgentSuite, viaTunnel, type Running, type TlsOptions } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com", "*.chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const RSA_ONLY = "rsa_pss_rsae_sha256:rsa_pss_rsae_sha384:rsa_pkcs1_sha256";

const chatAgent = async (catalogue: Json = CHAT, args: readonly string[] = [], upstreamMap?: Record<string, string>): Promise<Running> => {
  const profile = await policyProfile(suite, { catalogue });
  return startRunning(suite, profile, { args, ...(upstreamMap === undefined ? {} : { upstreamMap }) });
};

interface Handshake {
  readonly error?: Error;
  readonly protocol?: string | null;
  readonly alpn?: string | false | null;
  readonly authorized?: boolean;
  readonly subjectAltName?: string;
}

const snapshot = async (agent: Running): Promise<string> => JSON.stringify(await tlsRows(agent));

const attempt = async (agent: Running, host: string, options: TlsOptions): Promise<Handshake> => {
  const before = await snapshot(agent);
  let outcome: Handshake;
  let socket: TLSSocket | undefined;
  try {
    socket = await tlsThroughConnect(agent, host, 443, options);
    outcome = { protocol: socket.getProtocol(), alpn: socket.alpnProtocol, authorized: socket.authorized, subjectAltName: socket.getPeerCertificate().subjectaltname };
  } catch (error) {
    outcome = { error: error instanceof Error ? error : new Error(String(error)) };
  }
  for (let tries = 0; tries < 100 && (await snapshot(agent)) === before; tries += 1) await delay(50);
  socket?.destroy();
  return outcome;
};

const settledRows = async (agent: Running, total: number, timeoutMs = 5_000): Promise<Json[]> => {
  for (let tries = 0; tries < timeoutMs / 100; tries += 1) {
    const rows = await tlsRows(agent);
    if (rows.reduce((sum, row) => sum + Number(row.count), 0) >= total) return rows;
    await delay(100);
  }
  return tlsRows(agent);
};

const openssl = async (agent: Running, version: "-tls1_2" | "-tls1_3"): Promise<Json[]> => {
  const before = (await tlsRows(agent)).reduce((sum, row) => sum + Number(row.count), 0);
  const verifier = execFile("openssl", ["s_client", version, "-proxy", `127.0.0.1:${agent.proxyPort}`, "-connect", "chatgpt.com:443", "-servername", "chatgpt.com", "-alpn", "http/1.1", "-verify_return_error"], () => undefined);
  verifier.stdin?.end();
  const rows = await settledRows(agent, before + 1);
  verifier.kill();
  return rows;
};

describe("TLS between the client and the agent", () => {
  it("completes TLS 1.2 and 1.3 with a chain to the agent CA for every ALPN offer, and speaks h2 whenever the client offers it", async () => {
    const agent = await chatAgent();
    for (const version of ["TLSv1.2", "TLSv1.3"] as const) {
      for (const [name, protocols, expected] of [
        ["no ALPN", undefined, false],
        ["http/1.1", ["http/1.1"], "http/1.1"],
        ["h2 and http/1.1", ["h2", "http/1.1"], "h2"],
        ["h2 only", ["h2"], "h2"],
        ["a private protocol only", ["secret-protocol-token"], false],
      ] as const) {
        const handshake = await attempt(agent, "chatgpt.com", { minVersion: version, maxVersion: version, ALPNProtocols: protocols === undefined ? undefined : [...protocols] });
        expect([handshake.error?.message, handshake.protocol, handshake.alpn, handshake.authorized], `${version} ${name}`).toEqual([undefined, version, expected, true]);
        expect(handshake.subjectAltName, `${version} ${name}`).toContain("DNS:chatgpt.com");
      }
    }
    const rows = await settledRows(agent, 10);
    expect(rows.map((row) => row.class)).toEqual(rows.map(() => "handshake-complete"));
    expect(rows.reduce((sum, row) => sum + Number(row.count), 0)).toBe(10);
  });

  it("needs an ECDSA P-256 signature offer and names the failure when it is missing", async () => {
    const agent = await chatAgent();
    const ecdsa = await attempt(agent, "chatgpt.com", { sigalgs: "ecdsa_secp256r1_sha256" });
    expect(ecdsa.error).toBeUndefined();
    const rsa = await attempt(agent, "chatgpt.com", { sigalgs: RSA_ONLY });
    expect(rsa.error).toBeInstanceOf(Error);
    const rows = await settledRows(agent, 2);
    expect(rows.map((row) => [row.class, row.ecdsaP256Offered]).sort()).toEqual([
      ["handshake-complete", true],
      ["signature-algorithms-incompatible", false],
    ]);
  });
});

describe("local TLS diagnostics", () => {
  it("classifies each handshake outcome with the offered hello and no private protocol name", async () => {
    for (const [name, options, klass, alert, alpn] of [
      ["trusted", { ALPNProtocols: ["h2", "http/1.1"] }, "handshake-complete", undefined, "h2"],
      ["private ALPN", { ALPNProtocols: ["secret-protocol-token"] }, "handshake-complete", undefined, undefined],
      ["no ECDSA P-256", { sigalgs: RSA_ONLY }, "signature-algorithms-incompatible", undefined, "http/1.1"],
    ] as const) {
      const agent = await chatAgent();
      await attempt(agent, "chatgpt.com", options);
      const rows = await settledRows(agent, 1);
      expect(rows.map((row) => [row.host, row.class, row.alert, row.alpn]), name).toEqual([["chatgpt.com", klass, alert, alpn]]);
      expect(JSON.stringify(rows), name).not.toContain("secret-protocol-token");
    }
    const tls12 = await chatAgent();
    expect((await openssl(tls12, "-tls1_2")).map((row) => [row.host, row.class, row.alert, row.ecdsaP256Offered]), "an OpenSSL TLS 1.2 client that refuses the agent CA").toEqual([["chatgpt.com", "remote-alert", "unknown_ca", true]]);
    const tls13 = await chatAgent();
    expect((await openssl(tls13, "-tls1_3")).map((row) => [row.host, row.class, row.alert, row.ecdsaP256Offered]), "an OpenSSL TLS 1.3 client that refuses the agent CA").toEqual([["chatgpt.com", "local-alert", "bad_record_mac", true]]);
  });

  it("names a dynamic subdomain by its catalogue pattern, copies no error text and never becomes policy activity", async () => {
    const agent = await chatAgent();
    const secret = "private-token-4111111111111111";
    const failed = await attempt(agent, `${secret}.chatgpt.com`, { ALPNProtocols: ["h2", secret], sigalgs: RSA_ONLY });
    expect(failed.error).toBeInstanceOf(Error);
    const rows = await settledRows(agent, 1);
    expect(rows.map((row) => [row.host, row.hostnameRedacted, row.class])).toEqual([["*.chatgpt.com", true, "signature-algorithms-incompatible"]]);
    const encoded = JSON.stringify(rows);
    for (const forbidden of [secret, "signature algorithms", "127.0.0.1"]) expect(encoded, forbidden).not.toContain(forbidden);
    expect(await activityRows(agent)).toEqual([]);
  });

  it("merges a repeated failure into one counted row, keeps the newest 128 hosts, and counts concurrent failures exactly", async () => {
    const hosts = Array.from({ length: 200 }, (_, index) => `host-${index}.example.test`);
    const agent = await chatAgent(catalogueDocument({ services: [{ serviceId: "many", name: "Many", vendor: "Example", category: "chat", domains: hosts, bundleIds: [], cliNames: [], custom: true }] }));
    for (let index = 0; index < 2; index += 1) await attempt(agent, "host-0.example.test", { sigalgs: RSA_ONLY });
    const [merged] = await settledRows(agent, 2);
    expect([merged?.host, merged?.count]).toEqual(["host-0.example.test", 2]);
    expect(Date.parse(String(merged?.firstAt))).toBeLessThanOrEqual(Date.parse(String(merged?.lastAt)));
    for (const host of hosts) await attempt(agent, host, { sigalgs: RSA_ONLY });
    const bounded = await tlsRows(agent);
    expect(bounded).toHaveLength(128);
    expect(bounded[0]?.host).toBe("host-199.example.test");

    const busy = await chatAgent();
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let index = 0; index < 25; index += 1) await attempt(busy, "chatgpt.com", { sigalgs: RSA_ONLY });
    }));
    const rows = await settledRows(busy, 200);
    expect(rows.map((row) => [row.class, row.count])).toEqual([["signature-algorithms-incompatible", 200]]);
  });

  it("serves diagnostics only to a same-site loopback caller, uncached", async () => {
    const agent = await chatAgent();
    const port = Number(new URL(agent.localUrl).port);
    const get = async (headers: Record<string, string>): Promise<{ status: number; cache: string | undefined; text: string }> => {
      const request = http.request({ host: "127.0.0.1", port, path: "/diagnostics/tls", headers, agent: false });
      request.end();
      const [response] = (await once(request, "response")) as [http.IncomingMessage];
      const chunks: Buffer[] = [];
      for await (const chunk of response) chunks.push(Buffer.from(chunk as Buffer));
      return { status: response.statusCode ?? 0, cache: response.headers["cache-control"], text: Buffer.concat(chunks).toString() };
    };
    const allowed = await get({ host: `localhost:${port}` });
    expect([allowed.status, allowed.cache]).toEqual([200, "no-store"]);
    expect(allowed.text).toContain('"processAttribution":"per-entry"');
    for (const [name, headers] of [
      ["foreign origin", { host: `localhost:${port}`, origin: "https://attacker.test" }],
      ["cross-site fetch", { host: `localhost:${port}`, "sec-fetch-site": "cross-site" }],
      ["foreign host", { host: "attacker.test" }],
    ] as const) {
      const refused = await get(headers);
      expect([refused.status, refused.cache], name).toEqual([403, "no-store"]);
    }
  });

  it("tells a client that hung up, one that sent a non-TLS record and one that went quiet after its whole ClientHello apart", { timeout: 60_000 }, async () => {
    const hello = await clientHelloOf(suite.cleanup, {});
    const agent = await chatAgent();
    const closed = await openTunnel(agent.proxyPort, "chatgpt.com:443");
    closed.end(hello.wire);
    const garbage = await openTunnel(agent.proxyPort, "chatgpt.com:443");
    garbage.write(hello.wire);
    garbage.on("data", () => garbage.write("GET / HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n"));
    const quiet = await openTunnel(agent.proxyPort, "chatgpt.com:443");
    quiet.write(hello.wire);
    for (const socket of [closed, garbage, quiet]) socket.on("error", () => undefined);
    const rows = await settledRows(agent, 3, 30_000);
    for (const socket of [closed, garbage, quiet]) socket.destroy();
    expect(rows.map((row) => row.class).sort()).toEqual(["invalid-tls-record", "peer-closed", "timeout"]);
  });
});

const forwardThrough = async (agent: Running, socket: TLSSocket): Promise<number> => {
  try {
    return (await requestOnSocket(socket, new URL("https://chatgpt.com/"), { method: "GET", url: "https://chatgpt.com/", headers: { connection: "close" } })).status;
  } finally {
    socket.destroy();
  }
};

const opensslThroughProxy = async (args: readonly string[]): Promise<void> => {
  const child = spawn("openssl", ["s_client", "-ign_eof", "-servername", "chatgpt.com", "-alpn", "http/1.1", ...args], { stdio: ["pipe", "ignore", "ignore"] });
  child.stdin.write("GET / HTTP/1.1\r\nHost: chatgpt.com\r\nConnection: close\r\n\r\n");
  child.stdin.end();
  const exited = once(child, "exit");
  const timer = setTimeout(() => child.kill(), 10_000);
  await exited;
  clearTimeout(timer);
};

const curl = async (args: readonly string[]): Promise<void> => {
  await new Promise<void>((resolve) => execFile("curl", ["-sS", "--max-time", "10", "--noproxy", "", ...args], { env: { PATH: process.env.PATH ?? "" } }, () => resolve()));
};

const extensionTypes = (hello: CapturedHello): number[] => helloShape(hello.handshake).extensions.map((item) => item.type);

const HELLO_CLIENT_SOURCE = fileURLToPath(new URL("../../support/hello-client/", import.meta.url));

const buildHelloClient = async (): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-hello-client-"));
  suite.cleanup.defer(() => rm(dir, { recursive: true, force: true }));
  const binary = path.join(dir, "hello-client");
  await promisify(execFile)("go", ["build", "-o", binary, "."], { cwd: HELLO_CLIENT_SOURCE, timeout: 300_000 });
  return binary;
};

describe("TLS between the agent and the origin", () => {
  it("replays each client's own ClientHello upstream: the same cipher suites, extension order and ALPN, without the extensions a new session cannot reuse", { timeout: 60_000 }, async () => {
    const capture = await startHelloCapture(suite.cleanup);
    const agent = await chatAgent(CHAT, [], { "chatgpt.com": `https://127.0.0.1:${capture.port}` });
    const clients: { name: string; direct: () => Promise<CapturedHello>; via: () => Promise<void> }[] = [
      ...([["http/1.1"], ["h2", "http/1.1"]] as const).map((alpn) => ({
        name: `Node offering ${alpn.join(",")}`,
        direct: () => clientHelloOf(suite.cleanup, { ALPNProtocols: [...alpn] }),
        via: async () => {
          const socket = await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: [...alpn] });
          if (socket.alpnProtocol === "h2") {
            const client = h2Client(socket);
            await client.request({ method: "GET", path: "/" }).catch(() => undefined);
            client.close();
            return;
          }
          await forwardThrough(agent, socket);
        },
      })),
      ...(["--http1.1", "--http2"] as const).map((flag) => ({
        name: `curl ${flag}`,
        direct: async () => {
          const own = await startHelloCapture(suite.cleanup);
          void curl([flag, "--resolve", `chatgpt.com:${own.port}:127.0.0.1`, `https://chatgpt.com:${own.port}/`]);
          return own.next();
        },
        via: () => curl([flag, "--proxy", `http://127.0.0.1:${agent.proxyPort}`, "--cacert", path.join(agent.dataDir, "ca.pem"), "https://chatgpt.com/"]),
      })),
      {
        name: "OpenSSL s_client",
        direct: async () => {
          const own = await startHelloCapture(suite.cleanup);
          void opensslThroughProxy(["-connect", `127.0.0.1:${own.port}`]);
          return own.next();
        },
        via: () => opensslThroughProxy(["-proxy", `127.0.0.1:${agent.proxyPort}`, "-connect", "chatgpt.com:443", "-CAfile", path.join(agent.dataDir, "ca.pem")]),
      },
    ];
    for (const client of clients) {
      const direct = await client.direct();
      const before = capture.hellos.length;
      await client.via();
      const upstream = await waitUntil(`the upstream hello for ${client.name}`, async () => capture.hellos[before], 10_000);
      expect(comparableShape(helloShape(upstream.handshake)), client.name).toEqual(comparableShape(helloShape(direct.handshake)));
      expect(extensionTypes(upstream).filter((type) => UNSAFE_EXTENSIONS.includes(type)), client.name).toEqual([]);
      expect(helloShape(upstream.handshake).serverName, client.name).toBe("chatgpt.com");
      if (client.name === "OpenSSL s_client") expect(extensionTypes(direct), "OpenSSL offers encrypt-then-MAC").toContain(22);
    }
  });

  it("drops the pre-shared key a resuming client offers, and still replays the rest of its hello", async () => {
    const capture = await startHelloCapture(suite.cleanup);
    const agent = await chatAgent(CHAT, [], { "chatgpt.com": `https://127.0.0.1:${capture.port}` });
    const first = await tlsThroughConnect(agent, "chatgpt.com", 443, { maxVersion: "TLSv1.3" });
    const ticket = Promise.withResolvers<Buffer>();
    first.once("session", ticket.resolve);
    const firstHello = capture.hellos.length;
    await forwardThrough(agent, first);
    const session = await ticket.promise;
    await waitUntil("the upstream hello for the first connection", async () => capture.hellos[firstHello], 10_000);
    const before = capture.hellos.length;
    const resumed = await framedTls(await openTunnel(agent.proxyPort, "chatgpt.com:443"), "chatgpt.com", { ca: agent.caPem, session });
    expect(extensionTypes(resumed.sent)).toContain(41);
    await forwardThrough(agent, resumed.secure);
    const upstream = await waitUntil("the upstream hello for the resumed connection", async () => capture.hellos[before], 10_000);
    expect(extensionTypes(upstream)).not.toContain(41);
    expect(comparableShape(helloShape(upstream.handshake))).toEqual(comparableShape(helloShape(resumed.sent.handshake)));
  });

  it("strips encrypt-then-MAC, early data, a cookie and a dummy pre-shared key from the replayed hello, and keeps the extensions the origin needs", { timeout: 120_000 }, async () => {
    const client = await buildHelloClient();
    const capture = await startHelloCapture(suite.cleanup);
    const agent = await chatAgent(CHAT, [], { "chatgpt.com": `https://127.0.0.1:${capture.port}` });
    const offer = async (args: readonly string[]): Promise<{ readonly offered: number[]; readonly upstream: number[] }> => {
      const before = capture.hellos.length;
      const { stdout } = await promisify(execFile)(client, ["--proxy", `127.0.0.1:${agent.proxyPort}`, "--authority", "chatgpt.com:443", "--ca", path.join(agent.dataDir, "ca.pem"), ...args], { timeout: 60_000 });
      const sent: unknown = JSON.parse(stdout);
      if (!isRecord(sent) || typeof sent.hello !== "string") throw new Error(`the hello client printed ${stdout}`);
      expect(sent.status, args.join(" ")).toBe(502);
      const upstream = await waitUntil(`the upstream hello for ${args.join(" ")}`, async () => capture.hellos[before], 10_000);
      return { offered: helloShape(Buffer.from(sent.hello, "hex")).extensions.map((item) => item.type), upstream: extensionTypes(upstream) };
    };
    for (const [args, unsafe] of [
      [["--max", "tls12", "--early-data"], [22, 42, 44, 41]],
      [["--max", "tls13"], [22, 44, 41]],
    ] as const) {
      const { offered, upstream } = await offer(args);
      const name = args.join(" ");
      expect(offered.filter((type) => [22, 41, 42, 44].includes(type)), name).toEqual(unsafe);
      expect(offered.at(-1), name).toBe(41);
      expect(upstream.filter((type) => [22, 41, 42, 44].includes(type)), name).toEqual([]);
      expect([0, 10, 13, 16, 43, 51].filter((type) => !upstream.includes(type)), name).toEqual([]);
      expect(upstream, name).toEqual(offered.filter((type) => ![22, 41, 42, 44].includes(type)));
    }
  });

  it("reports the hash of the last ClientHello it sent upstream and counts nothing as uninspected", async () => {
    const certificate = await selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");
    const origin = https.createServer({ cert: certificate.cert, key: certificate.key }, (_request, response) => response.end("origin-ok"));
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    const originAddress = origin.address();
    if (originAddress === null || typeof originAddress === "string") throw new Error("the TLS origin has no port");
    const hellos: Buffer[] = [];
    const relay = net.createServer((client) => {
      const upstream = net.connect(originAddress.port, "127.0.0.1");
      let first: Buffer | undefined = Buffer.alloc(0);
      client.on("data", (chunk: Buffer) => {
        if (first !== undefined) {
          first = Buffer.concat([first, chunk]);
          if (first.length >= 5 && first.length >= 5 + first.readUInt16BE(3)) {
            hellos.push(first.subarray(5, 5 + first.readUInt16BE(3)));
            first = undefined;
          }
        }
        upstream.write(chunk);
      });
      upstream.on("data", (chunk: Buffer) => client.write(chunk));
      for (const socket of [client, upstream]) socket.on("error", () => undefined);
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    });
    relay.listen(0, "127.0.0.1");
    await once(relay, "listening");
    suite.cleanup.defer(async () => {
      relay.close();
      origin.closeAllConnections();
      origin.close();
    });
    const relayAddress = relay.address();
    if (relayAddress === null || typeof relayAddress === "string") throw new Error("the relay has no port");
    const agent = await chatAgent(CHAT, ["--upstream-ca", certificate.certPath], { "chatgpt.com": `https://127.0.0.1:${relayAddress.port}` });
    expect(record((await local(agent, "/status")).json().upstreamTransport)).toEqual({ kind: "utls", available: true, mode: "client-hello-replay", lastClientHelloSHA256: "", uninspectedConnections: 0, tunnelledConnections: 0 });
    const reply = await viaTunnel(agent, { method: "GET", url: "https://chatgpt.com/", headers: { connection: "close" } });
    expect([reply.status, reply.text]).toEqual([200, "origin-ok"]);
    expect(hellos).toHaveLength(1);
    expect(record((await local(agent, "/status")).json().upstreamTransport)).toEqual({ kind: "utls", available: true, mode: "client-hello-replay", lastClientHelloSHA256: createHash("sha256").update(hellos[0] ?? "").digest("hex"), uninspectedConnections: 0, tunnelledConnections: 0 });
  });

  it("refuses an origin it cannot verify, and with the origin's CA streams a response without buffering it", async () => {
    const certificate = await selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");
    const release = Promise.withResolvers<void>();
    const protocols: string[] = [];
    const origin = https.createServer({ cert: certificate.cert, key: certificate.key, ALPNProtocols: ["h2", "http/1.1"] }, (request, response) => {
      protocols.push(request.httpVersion);
      response.setHeader("set-cookie", ["a=1", "b=2"]);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      void release.promise.then(() => response.end("data: second\n\n"));
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    suite.cleanup.defer(async () => {
      release.resolve();
      origin.closeAllConnections();
      origin.close();
    });
    const address = origin.address();
    if (address === null || typeof address === "string") throw new Error("the TLS origin has no port");
    const map = { "chatgpt.com": `https://127.0.0.1:${address.port}` };

    const untrusting = await chatAgent(CHAT, [], map);
    expect((await viaTunnel(untrusting, { method: "GET", url: "https://chatgpt.com/" })).status).toBe(502);
    expect(protocols).toEqual([]);

    const trusting = await chatAgent(CHAT, ["--upstream-ca", certificate.certPath], map);
    const socket = await tlsThroughConnect(trusting, "chatgpt.com");
    suite.cleanup.defer(async () => {
      socket.destroy();
    });
    const request = http.request({ path: "/", headers: { host: "chatgpt.com", connection: "close" }, createConnection: () => socket });
    request.end();
    const [response] = (await once(request, "response")) as [http.IncomingMessage];
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toEqual(["a=1", "b=2"]);
    let body = "";
    const first = Promise.withResolvers<void>();
    response.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.includes("data: first\n\n")) first.resolve();
    });
    await first.promise;
    expect(body).toBe("data: first\n\n");
    release.resolve();
    await once(response, "end");
    expect(body).toBe("data: first\n\ndata: second\n\n");
    expect(protocols).toEqual(["1.1"]);
  });
});
