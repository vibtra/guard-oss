import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import tls from "node:tls";
import { describe, expect, it } from "vitest";
import { catalogueDocument, selfSignedCertificate, waitUntil, type TestCertificate } from "./harness.ts";
import { policyProfile, rawHttp, startRunning, tlsThroughConnect, useAgentSuite, type RawHttp, type RawMessage, type Running } from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const OK = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";

type Respond = (request: RawMessage, socket: net.Socket) => string | undefined;

interface WireOrigin {
  readonly port: number;
  readonly requests: RawMessage[];
  readonly opened: () => number;
  readonly closed: () => number;
}

const startWireOrigin = async (cert: TestCertificate | undefined, respond: Respond = () => OK): Promise<WireOrigin> => {
  const requests: RawMessage[] = [];
  let opened = 0;
  let closed = 0;
  const serve = (socket: net.Socket): void => {
    opened += 1;
    socket.once("close", () => {
      closed += 1;
    });
    const connection = rawHttp(socket);
    void (async () => {
      for (;;) {
        const request = await connection.request(60_000).catch(() => undefined);
        if (request === undefined) return;
        requests.push(request);
        const answer = respond(request, socket);
        if (answer !== undefined) connection.send(answer);
      }
    })();
  };
  const server = cert === undefined ? net.createServer(serve) : tls.createServer({ cert: cert.cert, key: cert.key, ALPNProtocols: ["http/1.1"] }, serve);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.close();
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the wire origin has no port");
  return { port: address.port, requests, opened: () => opened, closed: () => closed };
};

const guard = async (origin: WireOrigin, cert: TestCertificate | undefined): Promise<Running> => {
  const profile = await policyProfile(suite, { catalogue: CHAT });
  return startRunning(suite, profile, { upstreamMap: { "chatgpt.com": `${cert === undefined ? "http" : "https"}://127.0.0.1:${origin.port}` }, ...(cert === undefined ? {} : { args: ["--upstream-ca", cert.certPath] }) });
};

const through = async (agent: Running): Promise<RawHttp> => rawHttp(await tlsThroughConnect(agent, "chatgpt.com"));

const certificate = (): Promise<TestCertificate> => selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");

describe("HTTP/1.1 header bytes", () => {
  it("reach the origin in the order and letter case the client sent", async () => {
    const cert = await certificate();
    const origin = await startWireOrigin(cert);
    const request = "GET /wire?x=1 HTTP/1.1\r\nHost: chatgpt.com\r\nUser-Agent: WireClient/1.0\r\nX-Zeta: z\r\nx-lower-case: l\r\nX-Alpha: a\r\nAccept-Language: en\r\nAccept: */*\r\n\r\n";
    const direct = rawHttp(tls.connect({ host: "127.0.0.1", port: origin.port, servername: "chatgpt.com", ca: cert.cert, ALPNProtocols: ["http/1.1"] }));
    direct.send(request);
    expect((await direct.response()).status).toBe(200);
    direct.close();
    const agent = await guard(origin, cert);
    const guarded = await through(agent);
    guarded.send(request);
    expect((await guarded.response()).status).toBe(200);
    guarded.close();
    expect(origin.requests.map((item) => [item.startLine, item.headerLines])).toEqual([
      ["GET /wire?x=1 HTTP/1.1", ["Host: chatgpt.com", "User-Agent: WireClient/1.0", "X-Zeta: z", "x-lower-case: l", "X-Alpha: a", "Accept-Language: en", "Accept: */*"]],
      ["GET /wire?x=1 HTTP/1.1", ["Host: chatgpt.com", "User-Agent: WireClient/1.0", "X-Zeta: z", "x-lower-case: l", "X-Alpha: a", "Accept-Language: en", "Accept: */*"]],
    ]);
  });

  it("fall back to the parsed form when the raw bytes and the parsed request could disagree, and never pass a line the parser refused", async () => {
    const origin = await startWireOrigin(undefined);
    const agent = await guard(origin, undefined);
    for (const [odd, status, forwarded] of [
      ["Connection: x\nX-Hidden: secret", 200, ["X-Hidden: secret", "X-Lower-Case: l"]],
      ["X-Test: a\r\n folded", 200, ["X-Lower-Case: l", "X-Test: a folded"]],
      ["X-Test: a\rb", 400, undefined],
      ["X Bad: value", 400, undefined],
    ] as const) {
      const connection = await through(agent);
      const before = origin.requests.length;
      connection.send(`GET /odd HTTP/1.1\r\nHost: chatgpt.com\r\nx-lower-case: l\r\n${odd}\r\n\r\n`);
      const reply = await connection.response();
      connection.close();
      const received = origin.requests.slice(before).map((item) => item.headerLines.filter((line) => !/^(host|user-agent):/i.test(line)));
      expect([reply.status, received], JSON.stringify(odd)).toEqual([status, forwarded === undefined ? [] : [forwarded]]);
    }
  });

  it("keep their order and case on a WebSocket upgrade request", async () => {
    const accept = (request: RawMessage): string => createHash("sha1").update(`${request.headers.find(([name]) => name.toLowerCase() === "sec-websocket-key")?.[1] ?? ""}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    const origin = await startWireOrigin(undefined, (request) => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept(request)}\r\n\r\n`);
    const agent = await guard(origin, undefined);
    const connection = await through(agent);
    const lines = ["Host: chatgpt.com", "x-lower-case: l", "Upgrade: websocket", "Connection: Upgrade", "sec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version: 13"];
    connection.send(`GET /socket HTTP/1.1\r\n${lines.join("\r\n")}\r\n\r\n`);
    expect((await connection.response()).status).toBe(101);
    connection.close();
    expect(origin.requests.map((item) => item.headerLines)).toEqual([lines]);
  });

  it("carry one Content-Length for a repeated identical length, and none for a chunked body", async () => {
    const origin = await startWireOrigin(undefined);
    const agent = await guard(origin, undefined);
    const connection = await through(agent);
    connection.send("POST /length HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/octet-stream\r\nContent-Length: 5\r\nContent-Length: 5\r\n\r\nhello");
    expect((await connection.response()).status).toBe(200);
    connection.send("POST /chunked HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n");
    expect((await connection.response()).status).toBe(200);
    connection.close();
    const [length, chunked] = origin.requests;
    expect([length?.headerLines.filter((line) => /^content-length:/i.test(line)), length?.body.toString()]).toEqual([["Content-Length: 5"], "hello"]);
    expect([chunked?.headerLines.filter((line) => /^(content-length|transfer-encoding):/i.test(line)), chunked?.body.toString()]).toEqual([["Transfer-Encoding: chunked"], "hello"]);
  });
});

