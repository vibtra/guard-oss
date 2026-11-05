import { once } from "node:events";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, contentRule, createSigner, signEnvelope, startFakeRegistry, waitUntil, webSocketDeflate, webSocketFrame, type Json } from "./harness.ts";
import { activityRows, local, policyProfile, queuedEvents, record, startRunning, useAgentSuite, type Running } from "./running.ts";

const suite = useAgentSuite();
const RULES = [contentRule("gcr_00000000000000f1", { kind: "card-number" }), contentRule("gcr_00000000000000f2", { kind: "secret" })];
const socketCatalogue = (enabled: boolean): Json =>
  catalogueDocument({ services: [{ serviceId: "socket", name: "Socket", vendor: "Example", category: "chat", domains: ["127.0.0.1"], bundleIds: [], cliNames: [], custom: true, enabled }] });
const OK = Buffer.from([0x81, 2, 0x4f, 0x4b]);
const KEY = '{"message":"-----BEGIN PRIVATE KEY-----\\nGUARD_SYNTHETIC_NOT_A_KEY"}';
const CARD_A = '{"message":"Guard synthetic card 4111 ';
const CARD_B = '1111 1111 1111."}';
const BENIGN = '{"message":"Write a friendly greeting","duration":0.4111111111111111}';
const PING = webSocketFrame(9, "ping");
const OPAQUE_WORD = "zebrafinch42";

interface WsOrigin {
  readonly port: number;
  readonly received: Buffer[];
  replyAfter: number;
}

