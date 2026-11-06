import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign as signBytes, type KeyObject } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import http2 from "node:http2";
import net from "node:net";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { afterAll, beforeAll } from "vitest";
import { buildAgent, launchAgent, type RunningAgent } from "../../support/agent.ts";
import { createCleanup, type Cleanup } from "../../support/cleanup.ts";
import { isRecord } from "../../support/guards.ts";
import { bundleDocument, createProfile, createSigner, freePort, jsonLines, waitUntil, type AgentProfile, type Json, type PolicySigner } from "./harness.ts";

export interface Suite {
  readonly cleanup: Cleanup;
  binary(): string;
}

export const useAgentSuite = (): Suite => {
  const cleanup = createCleanup();
  let binary: string | undefined;
  beforeAll(async () => {
    const built = await buildAgent();
    cleanup.defer(built.close);
    binary = built.path;
  });
  afterAll(() => cleanup.run());
  return {
    cleanup,
    binary: () => {
      if (binary === undefined) throw new Error("the agent binary is not built yet");
      return binary;
    },
  };
};

export interface PolicyProfileOptions {
  readonly bundle?: Json;
  readonly catalogue?: Json;
  readonly serverUrl?: string;
  readonly signer?: PolicySigner;
}

export const policyProfile = async (suite: Suite, options: PolicyProfileOptions = {}): Promise<AgentProfile> => {
  const signer = options.signer ?? createSigner();
  return createProfile(suite.cleanup, {
    signer,
    ...(options.serverUrl === undefined ? {} : { serverUrl: options.serverUrl }),
    bundle: bundleDocument(signer, options.bundle ?? {}),
    ...(options.catalogue === undefined ? {} : { catalogue: options.catalogue }),
  });
};

export interface StartOptions {
  readonly upstreamMap?: Readonly<Record<string, string>>;
  readonly transparent?: boolean;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface Running extends RunningAgent {
  readonly transparentPort: number;
}

export const startRunning = async (suite: Suite, profile: AgentProfile, options: StartOptions = {}): Promise<Running> => {
  const transparentPort = options.transparent === true ? await freePort() : 0;
  const agent = await launchAgent({
    binary: suite.binary(),
    dataDir: profile.dataDir,
    upstreamMap: options.upstreamMap,
    ...(options.env === undefined ? {} : { env: options.env }),
    args: [...(options.transparent === true ? ["--transparent", `127.0.0.1:${transparentPort}`] : []), ...(options.args ?? [])],
  });
  suite.cleanup.defer(agent.close);
  await waitUntil("the agent to load its signed policy", async () => ((await agent.status()).bundleVersion === undefined ? undefined : true));
  return { ...agent, transparentPort };
};

export interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
  readonly text: string;
  json(): Json;
}

const reply = (status: number, headers: IncomingHttpHeaders, body: Buffer): Reply => ({
  status,
  headers,
  body,
  text: body.toString("utf8"),
  json: () => {
    const value: unknown = JSON.parse(body.toString("utf8"));
    if (!isRecord(value)) throw new Error(`expected a JSON object, got ${body.toString("utf8").slice(0, 200)}`);
    return value;
  },
});

export interface ProxyRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string | readonly string[]>>;
  readonly body?: Buffer | string;
}

