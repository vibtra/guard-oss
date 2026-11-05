import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { catalogueDocument, contentRule, selfSignedCertificate, startOrigin, type Json, type TestCertificate } from "./harness.ts";
import { buildHello, extension, framedTls, recordSizes, records, serverNameExtension } from "./hello.ts";
import {
  createRelaySigner,
  local,
  openTunnel,
  policyProfile,
  queuedEvents,
  rawExchange,
  record,
  requestOnSocket,
  startRunning,
  tlsRows,
  tlsThroughConnect,
  useAgentSuite,
  writeRelayPin,
  type RelaySigner,
  type Running,
} from "./running.ts";

const suite = useAgentSuite();
const SETTINGS = { requestsEnabled: true, workspaceRedirect: { enabled: false }, snippetPolicy: "redacted", snippetMax: 80 };
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: ["codex"], custom: true }] });
const ALERT = Buffer.from([21, 3, 3, 0, 2, 2, 40]);
const TFN = contentRule("gcr_00000000000000c1", { kind: "au-tfn", requireContext: true });
const SENSITIVE = '{"messages":[{"content":"My TFN is 123 456 782"}]}';

interface Policy {
  readonly mode: "enforce" | "monitor";
  readonly unreproducibleTls?: "block" | "tunnel";
}

interface Profiled {
  readonly agent: Running;
  readonly dataDir: string;
  readonly signer: RelaySigner;
}

const agentWith = async (policy: Policy, options: { catalogue?: Json; upstreamMap?: Record<string, string>; args?: readonly string[]; contentRules?: Json[] } = {}): Promise<Profiled> => {
  const settings = policy.unreproducibleTls === undefined ? SETTINGS : { ...SETTINGS, unreproducibleTls: policy.unreproducibleTls };
  const profile = await policyProfile(suite, { bundle: { clientMode: policy.mode, settings, contentRules: options.contentRules ?? [] }, catalogue: options.catalogue ?? CHAT });
  const signer = createRelaySigner();
  await writeRelayPin(profile, signer);
  const agent = await startRunning(suite, profile, { transparent: true, ...(options.upstreamMap === undefined ? {} : { upstreamMap: options.upstreamMap }), ...(options.args === undefined ? {} : { args: options.args }) });
  return { agent, dataDir: profile.dataDir, signer };
};

interface RawOrigin {
  readonly port: number;
  readonly connections: Buffer[][];
  received(index: number): Buffer;
}

const startRawOrigin = async (): Promise<RawOrigin> => {
  const connections: Buffer[][] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    connections.push(chunks);
    socket.on("error", () => undefined);
    socket.once("data", () => socket.write("origin"));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the raw origin has no port");
  return { port: address.port, connections, received: (index) => Buffer.concat(connections[index] ?? []) };
};

const converse = async (socket: net.Socket, bytes: Buffer, want: number, timeoutMs = 5_000): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  const done = Promise.withResolvers<Buffer>();
  const timer = setTimeout(() => done.resolve(Buffer.concat(chunks)), timeoutMs);
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    if (Buffer.concat(chunks).length >= want) done.resolve(Buffer.concat(chunks));
  });
  socket.on("close", () => done.resolve(Buffer.concat(chunks)));
  socket.on("error", () => done.resolve(Buffer.concat(chunks)));
  socket.write(bytes);
  try {
    return await done.promise;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
};

const watchClose = (socket: net.Socket, timeoutMs: number): Promise<{ closed: boolean; received: number }> => {
  let received = 0;
  socket.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  socket.on("error", () => undefined);
  return Promise.race([once(socket, "close").then(() => true), delay(timeoutMs).then(() => false)]).then((closed) => {
    socket.destroy();
    return { closed, received };
  });
};

const transport = async (agent: Running): Promise<Json> => record((await local(agent, "/status")).json().upstreamTransport);

const counters = async (agent: Running): Promise<[unknown, unknown]> => {
  const status = await transport(agent);
  return [status.uninspectedConnections, status.tunnelledConnections];
};

const summary = (event: Json | undefined): unknown[] => [event?.kind, event?.action, event?.reason, event?.host, event?.serviceId, event?.ruleKind];

const proxyLineTo = (port: number): string => `PROXY TCP4 127.0.0.1 127.0.0.1 12345 ${port}\r\n`;

const legacyHello = (version: number): Buffer => buildHello({ version, suites: [0x002f], extensions: [serverNameExtension("chatgpt.com")] });

