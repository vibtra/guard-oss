import { execFile, spawn } from "node:child_process";
import { createPrivateKey, randomBytes, sign as signBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http, { type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { GUARD_CATALOGUE_SEED_VERSION, GUARD_SIGNATURE_TYP, seedCatalogue } from "@vibtra/guard-contract";
import { digestOf, generateGuardSigningKey, mintGuardId, type GuardSigningKeyPair } from "@vibtra/guard-contract/signing";
import type { ReceivedRequest } from "../../fakes/upstream.ts";
import { agentRaceEnv, caSignerEnv } from "../../support/agent.ts";
import type { Cleanup } from "../../support/cleanup.ts";
import { isRecord } from "../../support/guards.ts";

export type Json = Record<string, unknown>;

export const UNREACHABLE_REGISTRY = "http://127.0.0.1:9";

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandOptions {
  readonly dataDir: string;
  readonly input?: string | Buffer;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export const runAgentCommand = async (binary: string, args: readonly string[], options: CommandOptions): Promise<CommandResult> => {
  const coverDir = process.env.GUARD_AGENT_COVERDIR;
  const signerEnv = await caSignerEnv(binary, options.dataDir);
  const child = spawn(binary, args, {
    env: {
      ...process.env,
      ...agentRaceEnv(),
      ...signerEnv,
      VIBTRA_GUARD_DIR: options.dataDir,
      ...(coverDir === undefined || coverDir === "" ? {} : { GOCOVERDIR: path.resolve(coverDir) }),
      ...options.env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.input);
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 60_000);
  try {
    const [code]: unknown[] = await once(child, "close");
    return { code: typeof code === "number" ? code : null, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
};

export const jsonLines = (text: string): Json[] =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) throw new Error(`expected a JSON object per line, got: ${line.slice(0, 200)}`);
      return value;
    });

export const jsonObject = (text: string): Json => {
  const value: unknown = JSON.parse(text);
  if (!isRecord(value)) throw new Error(`expected a JSON object, got: ${text.slice(0, 200)}`);
  return value;
};

export const tempDir = async (cleanup: Cleanup, name: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), `guard-agent-go-${name}-`));
  cleanup.defer(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

export interface TestCertificate {
  readonly cert: string;
  readonly key: string;
  readonly certPath: string;
}

export const selfSignedCertificate = async (cleanup: Cleanup, subjectAltName: string): Promise<TestCertificate> => {
  const dir = await tempDir(cleanup, "certificate");
  const certPath = path.join(dir, "cert.pem");
  const keyPath = path.join(dir, "key.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-subj", "/CN=guard-test.example", "-addext", `subjectAltName=${subjectAltName}`, "-days", "1", "-keyout", keyPath, "-out", certPath]);
  return { cert: await readFile(certPath, "utf8"), key: await readFile(keyPath, "utf8"), certPath };
};

export const varint = (value: bigint | number): Buffer => {
  let rest = BigInt(value);
  const bytes: number[] = [];
  while (rest >= 0x80n) {
    bytes.push(Number(rest & 0x7fn) | 0x80);
    rest >>= 7n;
  }
  bytes.push(Number(rest));
  return Buffer.from(bytes);
};

export const protoField = (field: number, value: Buffer | string): Buffer => {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint((BigInt(field) << 3n) | 2n), varint(bytes.length), bytes]);
};

export const protoNumber = (field: number, value: bigint | number): Buffer => Buffer.concat([varint(BigInt(field) << 3n), varint(value)]);

export const connectFrame = (flags: number, payload: Buffer): Buffer => {
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
};

export type ContentCoding = "gzip" | "deflate" | "br" | "zstd";

export const encodeBody = (coding: ContentCoding, body: Buffer): Buffer => {
  switch (coding) {
    case "gzip":
      return zlib.gzipSync(body);
    case "deflate":
      return zlib.deflateSync(body);
    case "br":
      return zlib.brotliCompressSync(body);
    case "zstd":
      return zlib.zstdCompressSync(body);
  }
};