describe("the HTTP/1.1 exchange with the origin", () => {
  it("skips the origin's informational responses and keeps the connection for the next request", async () => {
    const origin = await startWireOrigin(undefined, () => `HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\nLink: </x>\r\n\r\n${OK}`);
    const agent = await guard(origin, undefined);
    const connection = await through(agent);
    for (let index = 0; index < 2; index += 1) {
      connection.send("GET / HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n");
      const reply = await connection.response();
      expect([reply.status, reply.body.toString()], `request ${index}`).toEqual([200, "ok"]);
    }
    connection.close();
    expect([origin.requests.length, origin.opened()]).toEqual([2, 1]);
  });

  it("closes the origin connection when the client leaves before or during the response, and ends a response the origin cut short", async () => {
    for (const mode of ["before headers", "during the body"] as const) {
      const origin = await startWireOrigin(undefined, () => (mode === "before headers" ? undefined : "HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npart"));
      const agent = await guard(origin, undefined);
      const socket = await tlsThroughConnect(agent, "chatgpt.com");
      const connection = rawHttp(socket);
      let received = "";
      socket.on("data", (chunk: Buffer) => {
        received += chunk.toString("latin1");
      });
      connection.send("GET /slow HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n");
      await waitUntil("the origin to receive the request", async () => (origin.requests.length === 1 ? true : undefined), 5_000);
      if (mode === "during the body") await waitUntil("the client to receive the response head and part of the body", async () => (received.startsWith("HTTP/1.1 200 ") && received.endsWith("\r\n\r\npart") ? true : undefined), 5_000);
      connection.close();
      await waitUntil(`the origin connection to close (${mode})`, async () => (origin.closed() === 1 ? true : undefined), 5_000);
    }
    const cut = await startWireOrigin(undefined, (_request, socket) => {
      socket.end("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial");
      return undefined;
    });
    const agent = await guard(cut, undefined);
    const connection = await through(agent);
    connection.send("GET /cut HTTP/1.1\r\nHost: chatgpt.com\r\n\r\n");
    await expect(connection.response(5_000)).rejects.toThrow(/closed/);
  });
});