const ffdheHello = (): Buffer =>
  buildHello({
    extensions: [
      serverNameExtension("chatgpt.com"),
      extension(10, Buffer.from([0, 2, 1, 0])),
      extension(13, Buffer.from([0, 2, 4, 3])),
      extension(43, Buffer.from([2, 3, 4])),
      extension(51, Buffer.from([0, 6, 1, 0, 0, 2, 1, 2])),
    ],
  });

const noServerNameHello = (): Buffer => buildHello({ extensions: [] });

describe("a ClientHello that never arrives whole", () => {
  it("closes a CONNECT tunnel or a steered connection quietly: no event, no row, no counter and no origin dial", { timeout: 60_000 }, async () => {
    const origin = await startRawOrigin();
    const { agent, dataDir } = await agentWith({ mode: "monitor", unreproducibleTls: "tunnel" }, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` } });
    const partialRecord = Buffer.from([22, 3, 3, 0, 4, 1, 0]);
    const watched: Promise<{ closed: boolean; received: number }>[] = [];
    for (const [bytes, end] of [
      [Buffer.alloc(0), true],
      [Buffer.from([22, 3]), true],
      [Buffer.alloc(0), false],
    ] as const) {
      const tunnel = await openTunnel(agent.proxyPort, "chatgpt.com:443");
      watched.push(watchClose(tunnel, 30_000));
      if (end) tunnel.end(bytes);
    }
    for (const end of [true, false]) {
      const steered = net.connect(agent.transparentPort, "127.0.0.1");
      watched.push(watchClose(steered, 30_000));
      await once(steered, "connect");
      const bytes = Buffer.concat([Buffer.from(proxyLineTo(origin.port)), partialRecord]);
      if (end) steered.end(bytes);
      else steered.write(bytes);
    }
    const outcomes = await Promise.all(watched);
    expect(outcomes).toEqual(outcomes.map(() => ({ closed: true, received: 0 })));
    expect(await queuedEvents(dataDir)).toEqual([]);
    expect(await tlsRows(agent)).toEqual([]);
    expect(await counters(agent)).toEqual([0, 0]);
    expect(origin.connections).toHaveLength(0);
  });
});

describe("a whole ClientHello the agent cannot read or reproduce", () => {
  const inputs: readonly [string, Buffer][] = [
    ["a malformed hello", Buffer.from([22, 3, 3, 0, 4, 1, 0, 0, 0])],
    ["an application-data record", Buffer.from([23, 3, 3, 0, 1])],
    ["a record longer than TLS allows", Buffer.from([22, 3, 3, 0x40, 1])],
    ["an FFDHE-only key share", records(ffdheHello())],
    ["a TLS 1.0 hello", records(legacyHello(0x0301))],
    ["a TLS 1.1 hello", records(legacyHello(0x0302))],
  ];
  const policies: readonly Policy[] = [{ mode: "enforce" }, { mode: "enforce", unreproducibleTls: "tunnel" }, { mode: "monitor" }, { mode: "monitor", unreproducibleTls: "block" }, { mode: "monitor", unreproducibleTls: "tunnel" }];

  for (const policy of policies) {
    const tunnels = policy.mode === "monitor" && policy.unreproducibleTls === "tunnel";
    it(`${tunnels ? "tunnels it byte for byte" : "refuses it with a fatal alert"} and records one coverage event each, in ${policy.mode} mode with unreproducibleTls ${policy.unreproducibleTls ?? "unset"}`, { timeout: 60_000 }, async () => {
      const origin = await startRawOrigin();
      const { agent, dataDir } = await agentWith(policy, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` } });
      for (const [name, input] of inputs) {
        const before = origin.connections.length;
        const reply = await converse(await openTunnel(agent.proxyPort, "chatgpt.com:443"), input, tunnels ? 6 : ALERT.length);
        if (tunnels) {
          expect(reply.toString(), name).toBe("origin");
          await delay(100);
          expect(origin.received(before).equals(input), name).toBe(true);
        } else {
          expect(reply.equals(ALERT), name).toBe(true);
          expect(origin.connections.length, name).toBe(before);
        }
      }
      const events = await queuedEvents(dataDir);
      expect(events.map(summary)).toEqual(inputs.map(() => ["flow", tunnels ? "allowed" : "blocked", "tls-client-hello-unreproducible", "chatgpt.com", "chat", undefined]));
      expect(await counters(agent)).toEqual([inputs.length, tunnels ? inputs.length : 0]);
      expect((await tlsRows(agent)).map((row) => [row.class, row.count])).toEqual([["tls-client-hello-unreproducible", inputs.length]]);
    });
  }

  it("names the verified app and its service in the coverage event of a steered connection", async () => {
    const origin = await startRawOrigin();
    const catalogue = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: ["com.example.SyntheticApp"], cliNames: [], custom: true }] });
    const { agent, dataDir, signer } = await agentWith({ mode: "enforce" }, { catalogue, upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` } });
    const proxyLine = proxyLineTo(origin.port);
    const reply = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from(proxyLine), signer.line(proxyLine).line, records(legacyHello(0x0301))]), { until: (bytes) => bytes.length >= ALERT.length });
    expect(reply.equals(ALERT)).toBe(true);
    const [event] = await queuedEvents(dataDir);
    expect(summary(event)).toEqual(["flow", "blocked", "tls-client-hello-unreproducible", "chatgpt.com", "chat", undefined]);
    expect(event?.app).toEqual({ bundleId: "com.example.SyntheticApp" });
    expect(origin.connections).toHaveLength(0);
  });
});

const startTlsOrigin = async (certificate: TestCertificate): Promise<{ port: number; methods: string[] }> => {
  const methods: string[] = [];
  const origin = https.createServer({ cert: certificate.cert, key: certificate.key }, (request, response) => {
    methods.push(request.method ?? "");
    request.resume();
    request.once("end", () => response.end("origin-ok"));
  });
  origin.listen(0, "127.0.0.1");
  await once(origin, "listening");
  suite.cleanup.defer(async () => {
    origin.closeAllConnections();
    origin.close();
  });
  const address = origin.address();
  if (address === null || typeof address === "string") throw new Error("the TLS origin has no port");
  return { port: address.port, methods };
};

describe("a ClientHello split across TLS records", () => {
  it("is read whole on the steered listener and through CONNECT, and every request on it is still inspected", { timeout: 60_000 }, async () => {
    const certificate = await selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");
    const origin = await startTlsOrigin(certificate);
    const { agent } = await agentWith({ mode: "enforce" }, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` }, args: ["--upstream-ca", certificate.certPath], contentRules: [TFN] });
    const longAlpn = [...Array.from({ length: 90 }, (_, index) => `${String(index).padStart(3, "0")}-${"p".repeat(196)}`), "http/1.1"];
    const cases = [
      ["records of 495 and 991 bytes on the steered listener", [495, 991], ["http/1.1"], true],
      ["a hello longer than one record on the steered listener", undefined, longAlpn, true],
      ["one-byte records through CONNECT", Array.from({ length: 4_000 }, () => 1), ["http/1.1"], false],
    ] as const;
    for (const [name, sizes, alpn, steered] of cases) {
      const authority = steered ? `chatgpt.com:${origin.port}` : "chatgpt.com";
      for (const [method, path, body] of [
        ["POST", "/backend-api/conversation", SENSITIVE],
        ["GET", "/allowed", undefined],
      ] as const) {
        let raw: net.Socket;
        if (steered) {
          raw = net.connect(agent.transparentPort, "127.0.0.1");
          await once(raw, "connect");
          raw.write(proxyLineTo(origin.port));
        } else {
          raw = await openTunnel(agent.proxyPort, "chatgpt.com:443");
        }
        const framed = await framedTls(raw, "chatgpt.com", { ca: agent.caPem, ALPNProtocols: [...alpn] }, sizes === undefined ? undefined : [...sizes]);
        const sent = recordSizes(framed.sent.wire);
        if (sizes === undefined) expect(framed.sent.handshake.length, name).toBeGreaterThan(16_384);
        else expect(sent.slice(0, 2), name).toEqual(sizes.slice(0, 2));
        expect(sent.length, name).toBeGreaterThan(1);
        const target = new URL(`https://${authority}${path}`);
        const reply = await requestOnSocket(framed.secure, target, { method, url: target.href, headers: { "content-type": "application/json", connection: "close" }, ...(body === undefined ? {} : { body }) });
        framed.secure.destroy();
        if (method === "POST") expect([reply.status, reply.text.includes("GUARD_BLOCKED")], name).toEqual([403, true]);
        else expect([reply.status, reply.text], name).toEqual([200, "origin-ok"]);
      }
    }
    expect(origin.methods).toEqual(["GET", "GET", "GET"]);
    expect(await counters(agent)).toEqual([0, 0]);
  });
});

