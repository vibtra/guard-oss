import { once } from "node:events";
import http from "node:http";
import http2 from "node:http2";
import https from "node:https";
import tls from "node:tls";
import type net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { catalogueDocument, contentRule, selfSignedCertificate, waitUntil, type TestCertificate } from "./harness.ts";
import { h2Client, policyProfile, rawHttp, startRunning, tlsThroughConnect, useAgentSuite, type Running } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const TFN = contentRule("gcr_00000000000000d1", { kind: "au-tfn", requireContext: true });
const INSPECTION_LIMIT = 4 * 1024 * 1024;

const certificate = (): Promise<TestCertificate> => selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");

const listen = async (server: net.Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the origin has no port");
  return address.port;
};

interface Tracked {
  readonly opened: () => number;
  readonly closed: () => number;
}

const track = (server: net.Server): Tracked => {
  let opened = 0;
  let closed = 0;
  server.on("connection", (socket: net.Socket) => {
    opened += 1;
    socket.once("close", () => {
      closed += 1;
    });
  });
  return { opened: () => opened, closed: () => closed };
};

const guard = async (originPort: number, cert: TestCertificate, scheme: "https" | "http" = "https"): Promise<Running> => {
  const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] }, catalogue: CHAT });
  return startRunning(suite, profile, { upstreamMap: { "chatgpt.com": `${scheme}://127.0.0.1:${originPort}` }, args: ["--upstream-ca", cert.certPath] });
};

const closeServer = (server: net.Server & { closeAllConnections?: () => void }): void => {
  server.closeAllConnections?.();
  server.close();
};

describe("HTTP/2 on both TLS legs", () => {
  it("speaks h2 to the client and to an h2 origin, and still blocks before the origin", async () => {
    const cert = await certificate();
    const versions: string[] = [];
    const origin = http2.createSecureServer({ cert: cert.cert, key: cert.key, allowHTTP1: true }, (request, response) => {
      versions.push(request.httpVersion);
      request.resume();
      request.once("end", () => response.end("ok"));
    });
    const port = await listen(origin);
    suite.cleanup.defer(async () => closeServer(origin));
    const agent = await guard(port, cert);
    const client = h2Client(await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: ["h2", "http/1.1"] }));
    const allowed = await client.request({ method: "POST", path: "/upload", headers: { "content-type": "application/octet-stream" }, body: "safe" });
    expect([allowed.status, allowed.text, versions]).toEqual([200, "ok", ["2.0"]]);
    const blocked = await client.request({ method: "POST", path: "/backend-api/conversation", headers: { "content-type": "application/json" }, body: '{"messages":[{"content":"My TFN is 123 456 782"}]}' });
    client.close();
    expect([blocked.status, blocked.text.includes("GUARD_BLOCKED"), versions]).toEqual([403, true, ["2.0"]]);
  });

  it("keeps each client TLS connection on its own upstream connection and reuses that connection for the same client", async () => {
    const cert = await certificate();
    const peers: string[] = [];
    const origin = https.createServer({ cert: cert.cert, key: cert.key }, (request, response) => {
      peers.push(`${request.socket.remotePort}`);
      response.end("ok");
    });
    const port = await listen(origin);
    suite.cleanup.defer(async () => closeServer(origin));
    const agent = await guard(port, cert);
    for (let client = 0; client < 2; client += 1) {
      const connection = rawHttp(await tlsThroughConnect(agent, "chatgpt.com"));
      for (let request = 0; request < 2; request += 1) {
        connection.send("GET /session HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n");
        expect((await connection.response()).status).toBe(200);
      }
      connection.close();
    }
    expect(peers).toHaveLength(4);
    const [firstA, secondA, firstB, secondB] = peers;
    expect([firstA === secondA, firstB === secondB, firstA === firstB]).toEqual([true, true, false]);
  });

  for (const [name, clientH2, originH2, closeEach, maxVersion] of [
    ["an HTTP/1.1 client and a TLS 1.3 origin that closes after each response", false, false, true, "TLSv1.3"],
    ["an HTTP/1.1 client and a TLS 1.2 origin that closes after each response", false, false, true, "TLSv1.2"],
    ["an h2 client and an HTTP/1.1 origin that closes after each response", true, false, true, "TLSv1.3"],
    ["an h2 client and an h2 origin", true, true, false, "TLSv1.3"],
  ] as const) {
    it(`reconnects as needed, speaks the protocol each side chose, and closes every upstream connection when the client leaves: ${name}`, async () => {
      const cert = await certificate();
      const versions: string[] = [];
      const handler = (request: http.IncomingMessage | http2.Http2ServerRequest, response: http.ServerResponse | http2.Http2ServerResponse): void => {
        versions.push(request.httpVersion);
        if (closeEach) response.setHeader("connection", "close");
        response.end("ok");
      };
      const origin = originH2 ? http2.createSecureServer({ cert: cert.cert, key: cert.key, allowHTTP1: true, maxVersion }, handler) : https.createServer({ cert: cert.cert, key: cert.key, maxVersion, ALPNProtocols: ["http/1.1"] }, handler);
      const tracked = track(origin);
      const port = await listen(origin);
      suite.cleanup.defer(async () => closeServer(origin));
      const agent = await guard(port, cert);
      const socket = await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: clientH2 ? ["h2", "http/1.1"] : ["http/1.1"] });
      if (clientH2) {
        const client = h2Client(socket);
        for (let index = 0; index < 3; index += 1) expect(await client.request({ method: "GET", path: "/session" }), `request ${index}`).toMatchObject({ status: 200, text: "ok" });
        client.close();
      } else {
        const connection = rawHttp(socket);
        for (let index = 0; index < 3; index += 1) {
          connection.send("GET /session HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n");
          const reply = await connection.response();
          expect([reply.status, reply.body.toString()], `request ${index}`).toEqual([200, "ok"]);
        }
        connection.close();
      }
      expect(versions).toEqual(Array.from({ length: 3 }, () => (originH2 ? "2.0" : "1.1")));
      if (closeEach) expect(tracked.opened()).toBe(3);
      else expect(tracked.opened()).toBe(1);
      await waitUntil("every upstream connection to close", async () => (tracked.closed() === tracked.opened() ? true : undefined), 3_000);
    });
  }
});