export const viaProxy = async (agent: { readonly proxyPort: number }, request: ProxyRequest): Promise<Reply> => {
  const target = new URL(request.url);
  const body = request.body === undefined ? undefined : Buffer.from(request.body);
  const done = Promise.withResolvers<Reply>();
  const outgoing = http.request({
    host: "127.0.0.1",
    port: agent.proxyPort,
    method: request.method,
    path: request.url,
    agent: false,
    headers: { host: target.host, connection: "keep-alive", ...request.headers, ...(body === undefined ? {} : { "content-length": String(body.length) }) },
  });
  outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${request.method} ${request.url} through the agent timed out`)));
  outgoing.on("error", done.reject);
  outgoing.once("response", (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", done.reject);
    incoming.once("end", () => done.resolve(reply(incoming.statusCode ?? 0, incoming.headers, Buffer.concat(chunks))));
  });
  outgoing.end(body);
  return done.promise;
};

export const viaProxyClosing = (agent: { readonly proxyPort: number }, request: ProxyRequest): Promise<Reply> =>
  viaProxy(agent, { ...request, headers: { ...request.headers, connection: "close" } });

export const viaTunnel = async (agent: { readonly proxyPort: number; readonly caPem: string }, request: ProxyRequest): Promise<Reply> => {
  const target = new URL(request.url);
  const socket = await tlsThroughConnect(agent, target.hostname, Number(target.port === "" ? 443 : target.port));
  try {
    return await requestOnSocket(socket, target, request);
  } finally {
    socket.destroy();
  }
};

export const requestOnSocket = async (socket: net.Socket, target: URL, request: ProxyRequest): Promise<Reply> => {
  const body = request.body === undefined ? undefined : Buffer.from(request.body);
  const done = Promise.withResolvers<Reply>();
  const outgoing = http.request({
    method: request.method,
    path: `${target.pathname}${target.search}`,
    headers: { host: target.host, ...request.headers, ...(body === undefined ? {} : { "content-length": String(body.length) }) },
    createConnection: () => socket,
  });
  outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${request.method} ${request.url} timed out`)));
  outgoing.on("error", done.reject);
  outgoing.once("response", (incoming) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("error", done.reject);
    incoming.once("end", () => done.resolve(reply(incoming.statusCode ?? 0, incoming.headers, Buffer.concat(chunks))));
  });
  outgoing.end(body);
  return done.promise;
};

export const openTunnel = (proxyPort: number, authority: string): Promise<net.Socket> => {
  const tunnel = Promise.withResolvers<net.Socket>();
  const connect = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority, headers: { host: authority }, agent: false });
  connect.setTimeout(30_000, () => connect.destroy(new Error(`CONNECT ${authority} timed out`)));
  connect.once("connect", (response, socket) => {
    if (response.statusCode === 200) {
      tunnel.resolve(socket);
      return;
    }
    socket.destroy();
    tunnel.reject(new Error(`CONNECT ${authority} answered ${response.statusCode ?? "nothing"}`));
  });
  connect.on("error", tunnel.reject);
  connect.end();
  return tunnel.promise;
};

export type TlsOptions = Omit<tls.ConnectionOptions, "socket" | "servername">;

export const tlsOn = async (socket: net.Socket, servername: string, options: TlsOptions): Promise<TLSSocket> => {
  const secure = tls.connect({ ALPNProtocols: ["http/1.1"], ...options, socket, servername });
  const ready = Promise.withResolvers<TLSSocket>();
  secure.once("secureConnect", () => ready.resolve(secure));
  secure.once("error", (error) => {
    secure.destroy();
    ready.reject(error);
  });
  return ready.promise;
};

export const tlsThroughConnect = async (agent: { readonly proxyPort: number; readonly caPem: string }, host: string, port = 443, options: TlsOptions = {}): Promise<TLSSocket> =>
  tlsOn(await openTunnel(agent.proxyPort, `${host}:${port}`), host, { ca: agent.caPem, ...options });

export const local = async (agent: { readonly localUrl: string }, localPath: string, init?: RequestInit): Promise<{ status: number; headers: Headers; text: string; json(): Json }> => {
  const response = await fetch(`${agent.localUrl}${localPath}`, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: () => {
      const value: unknown = JSON.parse(text);
      if (!isRecord(value)) throw new Error(`expected a JSON object from ${localPath}, got ${text.slice(0, 200)}`);
      return value;
    },
  };
};

export const activityRows = async (agent: { readonly localUrl: string }): Promise<Json[]> => {
  const events = (await local(agent, "/activity")).json().events;
  if (!Array.isArray(events) || !events.every(isRecord)) throw new Error("the agent activity is not a list of objects");
  return events;
};

export const tlsRows = async (agent: { readonly localUrl: string }): Promise<Json[]> => {
  const entries = (await local(agent, "/diagnostics/tls")).json().entries;
  if (!Array.isArray(entries) || !entries.every(isRecord)) throw new Error("the TLS diagnostics are not a list of objects");
  return entries;
};