describe("a steered connection without a server name", () => {
  for (const mode of ["enforce", "monitor"] as const) {
    it(`${mode === "monitor" ? "is tunnelled byte for byte to its address" : "is refused"} under the signed coverage policy in ${mode} mode, and names the service the extension signed`, async () => {
      const origin = await startRawOrigin();
      const catalogue = catalogueDocument({ services: [{ serviceId: "steered-chat", name: "Steered", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
      const { agent, dataDir, signer } = await agentWith({ mode, unreproducibleTls: "tunnel" }, { catalogue });
      const proxyLine = proxyLineTo(origin.port);
      const hello = records(noServerNameHello());
      const claims: readonly [string, Record<string, string>, Json | undefined][] = [
        ["a verified app", { steeringHost: "chatgpt.com" }, { bundleId: "com.example.SyntheticApp" }],
        ["a steering-only claim", { steeringHost: "chatgpt.com", signingId: "", teamId: "" }, undefined],
        ["a verified app with an invalid steering host", { steeringHost: "127.0.0.1" }, { bundleId: "com.example.SyntheticApp" }],
      ];
      for (const [name, changes] of claims) {
        const reply = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from(proxyLine), signer.line(proxyLine, changes).line, hello]), { until: (bytes) => bytes.length >= 6 });
        if (mode === "monitor") {
          expect(reply.toString(), name).toBe("origin");
          await delay(100);
          expect(origin.received(origin.connections.length - 1).equals(hello), name).toBe(true);
        } else {
          expect(reply.equals(ALERT), name).toBe(true);
        }
      }
      expect(origin.connections).toHaveLength(mode === "monitor" ? claims.length : 0);
      const events = await queuedEvents(dataDir);
      expect(events.map((event) => [event.kind, event.action, event.reason, event.host, event.port, event.serviceId, event.ruleKind, event.app])).toEqual(
        claims.map(([, , app], index) => ["flow", mode === "monitor" ? "allowed" : "blocked", "tls-address-without-sni", "127.0.0.1", origin.port, index === 2 ? undefined : "steered-chat", undefined, app]),
      );
      expect(await counters(agent)).toEqual([claims.length, mode === "monitor" ? claims.length : 0]);
    });
  }

  it("is never tunnelled when PROXY UNKNOWN names no address, and a first record that is not a ClientHello is named unparseable", async () => {
    for (const mode of ["enforce", "monitor"] as const) {
      const { agent, dataDir } = await agentWith({ mode, unreproducibleTls: "tunnel" });
      for (const first of [records(noServerNameHello()), Buffer.from("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n")]) {
        const reply = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from("PROXY UNKNOWN\r\n"), first]));
        expect(reply.equals(ALERT), mode).toBe(true);
      }
      const events = await queuedEvents(dataDir);
      expect(events.map((event) => [event.action, event.reason, event.host, event.port]), mode).toEqual([
        ["blocked", "tls-address-without-sni", "unknown", 443],
        ["blocked", "tls-client-hello-unparseable", "unknown", 443],
      ]);
      expect(await counters(agent), mode).toEqual([2, 0]);
    }
  });

  it("replays every byte it read when the first record is not TLS, in monitor mode with the tunnel setting", async () => {
    const origin = await startRawOrigin();
    const { agent, dataDir } = await agentWith({ mode: "monitor", unreproducibleTls: "tunnel" });
    const inputs = [Buffer.from("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n"), Buffer.concat([Buffer.from([22, 3, 3, 0x40, 1]), Buffer.from("rest of the stream")])];
    for (const [index, input] of inputs.entries()) {
      const reply = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from(proxyLineTo(origin.port)), input]), { until: (bytes) => bytes.length >= 6 });
      expect(reply.toString()).toBe("origin");
      await delay(100);
      expect(origin.received(index).toString("latin1")).toBe(input.toString("latin1"));
    }
    expect((await queuedEvents(dataDir)).map((event) => [event.action, event.reason])).toEqual(inputs.map(() => ["allowed", "tls-address-without-sni"]));
  });
});

