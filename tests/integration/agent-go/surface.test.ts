import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { validateChannel, validateEnvelope } from "@vibtra/guard-contract/policy";
import { describe, expect, it } from "vitest";
import { bundleDocument, createSigner, jsonObject, runAgentCommand, signEnvelope, startFakeRegistry, startOrigin, waitUntil, type Json, type Origin, type PolicySigner } from "./harness.ts";
import {
  createRelaySigner,
  decisions,
  policyProfile,
  queuedEvents,
  record,
  relayConnect,
  relayRequest,
  RELAY_PROXY_LINE,
  startRunning,
  useAgentSuite,
  writeRelayPin,
  type RelaySigner,
  type Reply,
  type Running,
} from "./running.ts";

const suite = useAgentSuite();
const MANIFEST = fileURLToPath(new URL("../../../guard/agent-go/surface-coverage.json", import.meta.url));
const MESSAGE = '{"prompt":"Reply with hello","messages":[{"content":"hello"}]}';

interface Identity {
  readonly signingId: string;
  readonly teamId: string;
}

interface Entry {
  readonly id: string;
  readonly surface: string;
  readonly host: string;
  readonly method: string;
  readonly transport: string;
  readonly path: string;
}

const BROWSER: Identity = { signingId: "com.google.Chrome.helper", teamId: "EQHXZ8M8AV" };
const NATIVE_CLAUDE: Identity = { signingId: "com.anthropic.claudefordesktop.helper", teamId: "Q6L2SF6YDW" };
const CODEX_APP: Identity = { signingId: "codex", teamId: "2DC432GLL2" };
const OWNER: Record<string, Identity> = { "claude-web": BROWSER, "chatgpt-web": BROWSER, "claude-macos": NATIVE_CLAUDE, "chatgpt-macos": CODEX_APP };
const OTHER_CLIENTS: Record<string, Identity[]> = { "claude-web": [NATIVE_CLAUDE], "claude-macos": [BROWSER], "chatgpt-web": [CODEX_APP], "chatgpt-macos": [BROWSER, NATIVE_CLAUDE] };
const IDENTITY_KIND: Record<string, string> = { "claude-web": "verified-browser", "chatgpt-web": "verified-browser", "claude-macos": "verified-native", "chatgpt-macos": "verified-native" };

const executableEntries = async (): Promise<Entry[]> => {
  const manifest = record(JSON.parse(await readFile(MANIFEST, "utf8")));
  if (!Array.isArray(manifest.entries)) throw new Error("the surface manifest has no entries");
  return manifest.entries.map(record).flatMap((entry) => {
    const matcher = record(entry.pathMatcher);
    const identity = record(entry.identityRequirement);
    const validation = record(entry.validation);
    const shape = entry.transport === "websocket" ? entry.method === "GET" : (entry.transport === "http-json" || entry.transport === "http-form") && entry.method === "POST";
    const executable =
      IDENTITY_KIND[String(entry.surface)] === identity.kind &&
      entry.action === "text-chat-send" &&
      shape &&
      (validation.status === "candidate" || validation.status === "verified") &&
      identity.selectedSurfaceProofRequired !== true &&
      Array.isArray(identity.allowlist) &&
      identity.allowlist.length > 0 &&
      (matcher.kind === "exact" || matcher.kind === "segments") &&
      String(matcher.value).startsWith("/");
    return executable ? [{ id: String(entry.id), surface: String(entry.surface), host: String(entry.host), method: String(entry.method), transport: String(entry.transport), path: String(matcher.value).replaceAll("{id}", "test-id") }] : [];
  });
};

interface SurfaceRig {
  readonly agent: Running;
  readonly origin: Origin;
  readonly relay: RelaySigner;
  readonly dataDir: string;
  policy(version: number, changes: Json): Promise<void>;
  send(entry: Pick<Entry, "host" | "method" | "path" | "transport">, identity: Identity | undefined, userAgent?: string, extra?: Record<string, string>): Promise<Reply>;
}

