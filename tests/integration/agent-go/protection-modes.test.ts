import { once } from "node:events";
import { readFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { GuardDeviceFacts, GuardEnrolRequest, GuardPreflightRequest } from "@vibtra/guard-contract";
import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  catalogueDocument,
  contentRule,
  createProfile,
  createSigner,
  jsonObject,
  runAgentCommand,
  selfSignedCertificate,
  signEnvelope,
  startFakeRegistry,
  startOrigin,
  tempDir,
  waitUntil,
  type AgentProfile,
  type FakeRegistry,
  type Json,
  type OriginHandler,
  type PolicySigner,
  type RegistryCall,
} from "./harness.ts";
import { buildHello, records } from "./hello.ts";
import {
  activityRows,
  createRelaySigner,
  local,
  policyProfile,
  queuedEvents,
  rawExchange,
  record,
  RELAY_PROXY_LINE,
  relayRequest,
  startRunning,
  useAgentSuite,
  viaProxy,
  writeRelayPin,
  type RelaySigner,
  type Running,
} from "./running.ts";

const suite = useAgentSuite();
const CHAT = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const BLOCK_CHAT = { services: { chat: { action: "block", ruleId: "gsr_00000001" } } };
const PREFLIGHT_MESSAGE = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)";
const HOUR_S = 3600;
const now = (): number => Math.floor(Date.now() / 1000);

const statusOf = async (profile: { dataDir: string }): Promise<Json> => {
  const result = await runAgentCommand(suite.binary(), ["status", "--local", "127.0.0.1:9"], { dataDir: profile.dataDir });
  expect(result.code, result.stderr).toBe(0);
  return jsonObject(result.stdout);
};

const profileHolding = async (bundle: Json, claims: { iat?: number; validUntil?: number } = {}, serverUrl?: string): Promise<{ profile: AgentProfile; signer: PolicySigner }> => {
  const signer = createSigner();
  const profile = await createProfile(suite.cleanup, { signer, bundle: null, catalogue: CHAT, ...(serverUrl === undefined ? {} : { serverUrl }) });
  await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, ...bundle }), { iat: claims.iat ?? now() - HOUR_S, ...(claims.validUntil === undefined ? {} : { validUntil: claims.validUntil }) })));
  return { profile, signer };
};

const callsTo = (registry: FakeRegistry, door: string): RegistryCall[] => registry.calls.filter((call) => call.door === door);
const deviceOf = (call: RegistryCall | undefined): Json => record(record(call?.body).device);
const healthOf = (call: RegistryCall | undefined): Json => record(record(call?.body).health);