const rejectingOrigin = async (alert: number): Promise<{ port: number; hellos: number }> => {
  let hellos = 0;
  const server = net.createServer((socket) => {
    socket.on("error", () => undefined);
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 5 && received.length >= 5 + received.readUInt16BE(3)) {
        hellos += 1;
        socket.end(Buffer.from([21, 3, 3, 0, 2, 2, alert]));
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the rejecting origin has no port");
  return {
    port: address.port,
    get hellos() {
      return hellos;
    },
  };
};

const unusedPort = async (): Promise<number> => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  if (address === null || typeof address === "string") throw new Error("no port");
  return address.port;
};

const postThrough = async (agent: Running, body: string, userAgent: string): Promise<number> => {
  const socket = await tlsThroughConnect(agent, "chatgpt.com");
  try {
    const target = new URL("https://chatgpt.com/backend-api/conversation");
    return (await requestOnSocket(socket, target, { method: "POST", url: target.href, headers: { "content-type": "text/plain", "user-agent": userAgent, connection: "close" }, body })).status;
  } finally {
    socket.destroy();
  }
};

describe("an upstream connection that fails after the client's TLS finished", () => {
  it("reports an origin that rejects the replayed hello's parameters as coverage, blocked, with the request's app", async () => {
    for (const alert of [40, 47, 70]) {
      const origin = await rejectingOrigin(alert);
      const { agent, dataDir } = await agentWith({ mode: "enforce" }, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` } });
      expect(await postThrough(agent, "safe", "codex_cli_rs/1.0"), `alert ${alert}`).toBe(502);
      expect(origin.hellos, `alert ${alert}`).toBe(1);
      const events = await queuedEvents(dataDir);
      expect(events.map((event) => [event.action, event.reason, event.app]), `alert ${alert}`).toEqual([["blocked", "upstream-replay-failed", { cli: "codex", name: "codex_cli_rs" }]]);
    }
  });

  it("names a verified app's own service in that coverage event, not the request's User-Agent", async () => {
    const origin = await rejectingOrigin(40);
    const catalogue = catalogueDocument({
      services: [
        { serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: ["wrong-cli"], custom: true },
        { serviceId: "codex-app", name: "Codex", vendor: "Example", category: "code", domains: ["chatgpt.com"], bundleIds: ["com.example.codex"], cliNames: [], custom: true },
      ],
    });
    const { agent, dataDir, signer } = await agentWith({ mode: "enforce" }, { catalogue, upstreamMap: { "chatgpt.com": `https://127.0.0.1:${origin.port}` } });
    const proxyLine = proxyLineTo(443);
    const raw = net.connect(agent.transparentPort, "127.0.0.1");
    await once(raw, "connect");
    raw.write(Buffer.concat([Buffer.from(proxyLine), signer.line(proxyLine, { signingId: "com.example.codex" }).line]));
    const framed = await framedTls(raw, "chatgpt.com", { ca: agent.caPem });
    const target = new URL("https://chatgpt.com/backend-api/conversation");
    const reply = await requestOnSocket(framed.secure, target, { method: "POST", url: target.href, headers: { "content-type": "text/plain", "user-agent": "wrong-cli/1.0", connection: "close" }, body: "safe" });
    framed.secure.destroy();
    expect(reply.status).toBe(502);
    const events = await queuedEvents(dataDir);
    expect(events.map((event) => [event.reason, event.serviceId, event.app])).toEqual([["upstream-replay-failed", "codex-app", { bundleId: "com.example.codex" }]]);
  });

  it("keeps an unreachable, untrusted or certificate-refusing origin an ordinary allowed flow, not coverage", async () => {
    const certificate = await selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");
    const untrusted = await startTlsOrigin(certificate);
    const refusing = await rejectingOrigin(42);
    for (const [name, port] of [
      ["refused", await unusedPort()],
      ["untrusted certificate", untrusted.port],
      ["bad_certificate alert", refusing.port],
    ] as const) {
      const { agent, dataDir } = await agentWith({ mode: "enforce" }, { upstreamMap: { "chatgpt.com": `https://127.0.0.1:${port}` } });
      expect(await postThrough(agent, "benign", "Mozilla/5.0"), name).toBe(502);
      expect((await queuedEvents(dataDir)).map((event) => [event.kind, event.action, event.reason]), name).toEqual([["flow", "allowed", undefined]]);
      expect(await counters(agent), name).toEqual([0, 0]);
    }
    expect(untrusted.methods).toEqual([]);
  });

  it("keeps the inspected verdict when the origin reads the body and then drops the connection", async () => {
    for (const [mode, body, expected] of [
      ["monitor", "My TFN is 123 456 782", ["content", "observed", "au-tfn"]],
      ["enforce", "benign message", ["flow", "allowed", undefined]],
    ] as const) {
      const received: string[] = [];
      const origin = await startOrigin(suite.cleanup, (request, response) => {
        received.push(request.body.toString());
        response.socket?.destroy();
      });
      const { agent, dataDir } = await agentWith({ mode }, { upstreamMap: { "chatgpt.com": origin.url }, contentRules: [TFN] });
      expect(await postThrough(agent, body, "Mozilla/5.0"), mode).toBe(502);
      expect(received, mode).toEqual([body]);
      expect((await queuedEvents(dataDir)).map((event) => [event.kind, event.action, event.matchType]), mode).toEqual([expected]);
    }
  });
});