const surfaceRig = async (bundle: Json = {}): Promise<SurfaceRig> => {
  const signer: PolicySigner = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, signer);
  registry.override((call) => (call.door === "eventupload" ? { status: 503, body: { code: "UNAVAILABLE" } } : undefined));
  const profile = await policyProfile(suite, { signer, serverUrl: registry.url, bundle });
  const relay = createRelaySigner();
  await writeRelayPin(profile, relay);
  const origin = await startOrigin(suite.cleanup, (request, response) => {
    response.writeHead(request.method === "POST" && request.body.toString() !== MESSAGE ? 422 : 200, { "content-type": "text/plain" });
    response.end("reply");
  });
  const agent = await startRunning(suite, profile, { transparent: true, upstreamMap: { "chatgpt.com": origin.url, "claude.ai": origin.url, "other.chatgpt.com": origin.url, "gemini.google.com": origin.url } });
  return {
    agent,
    origin,
    relay,
    dataDir: profile.dataDir,
    policy: async (version, changes) => {
      registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { ...bundle, bundleVersion: version, ...changes })), catalogue: null });
      await waitUntil(`bundle version ${version}`, async () => ((await agent.status()).bundleVersion === version ? true : undefined));
    },
    send: (entry, identity, userAgent = "Chrome", extra = {}) =>
      relayRequest(
        agent,
        { servername: entry.host, ...(identity === undefined ? {} : { attribution: relay.line(RELAY_PROXY_LINE, identity).line }) },
        {
          method: entry.method,
          url: `https://${entry.host}${entry.path}`,
          headers: {
            "content-type": "application/json",
            "user-agent": userAgent,
            ...(entry.transport === "websocket" ? { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } : {}),
            ...extra,
          },
          ...(entry.method === "POST" ? { body: MESSAGE } : {}),
        },
      ),
  };
};