export interface WebSocketFrameOptions {
  readonly fin?: boolean;
  readonly compressed?: boolean;
  readonly masked?: boolean;
}

export const webSocketFrame = (opcode: number, payload: Buffer | string, options: WebSocketFrameOptions = {}): Buffer => {
  const body = Buffer.from(payload);
  const masked = options.masked ?? true;
  const first = opcode | (options.fin === false ? 0 : 0x80) | (options.compressed === true ? 0x40 : 0);
  const maskBit = masked ? 0x80 : 0;
  let header: Buffer;
  if (body.length < 126) {
    header = Buffer.from([first, maskBit | body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header.writeUInt8(first, 0);
    header.writeUInt8(maskBit | 126, 1);
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header.writeUInt8(first, 0);
    header.writeUInt8(maskBit | 127, 1);
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  if (!masked) return Buffer.concat([header, body]);
  const mask = Buffer.from([0x23, 0x91, 0x05, 0xf2]);
  return Buffer.concat([header, mask, Buffer.from(body.map((byte, index) => byte ^ (mask[index % 4] ?? 0)))]);
};

const SYNC_TAIL = Buffer.from([0, 0, 0xff, 0xff]);

export const webSocketDeflate = async (messages: readonly (Buffer | string)[]): Promise<Buffer[]> => {
  const stream = zlib.createDeflateRaw({ level: zlib.constants.Z_BEST_COMPRESSION });
  const chunks: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk));
  const out: Buffer[] = [];
  for (const message of messages) {
    stream.write(Buffer.from(message));
    await new Promise<void>((resolve) => stream.flush(zlib.constants.Z_SYNC_FLUSH, () => resolve()));
    const wire = Buffer.concat(chunks.splice(0));
    if (!wire.subarray(-4).equals(SYNC_TAIL)) throw new Error("the deflate output has no sync flush tail");
    out.push(wire.subarray(0, -4));
  }
  stream.destroy();
  return out;
};

export const waitUntil = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 30_000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await delay(100);
  }
};

export interface PolicySigner extends GuardSigningKeyPair {
  readonly orgId: string;
  readonly deviceId: string;
}

export const createSigner = (): PolicySigner => ({ ...generateGuardSigningKey(), orgId: `org_${randomBytes(6).toString("hex")}`, deviceId: mintGuardId("gdev") });

export type SignedKind = "bundle" | "catalogue";

export interface EnvelopeClaims {
  readonly keyId?: string;
  readonly orgId?: string;
  readonly deviceId?: string;
  readonly version?: unknown;
}

export const signEnvelope = (signer: PolicySigner, kind: SignedKind, document: Json, claims: EnvelopeClaims = {}): Json => {
  const keyId = claims.keyId ?? signer.keyId;
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: GUARD_SIGNATURE_TYP, kid: keyId });
  const payload = encode({
    kind,
    keyId,
    iat: Math.floor(Date.now() / 1000),
    orgId: claims.orgId ?? signer.orgId,
    ...(kind === "bundle" ? { deviceId: claims.deviceId ?? signer.deviceId } : {}),
    version: claims.version ?? (kind === "bundle" ? document.bundleVersion : document.version),
    digest: digestOf(document),
  });
  const signature = signBytes("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(signer.privateKeyPem), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { [kind]: document, signature: { alg: "ES256", keyId, jws: `${header}.${payload}.${signature}` } };
};

export const bundleDocument = (signer: PolicySigner, changes: Json = {}): Json => ({
  protocol: 1,
  orgId: signer.orgId,
  deviceId: signer.deviceId,
  bundleVersion: 1,
  catalogueVersion: GUARD_CATALOGUE_SEED_VERSION,
  generatedAt: "2026-10-24T00:00:00.000Z",
  person: { userId: "user_agent_go_tests", email: "person@example.test" },
  clientMode: "enforce",
  defaultAction: "allow",
  services: {},
  contentRules: [],
  exceptions: [],
  settings: { requestsEnabled: true, workspaceRedirect: { enabled: false }, snippetPolicy: "redacted", snippetMax: 80 },
  ...changes,
});

