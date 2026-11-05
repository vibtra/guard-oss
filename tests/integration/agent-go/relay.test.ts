import { execFile } from "node:child_process";
import { once } from "node:events";
import { rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { catalogueDocument, startOrigin, type AgentProfile, type Json } from "./harness.ts";
import {
  activityRows,
  createRelaySigner,
  local,
  policyProfile,
  queuedEvents,
  rawExchange,
  record,
  relayConnect,
  relayRequest,
  RELAY_PROXY_LINE,
  startRunning,
  tlsRows,
  useAgentSuite,
  viaProxy,
  writeRelayPin,
  type RelaySigner,
  type Running,
} from "./running.ts";

const suite = useAgentSuite();
const run = promisify(execFile);
const CATALOGUE = catalogueDocument({ services: [{ serviceId: "synthetic", name: "Synthetic", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const REQUEST = { method: "GET", url: "https://chatgpt.com/", headers: { "user-agent": "Mozilla/5.0 Chrome/123", "x-vibtra-app": "com.fake.App", connection: "close" } };

const relayAgent = async (): Promise<{ agent: Running; profile: AgentProfile; signer: RelaySigner }> => {
  const profile = await policyProfile(suite, { bundle: { defaultAction: "block" }, catalogue: CATALOGUE });
  const signer = createRelaySigner();
  await writeRelayPin(profile, signer);
  const origin = await startOrigin(suite.cleanup);
  const agent = await startRunning(suite, profile, { transparent: true, upstreamMap: { "chatgpt.com": origin.url } });
  return { agent, profile, signer };
};

const attributionOf = (row: Json | undefined): Json => record(row?.processAttribution);

const handshake = async (agent: Running, attribution: Buffer | undefined, proxyLine = RELAY_PROXY_LINE): Promise<Json> => {
  const reply = await relayRequest(agent, { proxyLine, ...(attribution === undefined ? {} : { attribution }), servername: "chatgpt.com" }, REQUEST);
  expect(reply.status).toBe(403);
  const [latest] = await tlsRows(agent);
  return attributionOf(latest);
};

const expectUnattributed = (attribution: Json, label: string): void => {
  expect(attribution.status, label).toBe("unattributed");
  for (const key of ["signingId", "teamId", "source"]) expect(attribution[key], `${label}: ${key}`).toBeUndefined();
};

describe("relay attribution on the transparent listener", () => {
  it("verifies a signed app identity once and refuses its replay", async () => {
    const { agent, signer } = await relayAgent();
    const { line, identity } = signer.line(RELAY_PROXY_LINE);
    expect(await handshake(agent, line)).toEqual({ status: "verified", source: "network-extension", signingId: identity.signingId, teamId: identity.teamId });
    const replay = await handshake(agent, line);
    expectUnattributed(replay, "replay");
    expect(replay.reason).toBe("replayed");
  });

  it("refuses every untrusted claim and never spends the nonce on it", async () => {
    const { agent, profile, signer } = await relayAgent();
    const pinPath = path.join(profile.dataDir, "relay-attribution.json");
    const restorePin = async (): Promise<void> => {
      await rm(pinPath, { force: true });
      await writeRelayPin(profile, signer);
    };
    const cases: { name: string; identity?: Json; issuedAtOffset?: number; prepare?: () => Promise<void>; tamper?: (line: Buffer) => Buffer; proxyLine?: string }[] = [
      { name: "signature", tamper: (line) => Buffer.from(line.toString().replace(/ ([A-Za-z0-9_-])([A-Za-z0-9_-]*)\r\n$/, (_match, first: string, rest: string) => ` ${first === "A" ? "B" : "A"}${rest}\r\n`)) },
      { name: "destination", proxyLine: "PROXY UNKNOWN\r\n" },
      { name: "expired", issuedAtOffset: -61 },
      { name: "future", issuedAtOffset: 65 },
      { name: "key", identity: { keyId: "0".repeat(64) } },
      { name: "identifier", identity: { signingId: "private user@account/token" } },
      { name: "team", identity: { teamId: "private user" } },
      { name: "nonce", identity: { nonce: "short" } },
      { name: "version", identity: { version: 2 } },
      { name: "pin-absent", prepare: () => rm(pinPath) },
      { name: "pin-large", prepare: () => writeFile(pinPath, Buffer.alloc(4096), { mode: 0o600 }) },
      { name: "pin-key", prepare: () => writeRelayPin(profile, createRelaySigner()) },
      {
        name: "pin-fifo",
        prepare: async () => {
          await rm(pinPath);
          await run("mkfifo", ["-m", "600", pinPath]);
        },
      },
      {
        name: "pin-symlink",
        prepare: async () => {
          await rename(pinPath, `${pinPath}.original`);
          await symlink(`${pinPath}.original`, pinPath);
        },
      },
    ];
    for (const item of cases) {
      const { line, identity } = signer.line(RELAY_PROXY_LINE);
      const claim = item.issuedAtOffset === undefined ? item.identity : { issuedAt: Math.floor(Date.now() / 1000) + item.issuedAtOffset };
      const claimed = claim === undefined ? line : signer.signLine(RELAY_PROXY_LINE, { ...identity, ...claim });
      await item.prepare?.();
      const attribution = await handshake(agent, item.tamper?.(claimed) ?? claimed, item.proxyLine);
      expectUnattributed(attribution, item.name);
      await rm(`${pinPath}.original`, { force: true });
      await restorePin();
      expect(await handshake(agent, line), `${item.name}: the genuine line with the same nonce still verifies`).toMatchObject({ status: "verified" });
    }
  });

  it("follows a pin rotation at once", async () => {
    const { agent, profile, signer } = await relayAgent();
    const fresh = createRelaySigner();
    await writeRelayPin(profile, fresh);
    const old = await handshake(agent, signer.line(RELAY_PROXY_LINE).line);
    expectUnattributed(old, "old key");
    expect(old.reason).toBe("key-mismatch");
    expect(await handshake(agent, fresh.line(RELAY_PROXY_LINE).line)).toMatchObject({ status: "verified" });
  });

  it("accepts a nonce once under concurrency and bounds the replay memory", async () => {
    const { agent, signer } = await relayAgent();
    const { line } = signer.line(RELAY_PROXY_LINE);
    const replies = await Promise.all(Array.from({ length: 16 }, () => relayRequest(agent, { attribution: line, servername: "chatgpt.com" }, REQUEST)));
    expect(replies.every((reply) => reply.status === 403)).toBe(true);
    const rows = await tlsRows(agent);
    const count = (status: string): number => rows.filter((row) => attributionOf(row).status === status).reduce((total, row) => total + Number(row.count), 0);
    expect([count("verified"), count("unattributed")]).toEqual([1, 15]);
    for (let sent = 1; sent < 4096; sent += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, 4096 - sent) }, async () => {
          const socket = net.connect(agent.transparentPort, "127.0.0.1");
          await once(socket, "connect");
          socket.end(Buffer.concat([Buffer.from(RELAY_PROXY_LINE), signer.line(RELAY_PROXY_LINE).line]));
          await once(socket, "close");
        }),
      );
    }
    const overflow = await handshake(agent, signer.line(RELAY_PROXY_LINE).line);
    expectUnattributed(overflow, "overflow");
    expect(overflow.reason).toBe("replay-capacity");
  });

  it("frames the optional metadata line without touching the TLS bytes behind it", async () => {
    const { agent, signer } = await relayAgent();
    expect(await handshake(agent, signer.line(RELAY_PROXY_LINE).line)).toMatchObject({ status: "verified" });
    expect(await handshake(agent, undefined)).toEqual({ status: "unattributed", reason: "not-provided" });
    expectUnattributed(await handshake(agent, Buffer.from("VIBTRA_APP_V1 bad bad\r\n")), "invalid");
    for (const [name, bytes] of [
      ["oversize", Buffer.from(`V${"x".repeat(2048)}`)],
      ["partial", Buffer.from("VIBTRA_APP_V1 ")],
    ] as const) {
      const received = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from(RELAY_PROXY_LINE), bytes]), { end: true });
      expect(received.length, name).toBe(0);
    }
  });

  it("records the same attribution in TLS diagnostics and activity and never changes enforcement", async () => {
    for (const mode of ["verified", "invalid", "legacy"] as const) {
      const { agent, signer } = await relayAgent();
      const { line, identity } = signer.line(RELAY_PROXY_LINE);
      const attribution = mode === "verified" ? line : mode === "invalid" ? Buffer.from("VIBTRA_APP_V1 bad bad\r\n") : undefined;
      const fromTls = await handshake(agent, attribution);
      expect(fromTls.status === "verified", mode).toBe(mode === "verified");
      const rows = await activityRows(agent);
      expect(rows, mode).toHaveLength(1);
      expect(record(rows[0]?.inspection).processAttribution, mode).toEqual(fromTls);
      const encoded = JSON.stringify(rows);
      for (const secret of [identity.nonce, identity.keyId, "com.fake.App"]) expect(encoded, `${mode}: ${secret}`).not.toContain(secret);
    }
  });

  it("never trusts an app header from the client", async () => {
    const { agent } = await relayAgent();
    const reply = await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/", headers: { "x-vibtra-app": "com.fake.App", "user-agent": "Mozilla/5.0 Chrome/123" } });
    expect(reply.status).toBe(403);
    const [row] = await activityRows(agent);
    expectUnattributed(record(record(row?.inspection).processAttribution), "header");
  });

  it("keeps TLS diagnostics of two verified apps apart", async () => {
    const { agent, signer } = await relayAgent();
    for (const signingId of ["com.example.One", "com.example.Two"]) await handshake(agent, signer.line(RELAY_PROXY_LINE, { signingId }).line);
    expect((await tlsRows(agent)).map((row) => attributionOf(row).signingId).sort()).toEqual(["com.example.One", "com.example.Two"]);
  });

  it("reports its running capabilities without caching", async () => {
    const { agent } = await relayAgent();
    const status = await local(agent, "/status");
    expect(status.headers.get("cache-control")).toBe("no-store");
    expect(status.json().capabilities).toEqual({ nativeRelayAttribution: 1, nativeRelaySteering: 1, surfaceBlocks: 1 });
  });

  it("answers the health probe and drops a connection whose hello names no server", async () => {
    const { agent } = await relayAgent();
    const health = await rawExchange(agent.transparentPort, Buffer.from("PROXY UNKNOWN vibtra-health\r\n"), { until: (bytes) => bytes.includes(0x0a) });
    expect(health.toString()).toBe("VIBTRA-GUARD OK\r\n");
    const dropped = await rawExchange(agent.transparentPort, Buffer.concat([Buffer.from("PROXY UNKNOWN\r\n"), Buffer.from([22, 3, 3, 0, 1, 1])]));
    expect(dropped.length).toBe(0);
    const stillServing = await relayConnect(agent, { servername: "chatgpt.com" });
    stillServing.destroy();
  });
});