const tlsOrigin = async (): Promise<{ port: number; cert: string; hits: () => number }> => {
  const certificate = await selfSignedCertificate(suite.cleanup, "DNS:chatgpt.com");
  let hits = 0;
  const server = https.createServer({ cert: certificate.cert, key: certificate.key }, (_request, response) => {
    hits += 1;
    response.writeHead(200, { "content-type": "text/plain" }).end("origin");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  suite.cleanup.defer(async () => {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the TLS origin did not listen on a TCP port");
  return { port: address.port, cert: certificate.cert, hits: () => hits };
};

const RELAY = createRelaySigner();
const HEALTH = "PROXY UNKNOWN vibtra-health\r\n";
const HEALTH_OFF = "PROXY UNKNOWN vibtra-health off\r\n";
const healthClaim = (line: string, signer: RelaySigner = RELAY): Buffer => signer.line(line, { signingId: "", teamId: "" }).line;
const exchange = (agent: Running, bytes: Buffer): Promise<Buffer> => rawExchange(agent.transparentPort, bytes, { until: (reply) => reply.includes(0x0a) });
const probe = (agent: Running, line: string): Promise<Buffer> => exchange(agent, Buffer.concat([Buffer.from(line), healthClaim(line)]));
const extensionActive = async (agent: Running): Promise<unknown> => (await local(agent, "/status")).json().extensionActive;

const steeringExtension = (agent: Running): { say(line: string): void } => {
  let line = "PROXY UNKNOWN vibtra-health\r\n";
  const timer = setInterval(() => void probe(agent, line), 500);
  suite.cleanup.defer(async () => clearInterval(timer));
  return {
    say: (next) => {
      line = next;
    },
  };
};

const modeNow = async (agent: Running): Promise<unknown> => (await local(agent, "/status")).json().clientMode;

describe("protection off on the Mac agent", () => {
  it("intercepts nothing and records nothing in Off, and keeps checking in", { timeout: 90_000 }, async () => {
    const origin = await tlsOrigin();
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url, catalogue: CHAT, bundle: { ...BLOCK_CHAT, clientMode: "off", defaultMode: "enforce", protectionRevision: 3 } });
    const agent = await startRunning(suite, profile, { transparent: true });
    const proxyLine = `PROXY TCP4 127.0.0.1 127.0.0.1 40000 ${origin.port}\r\n`;
    const reply = await relayRequest(agent, { proxyLine, servername: "chatgpt.com", ca: origin.cert }, { method: "GET", url: "https://chatgpt.com/", headers: { connection: "close" } });
    expect([reply.status, reply.text, origin.hits()], "the blocked service reached its own server with its own certificate").toEqual([200, "origin", 1]);
    const unnamed = await relayRequest(agent, { proxyLine, servername: "", ca: origin.cert, tls: { checkServerIdentity: () => undefined } }, { method: "GET", url: "https://chatgpt.com/", headers: { connection: "close" } });
    expect([unnamed.status, origin.hits()], "a hello that names no server is passed through too, not blocked").toEqual([200, 2]);
    expect(await queuedEvents(profile.dataDir)).toEqual([]);
    expect(await activityRows(agent)).toEqual([]);
    const postflight = await waitUntil("a postflight from the Mac in Off", async () => callsTo(registry, "postflight").find((call) => record(call.body).clientMode === "off"));
    expect(record(postflight.body).clientMode).toBe("off");
    expect(callsTo(registry, "preflight").every((call) => record(call.body).clientMode === "off")).toBe(true);
    expect((await local(agent, "/status")).json()).toMatchObject({ clientMode: "off", state: "off", policyExpired: false });
  });

  it("intercepts and blocks the same flow when the policy enforces", { timeout: 90_000 }, async () => {
    const origin = await tlsOrigin();
    const profile = await policyProfile(suite, { catalogue: CHAT, bundle: { ...BLOCK_CHAT, clientMode: "enforce" } });
    const agent = await startRunning(suite, profile, { transparent: true });
    const proxyLine = `PROXY TCP4 127.0.0.1 127.0.0.1 40000 ${origin.port}\r\n`;
    const reply = await relayRequest(agent, { proxyLine, servername: "chatgpt.com" }, { method: "GET", url: `https://chatgpt.com:${origin.port}/`, headers: { connection: "close" } });
    expect([reply.status, origin.hits()], "Guard's certificate answered and the rule blocked").toEqual([403, 0]);
    await waitUntil("the blocked flow recorded", async () => ((await queuedEvents(profile.dataDir)).some((event) => event.serviceId === "chat" && event.action === "blocked") ? true : undefined));
  });

  it("treats a mode it does not know as enforce", async () => {
    const { profile } = await profileHolding({ clientMode: "lockdown", defaultMode: "lockdown" });
    expect(await statusOf(profile)).toMatchObject({ bundleVersion: 1, clientMode: "enforce", state: "enforcing" });
    const verdict = jsonObject((await runAgentCommand(suite.binary(), ["test", "--host", "chatgpt.com"], { dataDir: profile.dataDir })).stdout);
    expect([verdict.verdict, verdict.enforced]).toEqual(["blocked", true]);
  });

  it("closes a steered flow with no address and no server name without sending a byte of its own", { timeout: 60_000 }, async () => {
    const profile = await policyProfile(suite, { catalogue: CHAT, bundle: { ...BLOCK_CHAT, clientMode: "off", defaultMode: "enforce", protectionRevision: 3 } });
    const agent = await startRunning(suite, profile, { transparent: true });
    for (const [name, first] of [
      ["a hello that names no server", records(buildHello({ extensions: [] }))],
      ["a first record that is not TLS", Buffer.from("GET / HTTP/1.1\r\nHost: example.test\r\n\r\n")],
    ] as const) {
      const started = Date.now();
      const reply = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from("PROXY UNKNOWN\r\n"), first]));
      expect([reply.toString("hex"), Date.now() - started < 4_000], `${name}: closed, with no alert from Guard`).toEqual(["", true]);
    }
    expect(await queuedEvents(profile.dataDir)).toEqual([]);
    expect(await activityRows(agent)).toEqual([]);
  });
});