export const catalogueDocument = (changes: Json = {}): Json => ({ ...seedCatalogue(), ...changes });

export const contentRule = (ruleId: string, detector: Json, changes: Json = {}): Json => ({
  ruleId,
  name: `Rule ${ruleId}`,
  detector,
  services: "*",
  action: "block",
  ...changes,
});

export const deviceDocument = (signer: PolicySigner, serverUrl: string, changes: Json = {}): Json => ({
  deviceId: signer.deviceId,
  orgId: signer.orgId,
  orgHandle: "example-org",
  orgName: "Example Org",
  person: { userId: "user_agent_go_tests", email: "person@example.test", name: "Test Person" },
  signing: { keyId: signer.keyId, alg: "ES256", publicKeyPem: signer.publicKeyPem },
  server: { baseUrl: serverUrl, syncIntervalSeconds: 60, batchSize: 100 },
  clientMode: "enforce",
  enrolledAt: "2026-10-24T00:00:00.000Z",
  revoked: false,
  ...changes,
});

export interface PolicyFiles {
  readonly bundle?: Json;
  readonly catalogue?: Json;
}

export interface AgentProfile {
  readonly dataDir: string;
  readonly signer: PolicySigner;
  readonly serverUrl: string;
  writeDevice(changes?: Json): Promise<void>;
  writeFile(name: string, content: string | Buffer): Promise<void>;
  writePolicy(policy: PolicyFiles): Promise<void>;
}

export interface ProfileOptions {
  readonly signer?: PolicySigner;
  readonly serverUrl?: string;
  readonly bundle?: Json | null;
  readonly catalogue?: Json | null;
}

export const createProfile = async (cleanup: Cleanup, options: ProfileOptions = {}): Promise<AgentProfile> => {
  const signer = options.signer ?? createSigner();
  const serverUrl = options.serverUrl ?? UNREACHABLE_REGISTRY;
  const dataDir = await tempDir(cleanup, "profile");
  const write = (name: string, content: string | Buffer): Promise<void> => writeFile(path.join(dataDir, name), content, { mode: 0o600 });
  const profile: AgentProfile = {
    dataDir,
    signer,
    serverUrl,
    writeDevice: (changes = {}) => write("device.json", JSON.stringify(deviceDocument(signer, serverUrl, changes))),
    writeFile: write,
    writePolicy: async (policy) => {
      if (policy.bundle !== undefined) await write("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", policy.bundle)));
      if (policy.catalogue !== undefined) await write("catalogue.json", JSON.stringify(signEnvelope(signer, "catalogue", policy.catalogue)));
    },
  };
  await profile.writeDevice();
  await write("device.token", `gdt_${randomBytes(24).toString("hex")}`);
  const bundle = options.bundle === undefined ? bundleDocument(signer) : options.bundle;
  const catalogue = options.catalogue === undefined ? catalogueDocument() : options.catalogue;
  await profile.writePolicy({ ...(bundle === null ? {} : { bundle }), ...(catalogue === null ? {} : { catalogue }) });
  return profile;
};

const listen = async (server: Server | net.Server): Promise<number> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the test server did not listen on a TCP port");
  return address.port;
};

const closeServer = async (server: Server): Promise<void> => {
  if (!server.listening) return;
  const closed = once(server, "close");
  server.closeAllConnections();
  server.close();
  await closed;
};

export const freePort = async (): Promise<number> => {
  const server = net.createServer();
  const port = await listen(server);
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
};

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks);
};

export type OriginHandler = (request: ReceivedRequest, response: ServerResponse) => void;