interface TrailerResponse {
  setHeader(name: string, value: string): unknown;
  write(chunk: string): unknown;
  addTrailers(headers: Record<string, string>): void;
  end(): unknown;
}

describe("trailers", () => {
  for (const kind of ["h2", "h1-tls", "h1-plain"] as const) {
    it(`carries request trailers to the origin and response trailers back to an h2 client, origin ${kind}`, async () => {
      const cert = await certificate();
      const seen: { body: string; trailer: string | undefined; te: string | undefined }[] = [];
      const handler = (request: http.IncomingMessage | http2.Http2ServerRequest, response: TrailerResponse): void => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.once("end", () => {
          const trailer = request.trailers["x-request-end"];
          seen.push({ body: Buffer.concat(chunks).toString(), trailer: Array.isArray(trailer) ? trailer.join(",") : trailer, te: request.headers.te === undefined ? undefined : String(request.headers.te) });
          response.setHeader("content-type", "application/grpc");
          response.setHeader("trailer", "grpc-status, grpc-message");
          response.write("reply");
          response.addTrailers({ "grpc-status": "0", "grpc-message": "complete" });
          response.end();
        });
      };
      const origin = kind === "h2" ? http2.createSecureServer({ cert: cert.cert, key: cert.key }, handler) : kind === "h1-tls" ? https.createServer({ cert: cert.cert, key: cert.key }, handler) : http.createServer(handler);
      const port = await listen(origin);
      suite.cleanup.defer(async () => closeServer(origin));
      const agent = await guard(port, cert, kind === "h1-plain" ? "http" : "https");
      const client = h2Client(await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: ["h2", "http/1.1"] }));
      const reply = await client.request({ method: "POST", path: "/grpc", headers: { "content-type": "application/grpc", te: "trailers" }, body: "safe", trailers: { "x-request-end": "complete" } });
      client.close();
      expect(seen).toEqual([{ body: "safe", trailer: "complete", te: kind === "h2" ? "trailers" : undefined }]);
      expect([reply.status, reply.text, reply.trailers["grpc-status"], reply.trailers["grpc-message"]]).toEqual([200, "reply", "0", "complete"]);
    });
  }

  it("sends an empty h2 request body to an HTTP/1.1-only origin as a complete empty request, at once", async () => {
    const cert = await certificate();
    const seen: { te: string | undefined; length: string | undefined; body: string }[] = [];
    const origin = https.createServer({ cert: cert.cert, key: cert.key, ALPNProtocols: ["http/1.1"] }, (request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        seen.push({ te: request.headers["transfer-encoding"], length: request.headers["content-length"], body: Buffer.concat(chunks).toString() });
        response.end("ok");
      });
    });
    const port = await listen(origin);
    suite.cleanup.defer(async () => closeServer(origin));
    const agent = await guard(port, cert);
    const client = h2Client(await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: ["h2", "http/1.1"] }));
    const started = Date.now();
    const reply = await client.request({ method: "POST", path: "/backend-api/conversation", headers: { "content-type": "application/json" }, body: "" });
    client.close();
    expect([reply.status, Date.now() - started < 1_000]).toEqual([200, true]);
    expect(seen).toEqual([{ te: undefined, length: "0", body: "" }]);
  });
});

type Refusal = "refused-stream" | "goaway-before-stream" | "refuse-every-connection" | "internal-error" | "goaway-after-stream" | "connection-dropped";

interface RefusingOrigin {
  readonly port: number;
  readonly sessions: () => number;
  readonly served: { body: string; trailers: Record<string, string | string[] | undefined> }[];
}

const PREFACE = "PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n";

const frame = (type: number, flags: number, streamId: number, payload: Buffer = Buffer.alloc(0)): Buffer => {
  const header = Buffer.alloc(9);
  header.writeUIntBE(payload.length, 0, 3);
  header.writeUInt8(type, 3);
  header.writeUInt8(flags, 4);
  header.writeUInt32BE(streamId, 5);
  return Buffer.concat([header, payload]);
};