describe("a signed policy past its validUntil", () => {
  const cases: { name: string; clientMode: string; defaultMode?: string; validUntil?: number; mode: string; expired: boolean }[] = [
    { name: "before expiry the person's own mode holds", clientMode: "off", defaultMode: "monitor", validUntil: now() + HOUR_S, mode: "off", expired: false },
    { name: "after expiry Off rises to the organisation default", clientMode: "off", defaultMode: "monitor", validUntil: now() - 60, mode: "monitor", expired: true },
    { name: "after expiry the stricter mode stays", clientMode: "enforce", defaultMode: "off", validUntil: now() - 60, mode: "enforce", expired: true },
    { name: "after expiry a default it does not know is enforce", clientMode: "monitor", defaultMode: "audit", validUntil: now() - 60, mode: "enforce", expired: true },
    { name: "a policy from a registry that signs no expiry never falls back", clientMode: "off", defaultMode: "enforce", mode: "off", expired: false },
  ];
  for (const item of cases) {
    it(item.name, async () => {
      const { profile } = await profileHolding({ clientMode: item.clientMode, ...(item.defaultMode === undefined ? {} : { defaultMode: item.defaultMode }) }, item.validUntil === undefined ? {} : { validUntil: item.validUntil });
      const current = await statusOf(profile);
      expect([current.clientMode, current.policyExpired]).toEqual([item.mode, item.expired]);
      expect(current.validUntil).toBe(item.validUntil === undefined ? undefined : new Date(item.validUntil * 1000).toISOString().replace(".000Z", "Z"));
    });
  }

  const quietRegistry = async (signer: PolicySigner, served: Json): Promise<FakeRegistry> => {
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.override((call) =>
      call.door === "preflight" ? { status: 200, body: { clientMode: "monitor", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: false, catalogueChanged: false, signingKeyId: signer.keyId } } : undefined,
    );
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, ...served }), { validUntil: now() + 72 * HOUR_S }), catalogue: null });
    return registry;
  };

  it("asks for a freshly signed policy when less than a day is left, even when nothing changed", async () => {
    const signer = createSigner();
    const registry = await quietRegistry(signer, { clientMode: "monitor", defaultMode: "monitor" });
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null, catalogue: CHAT });
    const expiring = now() + 2 * HOUR_S;
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, clientMode: "monitor", defaultMode: "monitor" }), { iat: now() - 70 * HOUR_S, validUntil: expiring })));
    const synced = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
    expect(synced.code, synced.stderr).toBe(0);
    const downloads = callsTo(registry, "ruledownload");
    expect(downloads).toHaveLength(1);
    expect(record(downloads[0]?.body).bundleVersion, "the registry re-signs only when the held version is left out").toBeUndefined();
    expect(Date.parse(String((await statusOf(profile)).validUntil)) / 1000).toBeGreaterThan(now() + 71 * HOUR_S);
    expect((await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir })).code).toBe(0);
    expect(callsTo(registry, "ruledownload"), "a fresh policy is not downloaded again").toHaveLength(1);
  });

  it("downloads nothing while more than a day is left", async () => {
    const signer = createSigner();
    const registry = await quietRegistry(signer, { clientMode: "monitor" });
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null, catalogue: CHAT });
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, clientMode: "monitor" }), { validUntil: now() + 48 * HOUR_S })));
    expect((await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir })).code).toBe(0);
    expect(callsTo(registry, "ruledownload")).toEqual([]);
  });
});