export const queuedEvents = async (dataDir: string): Promise<Json[]> => {
  try {
    return jsonLines(await readFile(path.join(dataDir, "events.jsonl"), "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
};

export const record = (value: unknown): Json => {
  if (!isRecord(value)) throw new Error(`expected an object, got ${JSON.stringify(value)?.slice(0, 200)}`);
  return value;
};

export interface DecisionStream {
  readonly messages: { readonly name: string; readonly data: Json }[];
  next(name: string, timeoutMs?: number): Promise<Json>;
  close(): void;
}

export const decisions = async (agent: { readonly localUrl: string }): Promise<DecisionStream> => {
  const controller = new AbortController();
  const response = await fetch(`${agent.localUrl}/events`, { signal: controller.signal });
  if (response.body === null) throw new Error("the agent event stream has no body");
  const messages: { name: string; data: Json }[] = [];
  let read = 0;
  let buffer = "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  void (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) return;
        buffer += decoder.decode(chunk.value, { stream: true });
        for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (name !== undefined && data !== undefined) messages.push({ name, data: record(JSON.parse(data)) });
        }
      }
    } catch {
      return;
    }
  })();
  return {
    messages,
    next: async (name, timeoutMs = 5_000) =>
      waitUntil(
        `a ${name} message on the agent event stream`,
        async () => {
          while (read < messages.length) {
            const message = messages[read];
            read += 1;
            if (message?.name === name) return message.data;
          }
          return undefined;
        },
        timeoutMs,
      ),
    close: () => controller.abort(),
  };
};

export interface RelaySigner {
  readonly keyId: string;
  readonly pin: Json;
  line(proxyLine: string, identity?: Partial<RelayIdentity>): { line: Buffer; identity: RelayIdentity };
  signLine(proxyLine: string, identity: RelayIdentity): Buffer;
}

export interface RelayIdentity {
  readonly version: number;
  readonly keyId: string;
  readonly issuedAt: number;
  readonly nonce: string;
  readonly signingId: string;
  readonly teamId: string;
  readonly steeringHost?: string;
}

export const RELAY_PROXY_LINE = "PROXY TCP4 127.0.0.1 192.0.2.1 12345 443\r\n";

export const createRelaySigner = (): RelaySigner => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  if (typeof jwk.x !== "string" || typeof jwk.y !== "string") throw new Error("the relay key has no coordinates");
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
  const keyId = createHash("sha256").update(raw).digest("hex");
  const key: KeyObject = createPrivateKey(privateKey.export({ format: "pem", type: "pkcs8" }));
  const signLine = (proxyLine: string, identity: RelayIdentity): Buffer => {
    const payload = Buffer.from(JSON.stringify({ version: identity.version, keyId: identity.keyId, issuedAt: identity.issuedAt, nonce: identity.nonce, signingId: identity.signingId, teamId: identity.teamId, ...(identity.steeringHost === undefined ? {} : { steeringHost: identity.steeringHost }) }));
    const signature = signBytes("sha256", Buffer.concat([Buffer.from("VIBTRA_APP_V1\n"), Buffer.from(proxyLine), payload]), { key, dsaEncoding: "ieee-p1363" });
    return Buffer.from(`VIBTRA_APP_V1 ${payload.toString("base64url")} ${signature.toString("base64url")}\r\n`);
  };
  return {
    keyId,
    pin: { version: 1, keyId, publicKey: raw.toString("base64url") },
    signLine,
    line: (proxyLine, changes = {}) => {
      const identity: RelayIdentity = {
        version: 1,
        keyId,
        issuedAt: Math.floor(Date.now() / 1000),
        nonce: randomBytes(16).toString("base64url"),
        signingId: "com.example.SyntheticApp",
        teamId: "TESTTEAM01",
        ...changes,
      };
      return { line: signLine(proxyLine, identity), identity };
    },
  };
};

export const writeRelayPin = (profile: AgentProfile, signer: RelaySigner): Promise<void> =>
  writeFile(path.join(profile.dataDir, "relay-attribution.json"), JSON.stringify(signer.pin), { mode: 0o600 });