export interface Origin {
  readonly url: string;
  readonly server: Server;
  readonly received: readonly ReceivedRequest[];
  close(): Promise<void>;
}

const echo: OriginHandler = (request, response) => {
  response.writeHead(200, { "content-type": request.headers["content-type"] ?? "application/octet-stream" });
  response.end(request.body);
};

export const startOrigin = async (cleanup: Cleanup, handler: OriginHandler = echo): Promise<Origin> => {
  const received: ReceivedRequest[] = [];
  const server = http.createServer((request, response) => {
    readBody(request).then(
      (body) => {
        const entry: ReceivedRequest = { method: request.method ?? "", path: request.url ?? "", headers: request.headers, body };
        received.push(entry);
        handler(entry, response);
      },
      () => response.destroy(),
    );
  });
  const port = await listen(server);
  const close = (): Promise<void> => closeServer(server);
  cleanup.defer(close);
  return { url: `http://127.0.0.1:${port}`, server, received, close };
};

export interface RegistryCall {
  readonly method: string;
  readonly door: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

export interface RegistryReply {
  readonly status: number;
  readonly body: unknown;
}

export type RegistryHandler = (call: RegistryCall) => RegistryReply | undefined;

export interface FakeRegistry {
  readonly url: string;
  readonly calls: readonly RegistryCall[];
  serve(download: Json): void;
  override(handler: RegistryHandler | undefined): void;
  close(): Promise<void>;
}

export const startFakeRegistry = async (cleanup: Cleanup, signer: PolicySigner): Promise<FakeRegistry> => {
  const calls: RegistryCall[] = [];
  let download: Json = { bundle: null, catalogue: null };
  let custom: RegistryHandler | undefined;
  let url = "";
  const defaults = (call: RegistryCall): RegistryReply => {
    const body = isRecord(call.body) ? call.body : {};
    switch (call.door) {
      case "enrol":
        return { status: 200, body: { ...deviceDocument(signer, url), deviceToken: `gdt_${randomBytes(24).toString("hex")}` } };
      case "preflight":
        return { status: 200, body: { clientMode: "enforce", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: true, catalogueChanged: true, signingKeyId: signer.keyId } };
      case "ruledownload":
        return { status: 200, body: download };
      case "eventupload":
        return { status: 200, body: { accepted: Array.isArray(body.events) ? body.events.length : 0, rejected: [] } };
      case "postflight":
        return { status: 200, body: { nextSyncInSeconds: 60 } };
      case "requests":
        return call.method === "POST"
          ? { status: 200, body: { request: { requestId: `greq_${randomBytes(8).toString("hex")}`, status: "pending" }, created: true } }
          : { status: 200, body: { requests: [] } };
      default:
        return { status: 404, body: { code: "NOT_FOUND", message: "unknown test registry door" } };
    }
  };
  const server = http.createServer((request, response) => {
    readBody(request).then(
      (raw) => {
        const requestPath = request.url ?? "";
        const door = requestPath.startsWith("/api/guard/v1/") ? (requestPath.slice("/api/guard/v1/".length).split("/")[0] ?? "") : "";
        let body: unknown;
        try {
          body = raw.length === 0 ? undefined : JSON.parse(raw.toString("utf8"));
        } catch {
          body = raw.toString("utf8");
        }
        const call: RegistryCall = { method: request.method ?? "", door, path: requestPath, headers: request.headers, body };
        calls.push(call);
        const reply = custom?.(call) ?? defaults(call);
        response.writeHead(reply.status, { "content-type": "application/json" });
        response.end(JSON.stringify(reply.body));
      },
      () => response.destroy(),
    );
  });
  const port = await listen(server);
  url = `http://127.0.0.1:${port}`;
  const close = (): Promise<void> => closeServer(server);
  cleanup.defer(close);
  return {
    url,
    calls,
    serve: (next) => {
      download = next;
    },
    override: (handler) => {
      custom = handler;
    },
    close,
  };
};