describe("what the agent reports about protection", () => {
  it("advertises that it accepts Off and reports whether the network extension is probing it", { timeout: 90_000 }, async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url, catalogue: CHAT });
    await writeRelayPin(profile, RELAY);
    const agent = await startRunning(suite, profile, { transparent: true });
    const first = await waitUntil("a preflight", async () => callsTo(registry, "preflight")[0]);
    expect(record(deviceOf(first).capabilities).protectionOff).toBe(1);
    expect(healthOf(first).extensionActive, "no extension has probed the agent yet").toBe(false);
    expect((await probe(agent, "PROXY UNKNOWN vibtra-health off\r\n")).toString()).toBe("VIBTRA-GUARD OK\r\n");
    const later = callsTo(registry, "preflight").length;
    const reported = await waitUntil("a preflight after the probe", async () => callsTo(registry, "preflight").slice(later).find((call) => healthOf(call).extensionActive === true));
    expect(GuardPreflightRequest.safeParse(reported.body).success).toBe(true);
  });

  it("counts only a health line signed with the extension's pinned key, and answers every one", { timeout: 60_000 }, async () => {
    const profile = await policyProfile(suite, { catalogue: CHAT });
    await writeRelayPin(profile, RELAY);
    const agent = await startRunning(suite, profile, { transparent: true });
    const genuine = healthClaim(HEALTH);
    const forged: [string, Buffer][] = [
      ["an unsigned line", Buffer.from(HEALTH)],
      ["a key the app did not pin", Buffer.concat([Buffer.from(HEALTH), healthClaim(HEALTH, createRelaySigner())])],
      ["a claim signed for the other line", Buffer.concat([Buffer.from(HEALTH_OFF), genuine])],
      ["a claim that names an app", Buffer.concat([Buffer.from(HEALTH), RELAY.line(HEALTH).line])],
    ];
    for (const [name, bytes] of forged) expect((await exchange(agent, bytes)).toString(), name).toBe("VIBTRA-GUARD OK\r\n");
    await delay(1_500);
    expect(await extensionActive(agent), "no forged line counts").toBe(false);
    expect((await exchange(agent, Buffer.concat([Buffer.from(HEALTH), genuine]))).toString()).toBe("VIBTRA-GUARD OK\r\n");
    await waitUntil("the signed line counted", async () => ((await extensionActive(agent)) === true ? true : undefined), 5_000);
  });

  it("stops reporting the extension about 10 s after its last signed health line", { timeout: 60_000 }, async () => {
    const profile = await policyProfile(suite, { catalogue: CHAT });
    await writeRelayPin(profile, RELAY);
    const agent = await startRunning(suite, profile, { transparent: true });
    expect(await extensionActive(agent)).toBe(false);
    await probe(agent, HEALTH);
    await waitUntil("the extension reported", async () => ((await extensionActive(agent)) === true ? true : undefined), 5_000);
    const seen = Date.now();
    await waitUntil("the extension reported gone", async () => ((await extensionActive(agent)) === false ? true : undefined), 20_000);
    expect((Date.now() - seen) / 1000).toBeGreaterThan(8);
  });

  it("still counts a signed health line after 4096 steered flows in two minutes", { timeout: 60_000 }, async () => {
    const profile = await policyProfile(suite, { catalogue: CHAT });
    await writeRelayPin(profile, RELAY);
    const agent = await startRunning(suite, profile, { transparent: true });
    const steeredFlow = async (): Promise<void> => {
      const socket = net.connect(agent.transparentPort, "127.0.0.1");
      socket.on("error", () => undefined);
      await once(socket, "connect");
      socket.end(Buffer.concat([Buffer.from(RELAY_PROXY_LINE), RELAY.line(RELAY_PROXY_LINE).line]));
      await once(socket, "close");
    };
    for (let sent = 0; sent < 4096; sent += 64) await Promise.all(Array.from({ length: 64 }, () => steeredFlow()));
    expect(await extensionActive(agent)).toBe(false);
    expect((await probe(agent, HEALTH)).toString()).toBe("VIBTRA-GUARD OK\r\n");
    await waitUntil("the signed line counted after the steered flows", async () => ((await extensionActive(agent)) === true ? true : undefined), 5_000);
  });

  it("retries once without the Off capability when an older registry refuses it, and for nothing else", async () => {
    const older = GuardPreflightRequest.extend({ device: GuardDeviceFacts.extend({ capabilities: GuardDeviceFacts.shape.capabilities.unwrap().omit({ protectionOff: true }).optional() }) });
    const detailOf = (body: unknown): string | undefined => {
      const result = older.safeParse(body);
      return result.success ? undefined : result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    };
    for (const item of [
      { name: "the older registry", detail: undefined, retries: true },
      { name: "another capability", detail: "device.capabilities: Unrecognized key(s) in object: 'protectionOff', 'other'", retries: false },
    ]) {
      const signer = createSigner();
      const registry = await startFakeRegistry(suite.cleanup, signer);
      registry.override((call) => {
        if (call.door !== "preflight") return undefined;
        const detail = detailOf(call.body);
        return detail === undefined ? undefined : { status: 400, body: { code: "VALIDATION", message: PREFLIGHT_MESSAGE, detail: item.detail ?? detail } };
      });
      const profile = await policyProfile(suite, { signer, serverUrl: registry.url, catalogue: CHAT });
      const synced = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
      const preflights = callsTo(registry, "preflight");
      expect([synced.code === 0, preflights.length], item.name).toEqual(item.retries ? [true, 2] : [false, 1]);
      expect(detailOf(preflights[0]?.body), item.name).toBe("device.capabilities: Unrecognized key(s) in object: 'protectionOff'");
      if (item.retries) {
        expect(Object.keys(record(deviceOf(preflights[1]).capabilities))).not.toContain("protectionOff");
        expect({ ...deviceOf(preflights[1]), capabilities: undefined }).toEqual({ ...deviceOf(preflights[0]), capabilities: undefined });
      }
    }
  });
});