describe("signed surface controls", () => {
  it("stops every executable manifest entry before the origin for its own client only, and recovers when switched off", async () => {
    const entries = await executableEntries();
    expect(entries.map((entry) => entry.id).sort()).toEqual([
      "chatgpt-macos-codex-responses-http",
      "chatgpt-macos-codex-responses-websocket",
      "chatgpt-web-f-conversation",
      "chatgpt-web-unauth-conversation-updates",
      "claude-macos-completion",
      "claude-macos-retry-completion",
      "claude-web-completion",
      "claude-web-retry-completion",
    ]);
    const rig = await surfaceRig();
    await writeFile(path.join(rig.dataDir, "route-capture"), new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), { mode: 0o600 });
    let version = 1;
    for (const surface of [...new Set(entries.map((entry) => entry.surface))]) {
      const owned = entries.filter((entry) => entry.surface === surface);
      const owner = OWNER[surface];
      if (owner === undefined) throw new Error(`no owner identity for ${surface}`);
      for (const entry of owned) expect((await rig.send(entry, owner)).status, `${entry.id} off`).toBe(200);
      version += 1;
      await rig.policy(version, { surfaceBlocks: { [surface]: true } });
      for (const entry of owned) {
        const collateral: (Identity | undefined)[] = [undefined, { signingId: "com.anthropic.claudefordesktop.helper", teamId: "TESTTEAM01" }, { signingId: "com.openai.codex.helper", teamId: "TESTTEAM01" }, ...(OTHER_CLIENTS[surface] ?? [])];
        for (const identity of collateral) expect((await rig.send(entry, identity)).status, `${entry.id} collateral ${JSON.stringify(identity)}`).toBe(200);
        const before = rig.origin.received.length;
        const blocked = await rig.send(entry, owner, "codex_cli_rs/1.0");
        expect([blocked.status, rig.origin.received.length], entry.id).toEqual([403, before]);
        expect(blocked.text, entry.id).toContain("GUARD_SURFACE_BLOCKED");
        expect(blocked.text, entry.id).not.toContain('"requestsEnabled":true');
        const json = blocked.json();
        const policy = record(json.policy);
        expect(validateEnvelope(policy).ok, entry.id).toBe(true);
        const channel = validateChannel("http", {
          status: blocked.status,
          headers: { "content-type": String(blocked.headers["content-type"]), "x-vibtra-policy-decision": String(blocked.headers["x-vibtra-policy-decision"]) },
          body: { error: json.error, reason: json.reason, policy: json.policy },
        });
        expect(channel.ok, `${entry.id}: ${JSON.stringify(channel)}`).toBe(true);
        const reasons = Array.isArray(policy.reasons) ? policy.reasons.map(record) : [];
        expect(reasons[0]?.text, entry.id).toBe("Your organisation's Guard surface policy blocks this action.");
        const next = Array.isArray(policy.next) ? policy.next.map(record) : [];
        expect(String(next[0]?.text), entry.id).toContain("per-request approval cannot override");
        const event = (await queuedEvents(rig.dataDir)).at(-1);
        expect([event?.reason, event?.ruleKind, event?.ruleId, event?.matchType, event?.bundleVersion], entry.id).toEqual([`surface-block:${surface}`, "service", undefined, undefined, version]);
        const captured = (await readFile(path.join(rig.dataDir, "route-capture.jsonl"), "utf8")).trim().split("\n").map((line) => record(JSON.parse(line)));
        expect(captured.at(-1), entry.id).toMatchObject({ surfaceEntry: entry.id, identity: { status: "verified", signingId: owner.signingId, teamId: owner.teamId } });
      }
      const page = await rig.send(owned[0] ?? { host: "", method: "", path: "", transport: "" }, owner, "Mozilla/5.0 Chrome/155.0", { accept: "text/html" });
      expect(page.text).toContain("cannot override it");
      expect(page.text).not.toContain("<form");
      version += 1;
      await rig.policy(version, {});
      for (const entry of owned) {
        const before = rig.origin.received.length;
        expect([(await rig.send(entry, owner)).status, rig.origin.received.length], `${entry.id} recovered`).toEqual([200, before + 1]);
      }
    }
  });

  it("does not match unrelated routes, other hosts or unverified identities", async () => {
    const rig = await surfaceRig();
    await rig.policy(2, { surfaceBlocks: { "claude-web": true, "chatgpt-web": true, "chatgpt-macos": true } });
    const header = { "x-vibtra-signing-id": "com.google.Chrome.helper" };
    const cases: [string, string, string, string, Identity | undefined, string?][] = [
      ["auth", "POST", "chatgpt.com", "/backend-api/sentinel/chat-requirements", BROWSER],
      ["background", "POST", "chatgpt.com", "/ces/v1/t", BROWSER],
      ["startup", "GET", "chatgpt.com", "/backend-api/f/conversation", BROWSER],
      ["subdomain", "POST", "other.chatgpt.com", "/backend-api/f/conversation", BROWSER],
      ["host without entries", "POST", "gemini.google.com", "/backend-api/f/conversation", BROWSER],
      ["wrong-team", "POST", "chatgpt.com", "/backend-api/f/conversation", { signingId: "com.google.Chrome.helper", teamId: "BADTEAM001" }],
      ["forged-header", "POST", "chatgpt.com", "/backend-api/f/conversation", undefined],
      ["prepare", "POST", "chatgpt.com", "/backend-api/f/conversation/prepare", BROWSER],
      ["retired-route", "POST", "chatgpt.com", "/backend-api/conversation", BROWSER],
      ["codex-get-without-upgrade", "GET", "chatgpt.com", "/backend-api/codex/responses", CODEX_APP],
      ["codex-path-from-browser", "POST", "chatgpt.com", "/backend-api/codex/responses", BROWSER],
      ["codex-other-route", "POST", "chatgpt.com", "/backend-api/codex/analytics-events/events", CODEX_APP],
      ["extra-segment", "POST", "claude.ai", "/api/organizations/a/chat_conversations/b/completion/extra", BROWSER],
      ["empty-segment", "POST", "claude.ai", "/api/organizations//chat_conversations/b/completion", BROWSER],
      ["encoded-slash", "POST", "claude.ai", "/api/organizations/a%2fb/chat_conversations/c/completion", BROWSER],
    ];
    for (const [name, method, host, requestPath, identity] of cases) {
      expect((await rig.send({ method, host, path: requestPath, transport: "http-json" }, identity, "Chrome", header)).status, name).toBe(200);
    }
    const line = rig.relay.line(RELAY_PROXY_LINE, BROWSER).line;
    const route = { method: "POST", url: "https://chatgpt.com/backend-api/f/conversation", headers: { "content-type": "application/json", "user-agent": "Chrome" }, body: MESSAGE };
    expect((await relayRequest(rig.agent, { servername: "chatgpt.com", attribution: line }, route)).status, "first use").toBe(403);
    expect((await relayRequest(rig.agent, { servername: "chatgpt.com", attribution: line }, route)).status, "replayed").toBe(200);
  });

  it("cannot be bypassed by a stray Upgrade header and does not claim an unknown WebSocket route", async () => {
    const rig = await surfaceRig();
    await rig.policy(2, { surfaceBlocks: { "chatgpt-web": true } });
    expect((await rig.send({ host: "chatgpt.com", method: "POST", path: "/backend-api/f/conversation", transport: "http-json" }, BROWSER, "Chrome", { connection: "Upgrade", upgrade: "websocket" })).status).toBe(403);
    expect((await rig.send({ host: "chatgpt.com", method: "GET", path: "/backend-api/f/conversation", transport: "websocket" }, BROWSER)).status).toBe(200);
  });

  it("refuses without reading the body, and monitor mode forwards", async () => {
    const rig = await surfaceRig();
    await rig.policy(2, { surfaceBlocks: { "chatgpt-web": true } });
    const socket = await relayConnect(rig.agent, { servername: "chatgpt.com", attribution: rig.relay.line(RELAY_PROXY_LINE, BROWSER).line });
    const received: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => received.push(chunk));
    socket.write("POST /backend-api/f/conversation HTTP/1.1\r\nHost: chatgpt.com\r\nContent-Type: application/json\r\nContent-Length: 1048576\r\nExpect: 100-continue\r\n\r\n");
    await waitUntil("the surface refusal", async () => (Buffer.concat(received).includes("GUARD_SURFACE_BLOCKED") ? true : undefined), 5_000);
    const wire = Buffer.concat(received).toString();
    expect(wire.startsWith("HTTP/1.1 403")).toBe(true);
    expect(wire).not.toContain("100 Continue");
    expect(rig.origin.received).toHaveLength(0);
    socket.destroy();

    const monitor = await surfaceRig({ clientMode: "monitor" });
    await monitor.policy(2, { clientMode: "monitor", surfaceBlocks: { "chatgpt-web": true } });
    const reply = await monitor.send({ host: "chatgpt.com", method: "POST", path: "/backend-api/f/conversation", transport: "http-json" }, BROWSER);
    expect([reply.status, monitor.origin.received.length]).toEqual([200, 1]);
  });

  it("refuses a signed bundle that enables an unsupported control, and lists the supported ones", async () => {
    for (const [blocks, active] of [
      [{ "gemini-web": true }, false],
      [{ typo: false }, false],
      [{ "claude-web": true, "chatgpt-web": true, "claude-macos": true, "chatgpt-macos": true }, true],
    ] as const) {
      const profile = await policyProfile(suite, { bundle: { surfaceBlocks: blocks } });
      const result = await runAgentCommand(suite.binary(), ["status", "--local", "127.0.0.1:9"], { dataDir: profile.dataDir });
      expect(result.code).toBe(0);
      const status = jsonObject(result.stdout);
      expect(status.bundleVersion !== undefined, JSON.stringify(blocks)).toBe(active);
      expect(status.supportedSurfaceBlocks).toEqual(["claude-web", "claude-macos", "chatgpt-web", "chatgpt-macos"]);
    }
  });

  it("streams one notice per burst of retries, per app, and a new one after a quiet gap", { timeout: 90_000 }, async () => {
    const rig = await surfaceRig();
    await rig.policy(2, { surfaceBlocks: { "claude-macos": true } });
    const stream = await decisions(rig.agent);
    suite.cleanup.defer(async () => stream.close());
    const completion = { host: "claude.ai", method: "POST", path: "/api/organizations/test-id/chat_conversations/test-id/completion", transport: "http-json" };
    const retry = { ...completion, path: "/api/organizations/test-id/chat_conversations/test-id/retry_completion" };
    const app = { signingId: "com.anthropic.claudefordesktop", teamId: "Q6L2SF6YDW" };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await rig.send(completion, NATIVE_CLAUDE)).status).toBe(403);
      expect((await rig.send(retry, NATIVE_CLAUDE)).status).toBe(403);
    }
    expect((await rig.send(completion, app)).status).toBe(403);
    await delay(500);
    expect(stream.messages.filter((message) => message.name === "decision")).toHaveLength(2);
    expect((await queuedEvents(rig.dataDir)).length).toBeGreaterThanOrEqual(11);
    await delay(10_500);
    expect((await rig.send(completion, NATIVE_CLAUDE)).status).toBe(403);
    await delay(500);
    expect(stream.messages.filter((message) => message.name === "decision")).toHaveLength(3);
    for (let step = 0; step < 2; step += 1) {
      await delay(8_000);
      expect((await rig.send(retry, NATIVE_CLAUDE)).status).toBe(403);
    }
    await delay(500);
    expect(stream.messages.filter((message) => message.name === "decision")).toHaveLength(3);
  });
});