export interface RelayConnection {
  readonly proxyLine?: string;
  readonly attribution?: Buffer;
  readonly servername: string;
  readonly ca?: string;
  readonly tls?: TlsOptions;
}

export const relayConnect = async (agent: { readonly transparentPort: number; readonly caPem: string }, connection: RelayConnection): Promise<TLSSocket> => {
  const socket = net.connect(agent.transparentPort, "127.0.0.1");
  await once(socket, "connect");
  socket.write(Buffer.concat([Buffer.from(connection.proxyLine ?? RELAY_PROXY_LINE), connection.attribution ?? Buffer.alloc(0)]));
  return tlsOn(socket, connection.servername, { ca: connection.ca ?? agent.caPem, ...connection.tls });
};

export const relayRequest = async (agent: { readonly transparentPort: number; readonly caPem: string }, connection: RelayConnection, request: ProxyRequest): Promise<Reply> => {
  const socket = await relayConnect(agent, connection);
  try {
    return await requestOnSocket(socket, new URL(request.url), request);
  } finally {
    socket.destroy();
  }
};

export const rawExchange = async (port: number, bytes: Buffer, options: { end?: boolean; until?: (received: Buffer) => boolean; timeoutMs?: number } = {}): Promise<Buffer> => {
  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  const chunks: Buffer[] = [];
  const done = Promise.withResolvers<Buffer>();
  const timer = setTimeout(() => done.resolve(Buffer.concat(chunks)), options.timeoutMs ?? 5_000);
  socket.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    if (options.until?.(Buffer.concat(chunks)) === true) done.resolve(Buffer.concat(chunks));
  });
  socket.on("close", () => done.resolve(Buffer.concat(chunks)));
  socket.on("error", () => done.resolve(Buffer.concat(chunks)));
  if (options.end === true) socket.end(bytes);
  else socket.write(bytes);
  try {
    return await done.promise;
  } finally {
    clearTimeout(timer);
    socket.destroy();
  }
};

export interface H2Request {
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer | string;
  readonly trailers?: Readonly<Record<string, string>>;
}

export interface H2Reply {
  readonly status: number;
  readonly headers: http2.IncomingHttpHeaders;
  readonly trailers: http2.IncomingHttpHeaders;
  readonly text: string;
}

export interface H2Client {
  request(request: H2Request): Promise<H2Reply>;
  close(): void;
}

export const h2Client = (socket: TLSSocket, authority = "chatgpt.com"): H2Client => {
  const session = http2.connect(`https://${authority}`, { createConnection: () => socket });
  session.on("error", () => undefined);
  return {
    request: (request) => {
      const done = Promise.withResolvers<H2Reply>();
      const trailers = request.trailers;
      const stream = session.request({ ":method": request.method, ":path": request.path, ...request.headers, ...(trailers === undefined ? {} : { trailer: Object.keys(trailers).join(", ") }) }, { endStream: request.body === undefined && trailers === undefined, waitForTrailers: trailers !== undefined });
      if (trailers !== undefined) stream.once("wantTrailers", () => stream.sendTrailers({ ...trailers }));
      let headers: http2.IncomingHttpHeaders = {};
      let received: http2.IncomingHttpHeaders = {};
      const chunks: Buffer[] = [];
      stream.once("response", (value) => {
        headers = value;
      });
      stream.once("trailers", (value) => {
        received = value;
      });
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.once("end", () => done.resolve({ status: Number(headers[":status"]), headers, trailers: received, text: Buffer.concat(chunks).toString("utf8") }));
      stream.once("error", done.reject);
      if (request.body !== undefined || trailers !== undefined) stream.end(request.body);
      return done.promise;
    },
    close: () => {
      session.close();
      socket.destroy();
    },
  };
};

export interface RawMessage {
  readonly startLine: string;
  readonly status: number;
  readonly headerLines: readonly string[];
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Buffer;
  readonly trailerLines: readonly string[];
  readonly informational: readonly number[];
}