describe("switching to and from Off", () => {
  const switchingRig = async (): Promise<{ agent: Running; registry: FakeRegistry; profile: AgentProfile; serve(bundle: Json): void }> => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url, catalogue: CHAT, bundle: { ...BLOCK_CHAT, clientMode: "monitor", defaultMode: "monitor", protectionRevision: 1 } });
    await writeRelayPin(profile, RELAY);
    const agent = await startRunning(suite, profile, { transparent: true });
    const serve = (bundle: Json): void => registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, defaultMode: "monitor", ...bundle })), catalogue: null });
    return { agent, registry, profile, serve };
  };
  const mirrored = async (profile: AgentProfile): Promise<unknown> => record(record(JSON.parse(await readFile(path.join(profile.dataDir, "bundle.json"), "utf8"))).bundle).clientMode;

  it("keeps inspecting until the extension has stopped steering, and is ready to inspect before the extension steers again", { timeout: 90_000 }, async () => {
    const { agent, registry, profile, serve } = await switchingRig();
    const extension = steeringExtension(agent);
    await waitUntil("a preflight that saw the extension", async () => callsTo(registry, "preflight").find((call) => healthOf(call).extensionActive === true));
    serve({ clientMode: "off", protectionRevision: 2 });
    await waitUntil("the Off policy published for the extension", async () => ((await mirrored(profile)) === "off" ? true : undefined));
    for (let i = 0; i < 4; i += 1) {
      expect(await modeNow(agent), "the agent stops inspecting only after the extension stops steering").toBe("monitor");
      await delay(750);
    }
    extension.say("PROXY UNKNOWN vibtra-health off\r\n");
    await waitUntil("the agent in Off", async () => ((await modeNow(agent)) === "off" ? true : undefined), 15_000);
    serve({ clientMode: "monitor", protectionRevision: 3 });
    await waitUntil("the agent inspecting again while the extension still steers nothing", async () => ((await modeNow(agent)) === "monitor" ? true : undefined), 15_000);
    expect(await mirrored(profile)).toBe("monitor");
  });

  it("goes to Off at once when no extension is steering", { timeout: 90_000 }, async () => {
    const { agent, serve } = await switchingRig();
    serve({ clientMode: "off", protectionRevision: 2 });
    await waitUntil("the agent in Off", async () => ((await modeNow(agent)) === "off" ? true : undefined), 15_000);
  });

  it("goes to Off 30 s after the policy arrives when the extension never stops steering", { timeout: 120_000 }, async () => {
    const { agent, profile, serve } = await switchingRig();
    steeringExtension(agent);
    await waitUntil("the extension seen", async () => ((await extensionActive(agent)) === true ? true : undefined));
    serve({ clientMode: "off", protectionRevision: 2 });
    await waitUntil("the Off policy published for the extension", async () => ((await mirrored(profile)) === "off" ? true : undefined));
    const published = Date.now();
    await waitUntil("the agent in Off", async () => ((await modeNow(agent)) === "off" ? true : undefined), 60_000);
    const waited = (Date.now() - published) / 1000;
    expect(waited).toBeGreaterThan(28);
    expect(waited).toBeLessThan(40);
  });
});