describe("pipelined requests after a chunked body", () => {
  it("keep their own raw header bytes when the chunked body ends cleanly", async () => {
    const origin = await startWireOrigin(undefined);
    const agent = await guard(origin, undefined);
    const connection = await through(agent);
    connection.send("POST /one HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\n\r\nGET /two HTTP/1.1\r\nHost: chatgpt.com\r\nx-lower-case: l\r\n\r\n");
    expect((await connection.response()).status).toBe(200);
    expect((await connection.response()).status).toBe(200);
    connection.close();
    expect(origin.requests.map((item) => [item.startLine, item.headerLines])).toEqual([
      ["POST /one HTTP/1.1", ["Host: chatgpt.com", "Content-Type: application/octet-stream", "Transfer-Encoding: chunked"]],
      ["GET /two HTTP/1.1", ["Host: chatgpt.com", "x-lower-case: l"]],
    ]);
  });

  it("fall back to the parsed form after a body that ends with trailers, so trailer bytes never become headers", async () => {
    const origin = await startWireOrigin(undefined);
    const agent = await guard(origin, undefined);
    const connection = await through(agent);
    connection.send("POST / HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Note: a\r\n\r\nGET /next HTTP/1.1\r\nHost: chatgpt.com\r\nx-lower-case: l\r\n\r\n");
    expect((await connection.response()).status).toBe(200);
    expect((await connection.response()).status).toBe(200);
    connection.close();
    const next = origin.requests[1];
    expect(next?.startLine).toBe("GET /next HTTP/1.1");
    expect(next?.headerLines).toContain("X-Lower-Case: l");
    expect(next?.headerLines.join("\n")).not.toContain("X-Note");
  });
});

describe("an empty chunked request body", () => {
  for (const [scheme, contentType, framing] of [
    ["http", "application/json", "Content-Length: 0"],
    ["http", "application/octet-stream", "Transfer-Encoding: chunked"],
    ["https", "application/json", "Content-Length: 0"],
  ] as const) {
    it(`reaches a ${scheme} origin as a complete empty request at once (${contentType})`, async () => {
      const cert = scheme === "https" ? await certificate() : undefined;
      const origin = await startWireOrigin(cert);
      const agent = await guard(origin, cert);
      const connection = await through(agent);
      const started = Date.now();
      connection.send(`POST /backend-api/conversation HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: ${contentType}\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n`);
      const reply = await connection.response(5_000);
      connection.close();
      expect([reply.status, Date.now() - started < 1_000]).toEqual([200, true]);
      const [received] = origin.requests;
      expect(received?.body.length).toBe(0);
      expect(received?.headerLines.filter((line) => /^(content-length|transfer-encoding):/i.test(line))).toEqual([framing]);
    });
  }

  it("keeps the trailers it declared", async () => {
    const trailers: (string | undefined)[] = [];
    const origin = http.createServer((request, response) => {
      request.resume();
      request.once("end", () => {
        trailers.push(request.trailers["x-checksum"]);
        response.end("ok");
      });
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    suite.cleanup.defer(async () => {
      origin.closeAllConnections();
      origin.close();
    });
    const address = origin.address();
    if (address === null || typeof address === "string") throw new Error("the origin has no port");
    const profile = await policyProfile(suite, { catalogue: CHAT });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": `http://127.0.0.1:${address.port}` } });
    const connection = await through(agent);
    connection.send("POST /backend-api/conversation HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/json\r\nTrailer: X-Checksum\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Checksum: abc\r\n\r\n");
    expect((await connection.response()).status).toBe(200);
    connection.close();
    expect(trailers).toEqual(["abc"]);
  });
});

describe("request trailers", () => {
  it("never let a late trailer change the Content-Type or encoding the agent inspected", async () => {
    const seen: { type: string | undefined; body: string; trailers: NodeJS.Dict<string> }[] = [];
    const origin = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.once("end", () => {
        seen.push({ type: request.headers["content-type"], body: Buffer.concat(chunks).toString(), trailers: { ...request.trailers } });
        response.end("ok");
      });
    });
    origin.listen(0, "127.0.0.1");
    await once(origin, "listening");
    suite.cleanup.defer(async () => {
      origin.closeAllConnections();
      origin.close();
    });
    const address = origin.address();
    if (address === null || typeof address === "string") throw new Error("the origin has no port");
    const profile = await policyProfile(suite, { catalogue: CHAT });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": `http://127.0.0.1:${address.port}` } });
    const connection = await through(agent);
    connection.send("POST /upload HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/octet-stream\r\nTrailer: Content-Type, Content-Encoding, X-Checksum\r\nTransfer-Encoding: chunked\r\n\r\n7\r\npayload\r\n0\r\nContent-Type: application/json\r\nContent-Encoding: gzip\r\nX-Checksum: complete\r\n\r\n");
    const reply = await connection.response();
    connection.close();
    expect([reply.status, reply.body.toString()]).toEqual([200, "ok"]);
    expect(seen).toEqual([{ type: "application/octet-stream", body: "payload", trailers: { "x-checksum": "complete" } }]);
  });
});