const startWsOrigin = async (options: { extensions?: string; greeting?: Buffer; replyAfter?: number } = {}): Promise<WsOrigin> => {
  const received: Buffer[] = [];
  const origin: { port: number; received: Buffer[]; replyAfter: number } = { port: 0, received, replyAfter: options.replyAfter ?? Number.POSITIVE_INFINITY };
  const server = net.createServer((socket) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    let replied = false;
    const index = received.push(Buffer.alloc(0)) - 1;
    socket.on("error", () => undefined);
    socket.on("data", (chunk: Buffer) => {
      if (!upgraded) {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        upgraded = true;
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n${options.extensions === undefined ? "" : `Sec-WebSocket-Extensions: ${options.extensions}\r\n`}\r\n`);
        if (options.greeting !== undefined) socket.write(options.greeting);
        chunk = head.subarray(end + 4);
      }
      received[index] = Buffer.concat([received[index] ?? Buffer.alloc(0), chunk]);
      if (!replied && (received[index]?.length ?? 0) >= origin.replyAfter) {
        replied = true;
        socket.write(OK);
      }
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the WebSocket origin has no port");
  origin.port = address.port;
  return origin;
};

interface WsClient {
  readonly status: number;
  readonly socket: net.Socket;
  received(): Buffer;
  bytes(count: number, timeoutMs?: number): Promise<Buffer>;
  closed(timeoutMs?: number): Promise<Buffer>;
}

const openWs = async (agent: Running, origin: WsOrigin, extensions?: string): Promise<WsClient> => {
  const socket = net.connect(agent.proxyPort, "127.0.0.1");
  await once(socket, "connect");
  socket.on("error", () => undefined);
  suite.cleanup.defer(async () => {
    socket.destroy();
  });
  let head = Buffer.alloc(0);
  let body = Buffer.alloc(0);
  let isClosed = false;
  const headers = Promise.withResolvers<number>();
  socket.on("data", (chunk: Buffer) => {
    if (head.indexOf("\r\n\r\n") < 0) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      body = head.subarray(end + 4);
      head = head.subarray(0, end + 4);
      headers.resolve(Number(head.toString().split(" ")[1]));
      return;
    }
    body = Buffer.concat([body, chunk]);
  });
  socket.on("close", () => {
    isClosed = true;
    headers.resolve(0);
  });
  const authority = `127.0.0.1:${origin.port}`;
  socket.write(
    `GET http://${authority}/ws/test HTTP/1.1\r\nHost: ${authority}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nUser-Agent: Chrome\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n${extensions === undefined ? "" : `Sec-WebSocket-Extensions: ${extensions}\r\n`}\r\n`,
  );
  const status = await headers.promise;
  return {
    status,
    socket,
    received: () => body,
    bytes: (count, timeoutMs = 5_000) => waitUntil(`${count} bytes from the agent`, async () => (body.length >= count ? body : isClosed ? body : undefined), timeoutMs),
    closed: (timeoutMs = 5_000) => waitUntil("the agent to close the WebSocket", async () => (isClosed ? body : undefined), timeoutMs),
  };
};

const closeOf = (bytes: Buffer, label: string): number => {
  expect(bytes[0], `${label}: a close frame`).toBe(0x88);
  const length = bytes[1] ?? 0;
  expect(length, label).toBeLessThanOrEqual(125);
  expect(bytes.length, `${label}: one close frame and nothing after it`).toBe(length + 2);
  const code = bytes.readUInt16BE(2);
  const reason = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4));
  expect(reason, label).toBe(code === 1008 ? "Vibtra Guard blocked this message" : "Vibtra Guard closed this connection");
  for (const forbidden of ["vibtra.policy/v1", '"policy"']) expect(reason, label).not.toContain(forbidden);
  return code;
};

const socketAgent = async (changes: Json = {}, enabled = true): Promise<Running> => {
  const profile = await policyProfile(suite, { bundle: { contentRules: RULES, ...changes }, catalogue: socketCatalogue(enabled) });
  return startRunning(suite, profile);
};

const COVERAGE_REASONS: Readonly<Record<string, string>> = { unmasked: "invalid-websocket-frame", oversize: "websocket-message-too-large", "invalid deflate": "invalid-websocket-compression" };

const websocketRows = async (agent: Running): Promise<Json[]> => (await activityRows(agent)).filter((row) => row.method === "WEBSOCKET");

describe("WebSocket messages through the proxy", () => {
  it("decides each message before the origin sees a byte of it and forwards allowed messages unchanged", async () => {
    const [cardA, cardB] = [webSocketFrame(1, CARD_A, { fin: false }), webSocketFrame(0, CARD_B)];
    const cases: { name: string; wire: Buffer; extensions?: string; code?: number; control?: Buffer; mode?: "monitor" | "excluded" }[] = [
      { name: "key", wire: webSocketFrame(1, KEY), code: 1008 },
      { name: "fragmented card", wire: Buffer.concat([cardA, cardB]), code: 1008 },
      { name: "compressed key", wire: webSocketFrame(1, (await webSocketDeflate([KEY]))[0] ?? Buffer.alloc(0), { compressed: true }), extensions: "permessage-deflate; client_no_context_takeover", code: 1008 },
      { name: "binary card", wire: webSocketFrame(2, `{"message":"card 4111 1111 1111 1111","requestId":"9b14768e-d47a-4f1f-a062-2d40bda53667"}`), code: 1008 },
      { name: "split key around a ping", wire: Buffer.concat([webSocketFrame(1, '{"message":"-----BE', { fin: false }), PING, webSocketFrame(0, 'GIN PRIVATE KEY-----', { fin: false }), webSocketFrame(0, '"}')]), code: 1008, control: PING },
      { name: "card split around a ping", wire: Buffer.concat([cardA, PING, cardB]), code: 1008, control: PING },
      { name: "opaque binary", wire: webSocketFrame(2, Buffer.concat([Buffer.from([0x12, OPAQUE_WORD.length]), Buffer.from(OPAQUE_WORD)])), code: 1003 },
      { name: "plain allowed", wire: webSocketFrame(1, BENIGN) },
      { name: "compressed allowed", wire: webSocketFrame(1, (await webSocketDeflate([BENIGN]))[0] ?? Buffer.alloc(0), { compressed: true }), extensions: "permessage-deflate" },
      { name: "binary JSON allowed", wire: webSocketFrame(2, BENIGN) },
      { name: "fields kept apart", wire: webSocketFrame(1, '{"a":"41111111","b":"11111111"}') },
      { name: "monitor forwards", wire: webSocketFrame(1, KEY), mode: "monitor" },
      { name: "excluded forwards untouched", wire: webSocketFrame(1, KEY), mode: "excluded" },
    ];
    const enforcing = await socketAgent();
    const monitoring = await socketAgent({ clientMode: "monitor" });
    const excluded = await socketAgent({}, false);
    for (const item of cases) {
      const agent = item.mode === "monitor" ? monitoring : item.mode === "excluded" ? excluded : enforcing;
      const origin = await startWsOrigin({ replyAfter: item.wire.length, ...(item.extensions === undefined ? {} : { extensions: item.extensions }) });
      const client = await openWs(agent, origin, item.extensions);
      expect(client.status, item.name).toBe(101);
      client.socket.write(item.wire);
      if (item.code === undefined) {
        expect(await client.bytes(4), item.name).toEqual(OK);
        expect(origin.received[0]?.equals(item.wire), `${item.name}: the origin got the original bytes`).toBe(true);
      } else {
        expect(closeOf(await client.closed(), item.name), item.name).toBe(item.code);
        await delay(100);
        expect(origin.received[0] ?? Buffer.alloc(0), `${item.name}: only control frames reached the origin`).toEqual(item.control ?? Buffer.alloc(0));
      }
      client.socket.destroy();
    }
    for (const agent of [enforcing, monitoring]) {
      const rows = await websocketRows(agent);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) expect(record(row.inspection).transport).toBe("websocket-message");
    }
    expect((await websocketRows(enforcing)).filter((row) => row.action === "blocked").length).toBeGreaterThanOrEqual(7);
    expect(await websocketRows(excluded)).toEqual([]);
    const opaque = (await websocketRows(enforcing)).find((row) => record(row.inspection).opcode === "binary" && record(row.inspection).validJSON === false);
    expect(opaque).toBeDefined();
    for (const agent of [enforcing, monitoring, excluded]) {
      const stored = JSON.stringify([await activityRows(agent), await queuedEvents(agent.dataDir)]);
      for (const secret of ["GUARD_SYNTHETIC_NOT_A_KEY", "4111 1111", "Guard synthetic card", OPAQUE_WORD]) expect(stored, secret).not.toContain(secret);
    }
  });

  it("closes with the matching code on every malformed frame and forwards none of it", async () => {
    const agent = await socketAgent();
    const cases: [string, Buffer, number, string?, boolean?][] = [
      ["unmasked", Buffer.from([0x81, 1, 0x78]), 1002],
      ["reserved opcode", webSocketFrame(3, ""), 1002],
      ["orphan continuation", webSocketFrame(0, "x"), 1002],
      ["truncated", Buffer.from([0x81]), 1002, undefined, true],
      ["noncanonical length", Buffer.from([0x81, 0xfe, 0, 1]), 1002],
      ["high-bit length", Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 0]), 1002],
      ["oversize", Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x40, 0, 1]), 1009],
      ["invalid UTF-8", webSocketFrame(1, Buffer.from([0xff])), 1007],
      ["compression not negotiated", webSocketFrame(1, "x", { compressed: true }), 1002],
      ["fragmented ping", webSocketFrame(9, "", { fin: false }), 1002],
      ["compressed ping", webSocketFrame(9, "", { compressed: true }), 1002],
      ["oversize ping", webSocketFrame(9, Buffer.alloc(126)), 1002],
      ["bad close length", webSocketFrame(8, Buffer.from([1])), 1002],
      ["reserved close code", webSocketFrame(8, Buffer.from([3, 237])), 1002],
      ["bad close UTF-8", webSocketFrame(8, Buffer.from([3, 232, 255])), 1007],
      ["unfinished message", webSocketFrame(1, "hi", { fin: false }), 1002, undefined, true],
      ["interleaved data", Buffer.concat([webSocketFrame(1, "a", { fin: false }), webSocketFrame(2, "b")]), 1002],
      ["compressed continuation", Buffer.concat([webSocketFrame(1, "a", { fin: false }), webSocketFrame(0, "b", { compressed: true })]), 1002, "permessage-deflate"],
      ["frame limit", Buffer.concat([webSocketFrame(1, "", { fin: false }), ...Array.from({ length: 256 }, (_, index) => webSocketFrame(0, "", { fin: index === 255 }))]), 1009],
      ["invalid deflate", webSocketFrame(1, Buffer.from([0xff, 0xff]), { compressed: true }), 1002, "permessage-deflate"],
      ["deflate expansion", webSocketFrame(1, (await webSocketDeflate([Buffer.alloc(4 * 1024 * 1024 + 1, "x")]))[0] ?? Buffer.alloc(0), { compressed: true }), 1009, "permessage-deflate"],
    ];
    let newest: unknown;
    for (const [name, wire, code, extensions, end] of cases) {
      const origin = await startWsOrigin(extensions === undefined ? {} : { extensions });
      const client = await openWs(agent, origin, extensions);
      if (end === true) client.socket.end(wire);
      else client.socket.write(wire);
      expect(closeOf(await client.closed(), name), name).toBe(code);
      expect(origin.received[0] ?? Buffer.alloc(0), name).toEqual(Buffer.alloc(0));
      const coverage = COVERAGE_REASONS[name];
      if (coverage !== undefined) {
        const [row] = await websocketRows(agent);
        expect(row?.eventId, `${name}: a new activity row`).not.toBe(newest);
        newest = row?.eventId;
        const inspection = record(row?.inspection);
        expect([row?.action, row?.reason, row?.ruleName, inspection.state, inspection.coverageFailure, inspection.reason], name).toEqual(["blocked", "websocket-coverage", "Inspection unavailable", "flow-only", true, coverage]);
        const page = await local(agent, `/blocked/${String(row?.eventId)}`);
        expect([page.status, page.text.includes("Guard could not check this request safely. Ask your administrator to review Guard&#39;s coverage before you try again.")], `${name}: the block page`).toEqual([200, true]);
      }
    }
  });

  it("refuses an origin that negotiates an extension it cannot inspect", async () => {
    const agent = await socketAgent();
    for (const extensions of [
      "x-unknown",
      "permessage-deflate, permessage-deflate",
      "permessage-deflate; unknown",
      "permessage-deflate; client_no_context_takeover=1",
      "permessage-deflate; client_max_window_bits",
      "permessage-deflate; client_max_window_bits=7",
      "permessage-deflate; client_max_window_bits=16",
      "permessage-deflate; client_no_context_takeover; client_no_context_takeover",
    ]) {
      const before = (await websocketRows(agent)).length;
      const client = await openWs(agent, await startWsOrigin({ extensions }), extensions);
      expect(client.status, extensions).toBe(502);
      const rows = await websocketRows(agent);
      expect(rows.length, extensions).toBe(before + 1);
      expect([record(rows[0]?.inspection).reason, record(rows[0]?.inspection).coverageFailure], extensions).toEqual(["unsupported-websocket-extension", true]);
      client.socket.destroy();
    }
  });

  it("keeps the compression context between messages, and accepts independently compressed messages when the client keeps no context", async () => {
    const agent = await socketAgent();
    const text = `${"repeated harmless context ".repeat(2000)}`;
    const extensions = "permessage-deflate; server_no_context_takeover; client_max_window_bits=15";
    const payloads = await webSocketDeflate([text, text, "tail", `${text}{"message":"card 4111 1111 1111 1111"}`]);
    const wires = payloads.map((payload) => {
      const middle = Math.floor(payload.length / 2);
      return Buffer.concat([webSocketFrame(1, payload.subarray(0, middle), { fin: false, compressed: true }), webSocketFrame(0, payload.subarray(middle))]);
    });
    const allowed = Buffer.concat(wires.slice(0, 3));
    const origin = await startWsOrigin({ extensions, replyAfter: allowed.length });
    const client = await openWs(agent, origin, extensions);
    client.socket.write(allowed);
    expect(await client.bytes(4)).toEqual(OK);
    expect(origin.received[0]?.equals(allowed)).toBe(true);
    client.socket.write(wires[3] ?? Buffer.alloc(0));
    expect(closeOf((await client.closed()).subarray(4), "context card")).toBe(1008);

    const fresh = Buffer.concat(await Promise.all([text, text].map(async (message) => webSocketFrame(1, (await webSocketDeflate([message]))[0] ?? Buffer.alloc(0), { compressed: true }))));
    const independent = await startWsOrigin({ extensions: "permessage-deflate; client_no_context_takeover", replyAfter: fresh.length });
    const second = await openWs(agent, independent, "permessage-deflate; client_no_context_takeover");
    second.socket.write(fresh);
    expect(await second.bytes(4)).toEqual(OK);
    expect(independent.received[0]?.equals(fresh)).toBe(true);
  });

  it("forwards control frames at once, the message after its last fragment, and drops a message a close interrupts", async () => {
    const agent = await socketAgent();
    const [first, last] = [webSocketFrame(1, "a", { fin: false }), webSocketFrame(0, "b")];
    const expected = Buffer.concat([PING, PING, first, last]);
    const origin = await startWsOrigin({ replyAfter: expected.length });
    const client = await openWs(agent, origin);
    client.socket.write(Buffer.concat([PING, first, PING, last]));
    expect(await client.bytes(4)).toEqual(OK);
    expect(origin.received[0]).toEqual(expected);

    const close = webSocketFrame(8, Buffer.from([3, 232]));
    const closing = await startWsOrigin();
    const interrupted = await openWs(agent, closing);
    interrupted.socket.write(Buffer.concat([webSocketFrame(1, "not delivered", { fin: false }), close]));
    await waitUntil("the close to reach the origin", async () => ((closing.received[0]?.length ?? 0) > 0 ? true : undefined));
    await delay(200);
    expect(closing.received[0]).toEqual(close);
  });

  it("lets an idle connection stay open but closes one that stops in the middle of a frame", { timeout: 60_000 }, async () => {
    const agent = await socketAgent();
    const message = webSocketFrame(1, BENIGN);
    const idleOrigin = await startWsOrigin({ replyAfter: message.length * 2 });
    const idle = await openWs(agent, idleOrigin);
    idle.socket.write(message);
    const stalledOrigin = await startWsOrigin();
    const stalled = await openWs(agent, stalledOrigin);
    const partial = webSocketFrame(1, '{"message":"unfinished"}').subarray(0, 7);
    const started = Date.now();
    stalled.socket.write(partial);
    expect(closeOf(await stalled.closed(25_000), "stalled")).toBe(1002);
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(stalledOrigin.received[0] ?? Buffer.alloc(0)).toEqual(Buffer.alloc(0));
    await delay(Math.max(0, 16_000 - (Date.now() - started)));
    idle.socket.write(message);
    expect(await idle.bytes(4)).toEqual(OK);
    expect(idleOrigin.received[0]).toEqual(Buffer.concat([message, message]));
  });

  it("applies a policy that arrives while the connection is open", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.override((call) => (call.door === "eventupload" ? { status: 503, body: { code: "UNAVAILABLE" } } : undefined));
    const catalogue = socketCatalogue(true);
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url, catalogue });
    const agent = await startRunning(suite, profile);
    const benign = webSocketFrame(1, '{"message":"hello"}');
    const origin = await startWsOrigin({ replyAfter: benign.length });
    const client = await openWs(agent, origin);
    client.socket.write(benign);
    expect(await client.bytes(4)).toEqual(OK);
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { bundleVersion: 2, contentRules: RULES })), catalogue: null });
    await waitUntil("bundle version 2", async () => ((await agent.status()).bundleVersion === 2 ? true : undefined));
    client.socket.write(webSocketFrame(1, KEY));
    expect(closeOf((await client.closed()).subarray(4), "after the update")).toBe(1008);
    expect(origin.received[0]).toEqual(benign);
  });

  it("puts a policy close only after a whole frame from the origin", async () => {
    const agent = await socketAgent();
    const whole = Buffer.concat([Buffer.from([0x81, 6]), Buffer.from("ABCDEF")]);
    const complete = await openWs(agent, await startWsOrigin({ greeting: whole }));
    expect(await complete.bytes(whole.length)).toEqual(whole);
    complete.socket.write(webSocketFrame(1, KEY));
    const after = await complete.closed();
    expect(after.subarray(0, whole.length)).toEqual(whole);
    expect(closeOf(after.subarray(whole.length), "after a whole frame")).toBe(1008);

    const prefix = Buffer.concat([Buffer.from([0x81, 6]), Buffer.from("AB")]);
    const partial = await openWs(agent, await startWsOrigin({ greeting: prefix }));
    expect(await partial.bytes(prefix.length)).toEqual(prefix);
    partial.socket.write(webSocketFrame(1, KEY));
    expect(await partial.closed()).toEqual(prefix);
  });
});