describe("a request in flight at the switch to Off", () => {
  const LOCAL = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["localhost"], bundleIds: [], cliNames: [], custom: true }] });
  const SECRET = [contentRule("gcr_00000000000000f2", { kind: "secret" })];
  const KEY = '{"message":"-----BEGIN PRIVATE KEY-----\\nGUARD_SYNTHETIC_NOT_A_KEY"}';
  const inFlight = async (
    clientMode: string,
    handler?: OriginHandler,
  ): Promise<{ socket: net.Socket; head: string; goOff(): Promise<void>; replied(): Promise<string>; recorded(): Promise<unknown[]> }> => {
    const origin = await startOrigin(suite.cleanup, handler);
    const profile = await policyProfile(suite, { catalogue: LOCAL, bundle: { contentRules: SECRET, clientMode } });
    const agent = await startRunning(suite, profile);
    const socket = net.connect(agent.proxyPort, "127.0.0.1");
    await once(socket, "connect");
    suite.cleanup.defer(async () => {
      socket.destroy();
    });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const authority = `localhost:${new URL(origin.url).port}`;
    const head = `POST http://${authority}/backend-api/conversation HTTP/1.1\r\nHost: ${authority}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(KEY)}\r\nConnection: close\r\n\r\n`;
    const goOff = async (): Promise<void> => {
      const bundle = signEnvelope(profile.signer, "bundle", bundleDocument(profile.signer, { contentRules: SECRET, clientMode: "off", protectionRevision: 1 }));
      await profile.writeFile("active-policy.json", JSON.stringify({ bundle, catalogue: signEnvelope(profile.signer, "catalogue", LOCAL) }));
      await waitUntil("the agent in Off", async () => ((await modeNow(agent)) === "off" ? true : undefined));
    };
    const replied = (): Promise<string> => waitUntil("the reply", async () => (Buffer.concat(chunks).includes("\r\n\r\n") ? Buffer.concat(chunks).toString("latin1") : undefined));
    const recorded = async (): Promise<unknown[]> => [...(await queuedEvents(profile.dataDir)), ...(await activityRows(agent))];
    return { socket, head, goOff, replied, recorded };
  };

  it("records nothing that Monitor matched once the agent is in Off", { timeout: 90_000 }, async () => {
    let release: (() => void) | undefined;
    const { socket, head, goOff, replied, recorded } = await inFlight("monitor", (_request, response) => {
      release = () => response.writeHead(200, { "content-type": "text/plain" }).end("late");
    });
    socket.write(`${head}${KEY}`);
    await waitUntil("the request at the origin", async () => (release === undefined ? undefined : true));
    await goOff();
    release?.();
    expect(await replied()).toContain("late");
    await delay(500);
    expect(await recorded()).toEqual([]);
  });

  it("records nothing that Enforce matched once the agent is in Off", { timeout: 90_000 }, async () => {
    const { socket, head, goOff, replied, recorded } = await inFlight("enforce");
    socket.write(`${head}${KEY.slice(0, 10)}`);
    await delay(500);
    await goOff();
    socket.write(KEY.slice(10));
    await replied();
    await delay(500);
    expect(await recorded()).toEqual([]);
  });
});