const u32s = (...values: number[]): Buffer => Buffer.concat(values.map((value) => Buffer.from([value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff])));

const refuseOnFrames = (socket: tls.TLSSocket, refusal: Refusal): void => {
  let buffer = Buffer.alloc(0);
  let preface = false;
  socket.on("error", () => undefined);
  socket.write(frame(4, 0, 0));
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!preface) {
      if (buffer.length < PREFACE.length) return;
      buffer = buffer.subarray(PREFACE.length);
      preface = true;
    }
    while (buffer.length >= 9 && buffer.length >= 9 + buffer.readUIntBE(0, 3)) {
      const type = buffer.readUInt8(3);
      const flags = buffer.readUInt8(4);
      const streamId = buffer.readUInt32BE(5) & 0x7fffffff;
      buffer = buffer.subarray(9 + buffer.readUIntBE(0, 3));
      if (type === 4 && (flags & 1) === 0) socket.write(frame(4, 1, 0));
      if (type !== 1) continue;
      if (refusal === "connection-dropped") {
        socket.destroy();
        return;
      }
      if (refusal === "goaway-before-stream" || refusal === "goaway-after-stream") {
        socket.end(frame(7, 0, 0, u32s(refusal === "goaway-before-stream" ? 0 : streamId, 0)));
        return;
      }
      socket.write(frame(3, 0, streamId, u32s(refusal === "internal-error" ? 2 : 7)));
      setTimeout(() => socket.end(), 1_000);
    }
  });
};

const refusingOrigin = async (cert: TestCertificate, refusal: Refusal): Promise<RefusingOrigin> => {
  let sessions = 0;
  const served: RefusingOrigin["served"] = [];
  const h2 = http2.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      served.push({ body: Buffer.concat(chunks).toString(), trailers: { ...request.trailers } });
      response.end("ok");
    });
  });
  const server = tls.createServer({ cert: cert.cert, key: cert.key, ALPNProtocols: ["h2"] }, (socket) => {
    sessions += 1;
    if (sessions === 1 || refusal === "refuse-every-connection") refuseOnFrames(socket, refusal);
    else h2.emit("connection", socket);
  });
  const port = await listen(server);
  suite.cleanup.defer(async () => {
    server.close();
    h2.close();
  });
  return { port, sessions: () => sessions, served };
};

describe("an h2 origin that refuses a request before processing it", () => {
  for (const [name, method, contentType, body, trailers, retried] of [
    ["an empty GET", "GET", undefined, undefined, undefined, true],
    ["an empty GET of an uninspected type", "GET", "application/octet-stream", undefined, undefined, true],
    ["a buffered JSON POST", "POST", "application/json", '{"text":"safe"}', undefined, true],
    ["a buffered POST with trailers", "POST", "text/plain", "safe", { "x-checksum": "complete" }, true],
    ["a POST over the inspection limit", "POST", "text/plain", "x".repeat(INSPECTION_LIMIT + 1), undefined, false],
    ["a streamed POST of an uninspected type", "POST", "application/octet-stream", "stream payload", undefined, false],
  ] as const) {
    it(`retries once on a new connection only when the whole request was buffered: ${name}`, { timeout: 30_000 }, async () => {
      const cert = await certificate();
      const origin = await refusingOrigin(cert, "refused-stream");
      const agent = await guard(origin.port, cert);
      const client = h2Client(await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: ["h2", "http/1.1"] }));
      const reply = await client.request({ method, path: "/retry", headers: contentType === undefined ? {} : { "content-type": contentType }, ...(body === undefined ? {} : { body }), ...(trailers === undefined ? {} : { trailers }) });
      client.close();
      expect([reply.status, origin.sessions()]).toEqual(retried ? [200, 2] : [502, 1]);
      if (retried) {
        expect(origin.served.map((item) => item.body)).toEqual([body ?? ""]);
        if (trailers !== undefined) expect(origin.served[0]?.trailers).toMatchObject({ "x-checksum": "complete" });
      }
    });
  }

  for (const [refusal, retried] of [
    ["goaway-before-stream", true],
    ["refuse-every-connection", false],
    ["internal-error", false],
    ["goaway-after-stream", false],
    ["connection-dropped", false],
  ] as const) {
    it(`retries a GOAWAY that excludes the stream once, and never an ambiguous failure: ${refusal}`, { timeout: 30_000 }, async () => {
      const cert = await certificate();
      const origin = await refusingOrigin(cert, refusal);
      const agent = await guard(origin.port, cert);
      const client = h2Client(await tlsThroughConnect(agent, "chatgpt.com", 443, { ALPNProtocols: ["h2", "http/1.1"] }));
      const reply = await client.request({ method: "POST", path: "/retry", headers: { "content-type": "application/json" }, body: '{"text":"request payload"}' });
      client.close();
      await delay(100);
      expect([reply.status, origin.sessions()]).toEqual(retried ? [200, 2] : [502, refusal === "refuse-every-connection" ? 2 : 1]);
    });
  }
});