export interface RawHttp {
  send(bytes: Buffer | string): void;
  response(timeoutMs?: number): Promise<RawMessage>;
  request(timeoutMs?: number): Promise<RawMessage>;
  readonly closed: Promise<void>;
  close(): void;
}

const headerValue = (headers: readonly (readonly [string, string])[], name: string): string | undefined => headers.find(([key]) => key.toLowerCase() === name)?.[1];

export const rawHttp = (socket: net.Socket): RawHttp => {
  let buffer = Buffer.alloc(0);
  let ended = false;
  let wake: (() => void) | undefined;
  const closed = Promise.withResolvers<void>();
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    wake?.();
  });
  socket.on("close", () => {
    ended = true;
    closed.resolve();
    wake?.();
  });
  socket.on("error", () => undefined);
  const more = async (deadline: number): Promise<void> => {
    if (ended) throw new Error(`the connection closed with ${buffer.length} unread bytes`);
    const signal = Promise.withResolvers<void>();
    wake = signal.resolve;
    const timer = setTimeout(signal.resolve, Math.max(0, deadline - Date.now()));
    await signal.promise;
    clearTimeout(timer);
    wake = undefined;
    if (Date.now() >= deadline) throw new Error("timed out waiting for an HTTP message");
  };
  const until = async (deadline: number, find: () => number): Promise<number> => {
    let found = find();
    while (found < 0) {
      await more(deadline);
      found = find();
    }
    return found;
  };
  const message = async (kind: "request" | "response", timeoutMs: number): Promise<RawMessage> => {
    const deadline = Date.now() + timeoutMs;
    const informational: number[] = [];
    for (;;) {
      const end = await until(deadline, () => buffer.indexOf("\r\n\r\n"));
      const [startLine = "", ...headerLines] = buffer.subarray(0, end).toString("latin1").split("\r\n");
      const status = kind === "response" ? Number(startLine.split(" ")[1]) : 0;
      const headers = headerLines.map((line): [string, string] => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]);
      const start = end + 4;
      const base = { startLine, status, headerLines, headers, informational };
      if (kind === "response" && status >= 100 && status < 200 && status !== 101) {
        informational.push(status);
        buffer = buffer.subarray(start);
        continue;
      }
      const length = headerValue(headers, "content-length");
      if (headerValue(headers, "transfer-encoding")?.toLowerCase() === "chunked") {
        const chunks: Buffer[] = [];
        let at = start;
        for (;;) {
          const lineEnd = await until(deadline, () => buffer.indexOf("\r\n", at));
          const size = parseInt(buffer.subarray(at, lineEnd).toString("latin1"), 16);
          if (size === 0) {
            const close = await until(deadline, () => (buffer.subarray(lineEnd, lineEnd + 4).toString("latin1") === "\r\n\r\n" ? lineEnd : buffer.indexOf("\r\n\r\n", lineEnd)));
            const trailerLines = close === lineEnd ? [] : buffer.subarray(lineEnd + 2, close).toString("latin1").split("\r\n");
            buffer = buffer.subarray(close + 4);
            return { ...base, body: Buffer.concat(chunks), trailerLines };
          }
          await until(deadline, () => (buffer.length >= lineEnd + 2 + size + 2 ? 0 : -1));
          chunks.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
          at = lineEnd + 2 + size + 2;
        }
      }
      if (length !== undefined || kind === "request" || status === 101) {
        const size = Number(length ?? 0);
        await until(deadline, () => (buffer.length >= start + size ? 0 : -1));
        const body = buffer.subarray(start, start + size);
        buffer = buffer.subarray(start + size);
        return { ...base, body, trailerLines: [] };
      }
      for (;;) {
        try {
          await more(deadline);
        } catch {
          break;
        }
      }
      const body = buffer.subarray(start);
      buffer = Buffer.alloc(0);
      return { ...base, body, trailerLines: [] };
    }
  };
  return {
    send: (bytes) => {
      socket.write(bytes);
    },
    response: (timeoutMs = 10_000) => message("response", timeoutMs),
    request: (timeoutMs = 10_000) => message("request", timeoutMs),
    closed: closed.promise,
    close: () => socket.destroy(),
  };
};