describe("the protection stamp orders policies of the same version", () => {
  const syncAgainst = async (held: Json, served: Json, heldAt: number, servedAt: number): Promise<{ saved: Json; stderr: string }> => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, served), { iat: servedAt }), catalogue: null });
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: null, catalogue: CHAT });
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundleDocument(signer, held), { iat: heldAt })));
    const result = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
    expect(callsTo(registry, "ruledownload").length, result.stderr).toBeGreaterThan(0);
    return { saved: record(record(JSON.parse(await readFile(path.join(profile.dataDir, "bundle.json"), "utf8"))).bundle), stderr: result.stderr };
  };

  it("refuses a lower protection revision even when it was signed later", async () => {
    const { saved, stderr } = await syncAgainst({ bundleVersion: 2, clientMode: "enforce", protectionRevision: 5 }, { bundleVersion: 2, clientMode: "off", protectionRevision: 4 }, now() - 60, now());
    expect([saved.protectionRevision, saved.clientMode]).toEqual([5, "enforce"]);
    expect(stderr).toContain("older policy bundle");
  });

  it("takes a higher protection revision even when it was signed earlier", async () => {
    const { saved } = await syncAgainst({ bundleVersion: 2, clientMode: "enforce", protectionRevision: 5 }, { bundleVersion: 2, clientMode: "monitor", protectionRevision: 6 }, now(), now() - 60);
    expect([saved.protectionRevision, saved.clientMode]).toEqual([6, "monitor"]);
  });
});

describe("live traffic past validUntil", () => {
  const LOCAL = catalogueDocument({ services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["localhost"], bundleIds: [], cliNames: [], custom: true }] });

  it("is checked with the organisation default the moment the policy expires", { timeout: 60_000 }, async () => {
    const origin = await startOrigin(suite.cleanup);
    const signer = createSigner();
    const profile = await policyProfile(suite, { signer, catalogue: LOCAL });
    const expiring = now() + 6;
    const off = signEnvelope(signer, "bundle", bundleDocument(signer, { ...BLOCK_CHAT, bundleVersion: 2, clientMode: "off", defaultMode: "enforce" }), { validUntil: expiring });
    await profile.writeFile("active-policy.json", JSON.stringify({ bundle: off, catalogue: signEnvelope(signer, "catalogue", LOCAL) }));
    const agent = await startRunning(suite, profile);
    await waitUntil("the agent in Off", async () => ((await modeNow(agent)) === "off" ? true : undefined));
    const post = () =>
      viaProxy(agent, { method: "POST", url: `http://localhost:${new URL(origin.url).port}/backend-api/conversation`, headers: { "content-type": "application/json", connection: "close" }, body: '{"prompt":"hello"}' });
    const before = await post();
    expect([before.status, origin.received.length], "in Off the blocked service is reached").toEqual([200, 1]);
    await waitUntil("the policy expired", async () => ((await local(agent, "/status")).json().policyExpired === true ? true : undefined), 20_000);
    const after = await post();
    expect([after.status, origin.received.length], "past validUntil the organisation default (enforce) blocks").toEqual([403, 1]);
  });
});