describe("a signed steering host", () => {
  const STEERING_CATALOGUE = catalogueDocument({ services: [{ serviceId: "synthetic", name: "Synthetic", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: ["codex"], custom: true }] });

  const steeringAgent = async (): Promise<{ agent: Running; profile: AgentProfile; signer: RelaySigner }> => {
    const profile = await policyProfile(suite, { bundle: { defaultAction: "block" }, catalogue: STEERING_CATALOGUE });
    const signer = createRelaySigner();
    await writeRelayPin(profile, signer);
    const origin = await startOrigin(suite.cleanup);
    const agent = await startRunning(suite, profile, { transparent: true, upstreamMap: { "chatgpt.com": origin.url } });
    return { agent, profile, signer };
  };

  it("never names an app on its own: a steering-only claim keeps the User-Agent app, and a verified claim stays the verified app", async () => {
    const { agent, profile, signer } = await steeringAgent();
    const request = { method: "POST", url: "https://chatgpt.com/", headers: { "user-agent": "codex_cli_rs/0.50.0 (Mac OS 15)", "content-type": "application/json", connection: "close" }, body: "{}" };
    for (const mode of ["legacy", "steering-only", "verified with a steering host"] as const) {
      const attribution = mode === "legacy" ? undefined : signer.line(RELAY_PROXY_LINE, mode === "steering-only" ? { signingId: "", teamId: "", steeringHost: "chatgpt.com" } : { steeringHost: "chatgpt.com" }).line;
      const reply = await relayRequest(agent, { ...(attribution === undefined ? {} : { attribution }), servername: "chatgpt.com" }, request);
      expect(reply.status, mode).toBe(403);
    }
    const events = await queuedEvents(profile.dataDir);
    expect(events.map((event) => event.app)).toEqual([{ cli: "codex", name: "codex_cli_rs" }, { cli: "codex", name: "codex_cli_rs" }, { bundleId: "com.example.SyntheticApp" }]);
    const inspections = (await activityRows(agent)).reverse().map((row) => record(row.inspection));
    expect(inspections.map((inspection) => [inspection.attribution, inspection.processAttribution])).toEqual([
      ["user-agent", { status: "unattributed", reason: "not-provided" }],
      ["user-agent", { status: "unattributed", source: "network-extension", reason: "no-app-identity", steeringHost: "chatgpt.com" }],
      ["network-extension", { status: "verified", source: "network-extension", signingId: "com.example.SyntheticApp", teamId: "TESTTEAM01", steeringHost: "chatgpt.com" }],
    ]);
  });

  it("is dropped when it breaks the host grammar while the signed app identity stays, and a claim with only an invalid host is malformed", async () => {
    const { agent, signer } = await steeringAgent();
    for (const host of ["chatgpt.com", "123.example", "a-b.c0", "x"]) {
      expect(await handshake(agent, signer.line(RELAY_PROXY_LINE, { steeringHost: host }).line, RELAY_PROXY_LINE), host).toMatchObject({ status: "verified", signingId: "com.example.SyntheticApp", steeringHost: host });
      expect(await handshake(agent, signer.line(RELAY_PROXY_LINE, { signingId: "", teamId: "", steeringHost: host }).line, RELAY_PROXY_LINE), `${host} alone`).toEqual({ status: "unattributed", source: "network-extension", reason: "no-app-identity", steeringHost: host });
    }
    for (const host of ["bad/host", "127.0.0.1", "1.2.3.4", "foo.123", "Chatgpt.com", "a_b.example", "-x.example", "x..example", `${"a".repeat(64)}.example`]) {
      expect(await handshake(agent, signer.line(RELAY_PROXY_LINE, { steeringHost: host }).line, RELAY_PROXY_LINE), host).toEqual({ status: "verified", source: "network-extension", signingId: "com.example.SyntheticApp", teamId: "TESTTEAM01" });
      expect(await handshake(agent, signer.line(RELAY_PROXY_LINE, { signingId: "", teamId: "", steeringHost: host }).line, RELAY_PROXY_LINE), `${host} alone`).toEqual({ status: "unattributed", reason: "malformed" });
    }
  });
});
