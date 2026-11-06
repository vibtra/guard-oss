import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUARD_SYNC_DOORS,
  GuardEnrolRequest,
  GuardEnrolResponse,
  GuardEventUploadRequest,
  GuardEventUploadResponse,
  GuardPostflightRequest,
  GuardPostflightResponse,
  GuardPreflightRequest,
  GuardPreflightResponse,
  GuardRuleDownloadRequest,
  GuardRuleDownloadResponse,
  GuardRulesDocument,
  compileGuardBundle,
  defaultGuardSettings,
  seedCatalogue,
} from "@vibtra/guard-contract";
import { digestOf, generateGuardSigningKey, mintDeviceToken, mintEnrolToken, mintGuardId, signGuardBundle, signGuardCatalogue } from "@vibtra/guard-contract/signing";
import { ORG_ID, PERSON, buildGoAgent, policyScan, scratch, type GoAgent, type ProcessResult } from "./support.js";

const key = generateGuardSigningKey();
const catalogue = seedCatalogue();
const deviceId = mintGuardId("gdev");
const deviceToken = mintDeviceToken();
const enrolToken = mintEnrolToken();
const BATCH = 2;
const document = GuardRulesDocument.parse({
  version: 3,
  defaultAction: "allow",
  serviceRules: [{ ruleId: "gsr_00000002", serviceId: "deepseek", audience: { kind: "org" }, action: "block" }],
  contentRules: [{ ruleId: "gcr_00000001", name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", audience: { kind: "org" }, action: "block" }],
});
const bundle = compileGuardBundle({ document, catalogue, person: { ...PERSON, groupIds: [] }, settings: defaultGuardSettings(), grants: [], orgId: ORG_ID, deviceId, now: new Date() });

const queued = [
  {
    eventId: "gev_0123456789abcdef",
    occurredAt: "2026-10-24T00:00:00.000Z",
    kind: "content",
    action: "blocked",
    serviceId: "openai-chatgpt",
    host: "chatgpt.com",
    port: 443,
    method: "POST",
    pathHint: "/backend-api",
    app: { bundleId: "com.google.Chrome", name: "Google Chrome", cli: "claude", pid: 42 },
    ruleId: "gcr_00000001",
    ruleKind: "content",
    matchType: "au-tfn",
    matchCount: 1,
    snippet: "TFN 123***782",
    bytes: 512,
    requestId: "gsr_0123abcd",
    bundleVersion: 3,
  },
  { eventId: "gev_1123456789abcdef", occurredAt: "2026-10-24T00:00:01.000Z", kind: "agent", action: "observed", reason: "started" },
  { eventId: "gev_2123456789abcdef", occurredAt: "2026-10-24T00:00:02.000Z", kind: "flow", action: "observed", serviceId: "anthropic-claude", host: "claude.ai" },
];
const CONTENT = { body: "MADE-UP REQUEST BODY", prompt: "made-up prompt text", url: "https://chatgpt.com/c/1?q=made-up", query: "q=made-up", headers: "cookie: made-up", path: "/c/1?q=made-up", content: "made-up content" };
const APP_PATHS = { path: "/Users/ada/bin/claude", argv: "claude --made-up", cwd: "/Users/ada/project" };

interface Call {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
}

const calls: Call[] = [];
const bodiesAt = (door: string): unknown[] => calls.filter((c) => c.path === door).map((c) => c.body);

const registry = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const call: Call = { method: req.method ?? "", path: req.url ?? "", authorization: req.headers.authorization, body: raw === "" ? undefined : JSON.parse(raw) };
  calls.push(call);
  const answer = (status: number, value: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const refuse = (issues: unknown): void => answer(400, { code: "GUARD_TEST_REFUSED", message: "the body is not the contract's", detail: JSON.stringify(issues) });
  if (call.path === GUARD_SYNC_DOORS.enrol) {
    const parsed = GuardEnrolRequest.safeParse(call.body);
    if (!parsed.success || parsed.data.enrolToken !== enrolToken) return refuse(parsed.error?.issues ?? "unknown enrol token");
    return answer(
      200,
      GuardEnrolResponse.parse({
        deviceId,
        deviceToken,
        orgId: ORG_ID,
        orgHandle: "fernwood",
        orgName: "Fernwood",
        person: PERSON,
        server: { baseUrl: `http://${req.headers.host}`, syncIntervalSeconds: 60, batchSize: BATCH },
        signing: { keyId: key.keyId, alg: "ES256", publicKeyPem: key.publicKeyPem },
        clientMode: "monitor",
      }),
    );
  }
  if (call.authorization !== `Bearer ${deviceToken}`) return answer(401, { code: "GUARD_TOKEN_INVALID", message: "bearer missing or wrong" });
  if (call.path === GUARD_SYNC_DOORS.preflight(deviceId)) {
    const parsed = GuardPreflightRequest.safeParse(call.body);
    if (!parsed.success) return refuse(parsed.error.issues);
    const rulesChanged = parsed.data.requestCleanSync || parsed.data.bundleVersion !== bundle.bundleVersion;
    return answer(
      200,
      GuardPreflightResponse.parse({
        clientMode: "monitor",
        syncIntervalSeconds: 60,
        batchSize: BATCH,
        cleanSync: false,
        bundleVersion: bundle.bundleVersion,
        catalogueVersion: catalogue.version,
        rulesChanged,
        catalogueChanged: parsed.data.catalogueVersion !== catalogue.version,
        signingKeyId: key.keyId,
        person: PERSON,
        serverTime: new Date().toISOString(),
      }),
    );
  }
  if (call.path === GUARD_SYNC_DOORS.ruledownload(deviceId)) {
    const parsed = GuardRuleDownloadRequest.safeParse(call.body);
    if (!parsed.success) return refuse(parsed.error.issues);
    return answer(200, GuardRuleDownloadResponse.parse({ bundle: signGuardBundle(bundle, key), catalogue: signGuardCatalogue(catalogue, ORG_ID, key) }));
  }
  if (call.path === GUARD_SYNC_DOORS.eventupload(deviceId)) {
    const parsed = GuardEventUploadRequest.safeParse(call.body);
    if (!parsed.success) return refuse(parsed.error.issues);
    return answer(200, GuardEventUploadResponse.parse({ accepted: parsed.data.events.length, rejected: [] }));
  }
  if (call.path === GUARD_SYNC_DOORS.postflight(deviceId)) {
    const parsed = GuardPostflightRequest.safeParse(call.body);
    if (!parsed.success) return refuse(parsed.error.issues);
    return answer(200, GuardPostflightResponse.parse({ ok: true, nextSyncInSeconds: 60 }));
  }
  return answer(404, { code: "GUARD_DEVICE_UNKNOWN", message: `no door at ${call.path}` });
});

const files = scratch("sync");
let agent: GoAgent;
let dataDir: string;
let enrolled: ProcessResult;
let synced: ProcessResult;

beforeAll(async () => {
  agent = await buildGoAgent(files.dir());
  registry.listen(0, "127.0.0.1");
  await once(registry, "listening");
  const address = registry.address();
  if (address === null || typeof address === "string") throw new Error("the registry did not bind a TCP port");
  const { port } = address;
  dataDir = files.dir();
  writeFileSync(
    path.join(dataDir, "events.jsonl"),
    queued.map((event, i) => `${JSON.stringify(i === 0 ? { ...event, ...CONTENT, app: { ...event.app, ...APP_PATHS } } : event)}\n`).join(""),
  );
  enrolled = await agent.run(["enrol", "--data-dir", dataDir, "--server", `http://127.0.0.1:${port}`, "--token", enrolToken]);
  synced = await agent.run(["sync", "--data-dir", dataDir]);
});
afterAll(async () => {
  registry.closeAllConnections();
  registry.close();
  await once(registry, "close");
  files.dispose();
});

describe("the Go agent against a registry built from the contract's sync schemas", () => {
  it("walks Santa's doors in order, addressed by its device id, and every exchange succeeds", () => {
    expect(enrolled).toMatchObject({ code: 0, stderr: "" });
    expect(synced).toMatchObject({ code: 0, stderr: "" });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(
      [
        GUARD_SYNC_DOORS.enrol,
        GUARD_SYNC_DOORS.preflight(deviceId),
        GUARD_SYNC_DOORS.ruledownload(deviceId),
        GUARD_SYNC_DOORS.eventupload(deviceId),
        GUARD_SYNC_DOORS.eventupload(deviceId),
        GUARD_SYNC_DOORS.postflight(deviceId),
        GUARD_SYNC_DOORS.preflight(deviceId),
        GUARD_SYNC_DOORS.postflight(deviceId),
      ].map((door) => `POST ${door}`),
    );
  });

  it("enrol carries the CA's facts and never a key; the device token comes back once and is the bearer after", () => {
    const [enrol] = bodiesAt(GUARD_SYNC_DOORS.enrol);
    const parsed = GuardEnrolRequest.parse(enrol);
    expect(parsed.enrolToken).toBe(enrolToken);
    const ca = new X509Certificate(readFileSync(path.join(dataDir, "ca.pem")));
    expect(parsed.ca?.fingerprintSha256).toBe(ca.fingerprint256.replaceAll(":", "").toLowerCase());
    expect(Date.parse(parsed.ca?.notAfter ?? "")).toBe(Date.parse(ca.validTo));
    const secretLines = readFileSync(path.join(dataDir, "ca.key"), "utf8").split("\n").filter((line) => line !== "" && !line.startsWith("-----"));
    const wire = JSON.stringify(calls.map((c) => c.body));
    expect(wire).not.toContain("PRIVATE KEY");
    for (const line of secretLines) expect(wire).not.toContain(line);
    expect(GuardEnrolRequest.safeParse({ ...parsed, ca: { ...parsed.ca, privateKeyPem: "made-up" } }).success).toBe(false);
    expect(GuardEnrolRequest.safeParse({ ...parsed, protocol: 2 }).success).toBe(false);
    expect(calls[0]?.authorization).toBeUndefined();
    expect(calls.slice(1).map((c) => c.authorization)).toEqual(calls.slice(1).map(() => `Bearer ${deviceToken}`));
  });

  it("preflight says what the device holds, and the answer decides whether it downloads", () => {
    const [first, second] = bodiesAt(GUARD_SYNC_DOORS.preflight(deviceId)).map((body) => GuardPreflightRequest.parse(body));
    expect(first).toMatchObject({ protocol: 1, requestCleanSync: true, pendingEvents: queued.length, signingKeyId: key.keyId, clientMode: "monitor" });
    expect(first).not.toHaveProperty("bundleVersion");
    expect(second).toMatchObject({ requestCleanSync: false, bundleVersion: bundle.bundleVersion, catalogueVersion: catalogue.version, pendingEvents: 0 });
    expect(bodiesAt(GUARD_SYNC_DOORS.ruledownload(deviceId))).toHaveLength(1);
    const { requestCleanSync: _sent, ...withoutFlag } = GuardPreflightRequest.parse(bodiesAt(GUARD_SYNC_DOORS.preflight(deviceId))[1]);
    expect(GuardPreflightRequest.parse(withoutFlag).requestCleanSync).toBe(false);
  });

  it("enrol and preflight may leave out the CA facts of an agent that has no CA", () => {
    const { ca: _enrolCa, ...enrol } = GuardEnrolRequest.parse(bodiesAt(GUARD_SYNC_DOORS.enrol)[0]);
    const { ca: _preflightCa, ...preflight } = GuardPreflightRequest.parse(bodiesAt(GUARD_SYNC_DOORS.preflight(deviceId))[0]);
    expect(GuardEnrolRequest.safeParse(enrol).success).toBe(true);
    expect(GuardPreflightRequest.safeParse(preflight).success).toBe(true);
    expect(GuardEnrolRequest.safeParse({ ...enrol, ca: null }).success).toBe(false);
    expect(GuardPreflightRequest.safeParse({ ...preflight, ca: {} }).success).toBe(false);
  });

  it("preflight health may say whether the Mac intercepts, with a reason exactly when it does not", () => {
    const sent = GuardPreflightRequest.parse(bodiesAt(GUARD_SYNC_DOORS.preflight(deviceId))[0]);
    const withInterception = (interception: unknown) => GuardPreflightRequest.safeParse({ ...sent, health: { ...sent.health, interception } });
    expect(withInterception({ on: true }).success).toBe(true);
    for (const reason of ["unsigned-build", "no-secure-enclave", "key-unavailable", "signer-unavailable", "awaiting-trust", "unsupported-platform"]) {
      expect(withInterception({ on: false, reason }).data?.health?.interception, reason).toEqual({ on: false, reason });
    }
    for (const interception of [{ on: false }, { on: true, reason: "awaiting-trust" }, { on: false, reason: "made-up" }, { on: false, reason: "awaiting-trust", detail: "made-up" }, {}]) {
      expect(withInterception(interception).success, JSON.stringify(interception)).toBe(false);
    }
  });

  it("ruledownload asks for everything first, and the signed answer is what the agent then enforces", async () => {
    expect(bodiesAt(GUARD_SYNC_DOORS.ruledownload(deviceId)).map((body) => GuardRuleDownloadRequest.parse(body))).toEqual([{ protocol: 1 }]);
    const scan = await policyScan(agent, dataDir, [
      { id: "tfn", host: "chatgpt.com", contentType: "text/plain", body: "my tfn is 123 456 782" },
      { id: "deepseek", host: "chat.deepseek.com", contentType: "text/plain", body: "hello" },
    ]);
    expect(scan.stderr).toBe("");
    expect(scan.rows).toEqual([
      expect.objectContaining({ id: "tfn", verdict: "blocked", enforced: false, bundleDigest: digestOf(bundle), catalogueDigest: digestOf(catalogue) }),
      expect.objectContaining({ id: "deepseek", verdict: "blocked", flowAction: "block" }),
    ]);
  });

  it("eventupload honours the registry's batch size and carries the event's metadata only", () => {
    const uploads = bodiesAt(GUARD_SYNC_DOORS.eventupload(deviceId)).map((body) => GuardEventUploadRequest.parse(body));
    expect(uploads.map((u) => u.events.length)).toEqual([BATCH, queued.length - BATCH]);
    expect(uploads.flatMap((u) => u.events)).toEqual(queued);
    const wire = JSON.stringify(uploads);
    for (const leaked of [...Object.values(CONTENT), ...Object.values(APP_PATHS)]) expect(wire).not.toContain(leaked);
    const one = queued[1]!;
    expect(GuardEventUploadRequest.safeParse({ protocol: 1, events: [] }).success).toBe(false);
    expect(GuardEventUploadRequest.safeParse({ protocol: 1, events: Array.from({ length: 500 }, () => one) }).success).toBe(true);
    expect(GuardEventUploadRequest.safeParse({ protocol: 1, events: Array.from({ length: 501 }, () => one) }).success).toBe(false);
  });

  it("postflight reports the bundle the agent verified, by the contract's digest", () => {
    const posts = bodiesAt(GUARD_SYNC_DOORS.postflight(deviceId)).map((body) => GuardPostflightRequest.parse(body));
    const rows = Object.keys(bundle.services).length + bundle.contentRules.length + bundle.exceptions.length;
    for (const post of posts) {
      expect(post).toEqual({
        protocol: 1,
        bundleVersion: bundle.bundleVersion,
        catalogueVersion: catalogue.version,
        rulesReceived: rows,
        rulesProcessed: rows,
        clientMode: "monitor",
        bundleDigest: digestOf(bundle),
      });
    }
    expect(posts).toHaveLength(2);
  });
});