describe("a registry still on the released guard-v0.1.0", () => {
  const ENROL_MESSAGE = "Send { protocol, enrolToken, device, ca }";
  const device = GuardDeviceFacts.pick({ hostname: true, serialNumber: true, modelIdentifier: true, osVersion: true, osBuild: true, agentVersion: true, capabilities: true, supportedSurfaceBlocks: true, primaryUser: true, arch: true }).extend({
    capabilities: GuardDeviceFacts.shape.capabilities.unwrap().pick({ surfaceBlocks: true }).optional(),
  });
  const ca = GuardPreflightRequest.shape.ca.unwrap();
  const released = {
    enrol: { schema: GuardEnrolRequest.pick({ protocol: true, enrolToken: true, device: true, ca: true }).extend({ device, ca }) },
    preflight: {
      schema: GuardPreflightRequest.pick({ protocol: true, device: true, ca: true, clientMode: true, bundleVersion: true, catalogueVersion: true, signingKeyId: true, requestCleanSync: true, pendingEvents: true, health: true }).extend({
        device,
        ca,
        clientMode: GuardPreflightRequest.shape.clientMode.exclude(["off"]),
        health: GuardPreflightRequest.shape.health.unwrap().pick({ caTrusted: true, proxyListening: true, extensionActive: true, uptimeSeconds: true, model: true }).optional(),
      }),
    },
  };
  const refusal = (call: RegistryCall | undefined): string | undefined => {
    const door = call?.door === "enrol" ? released.enrol : call?.door === "preflight" ? released.preflight : undefined;
    const result = door?.schema.safeParse(call?.body);
    if (result === undefined || result.success) return undefined;
    return result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ")
      .slice(0, 400);
  };

  for (const os of ["linux", "darwin"]) {
    it(`enrols and syncs an agent that sends ${os} facts, dropping only what that release refuses`, async () => {
      const signer = createSigner();
      const registry = await startFakeRegistry(suite.cleanup, signer);
      registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, BLOCK_CHAT)), catalogue: signEnvelope(signer, "catalogue", CHAT) });
      registry.override((call) => {
        const detail = refusal(call);
        const message = call.door === "enrol" ? ENROL_MESSAGE : PREFLIGHT_MESSAGE;
        return detail === undefined ? undefined : { status: 400, body: { code: "VALIDATION", message, detail } };
      });
      const dataDir = await tempDir(suite.cleanup, `v010-${os}`);
      const env = { VIBTRA_GUARD_TEST_FACTS_OS: os };
      const enrolled = await runAgentCommand(suite.binary(), ["enrol", "--server", registry.url, "--token", `genr_${"0".repeat(32)}`], { dataDir, env });
      expect(enrolled.code, enrolled.stderr).toBe(0);
      expect(enrolled.stdout).toContain("Enrolled and synced");
      expect(callsTo(registry, "postflight")).toHaveLength(1);
      const protectionOff = "device.capabilities: Unrecognized key(s) in object: 'protectionOff'";
      expect(callsTo(registry, "enrol").map(refusal)).toEqual([protectionOff, undefined]);
      const preflights = callsTo(registry, "preflight");
      expect(preflights.map(refusal)).toEqual([`${protectionOff}; health: Unrecognized key(s) in object: 'interception', 'policyKey'`, protectionOff, undefined]);
      const [sent, accepted] = [deviceOf(preflights[0]), deviceOf(preflights[2])];
      const darwin = os === "darwin";
      expect([sent.capabilities, accepted.capabilities]).toEqual(darwin ? [{ surfaceBlocks: 1, protectionOff: 1 }, { surfaceBlocks: 1 }] : [{ protectionOff: 1 }, {}]);
      expect("supportedSurfaceBlocks" in accepted).toBe(darwin);
      expect({ ...accepted, capabilities: undefined }).toEqual({ ...sent, capabilities: undefined });
      expect(Object.keys(healthOf(preflights[2]))).not.toContain("interception");
    });
  }
});
