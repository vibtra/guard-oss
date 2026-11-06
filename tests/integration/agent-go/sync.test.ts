import { spawn } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { appendFile, chmod, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { GUARD_CATALOGUE_SEED_VERSION, GuardDeviceFacts, GuardEventUploadRequest } from "@vibtra/guard-contract";
import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  catalogueDocument,
  createProfile,
  createSigner,
  deviceDocument,
  jsonLines,
  jsonObject,
  runAgentCommand,
  selfSignedCertificate,
  signEnvelope,
  startFakeRegistry,
  tempDir,
  type AgentProfile,
  type FakeRegistry,
  type Json,
  type PolicySigner,
  type RegistryCall,
} from "./harness.ts";
import { activityRows, decisions, local, policyProfile, queuedEvents, record, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const FIXTURES = fileURLToPath(new URL("../../../guard/agent/tests/fixtures/", import.meta.url));
const CHECKPOINT = "active-policy.json";
const INBOX = "events-from-extension.jsonl";
const CURSOR = "extension-inbox-cursor.json";
const PREFLIGHT_MESSAGE = "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)";
const ENROL_MESSAGE = "Send { protocol, enrolToken, device, ca }";

const chatCatalogue = (version: string, enabled: boolean): Json =>
  catalogueDocument({ version, services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true, enabled }] });
const chatBundle = (signer: PolicySigner, version: number, catalogueVersion: string, changes: Json = {}): Json =>
  bundleDocument(signer, { bundleVersion: version, catalogueVersion, services: { chat: { action: "block" } }, ...changes });

const command = (profile: { dataDir: string }, args: readonly string[]) => runAgentCommand(suite.binary(), args, { dataDir: profile.dataDir });
const status = async (profile: { dataDir: string }): Promise<Json> => {
  const result = await command(profile, ["status", "--local", "127.0.0.1:9"]);
  expect(result.code, result.stderr).toBe(0);
  return jsonObject(result.stdout);
};
const sync = (profile: { dataDir: string }) => command(profile, ["sync"]);
const routing = async (profile: { dataDir: string }): Promise<Json | undefined> => {
  const result = await command(profile, ["test", "--host", "chatgpt.com"]);
  return result.code === 0 ? jsonObject(result.stdout) : undefined;
};
const file = (profile: { dataDir: string }, name: string): string => path.join(profile.dataDir, name);
const bytesOf = (profile: { dataDir: string }, name: string): Promise<Buffer> => readFile(file(profile, name));
const parsed = async (profile: { dataDir: string }, name: string): Promise<unknown> => JSON.parse(await readFile(file(profile, name), "utf8"));

const expectProtected = async (profile: AgentProfile, bundleVersion: number): Promise<void> => {
  const current = await status(profile);
  expect([current.bundleVersion, current.catalogueVersion], "the last verified pair is active").toEqual([bundleVersion, "v1"]);
  const verdict = await routing(profile);
  expect([verdict?.intercepted, verdict?.verdict], "chatgpt.com is still intercepted and blocked").toEqual([true, "blocked"]);
};

interface PairRig {
  readonly signer: PolicySigner;
  readonly registry: FakeRegistry;
  readonly profile: AgentProfile;
  envelope(kind: "bundle" | "catalogue", document: Json): Json;
}

const pairRig = async (): Promise<PairRig> => {
  const signer = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, signer);
  const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url, bundle: chatBundle(signer, 1, "v1"), catalogue: chatCatalogue("v1", true) });
  await status(profile);
  return { signer, registry, profile, envelope: (kind, document) => signEnvelope(signer, kind, document) };
};

describe("the signed policy pair on disk", () => {
  it("keeps the last verified pair when a catalogue arrives without its bundle, across restarts", async () => {
    const { profile } = await pairRig();
    await expectProtected(profile, 1);
    await profile.writePolicy({ catalogue: chatCatalogue("v2", false) });
    await expectProtected(profile, 1);
    await expectProtected(profile, 1);
  });

  it("refuses a partial signed download before it writes anything", async () => {
    const { registry, profile, envelope } = await pairRig();
    const before = { bundle: await bytesOf(profile, "bundle.json"), catalogue: await bytesOf(profile, "catalogue.json"), checkpoint: await bytesOf(profile, CHECKPOINT) };
    registry.serve({ bundle: null, catalogue: envelope("catalogue", chatCatalogue("v2", false)) });
    expect((await sync(profile)).code).not.toBe(0);
    expect(registry.calls.map((call) => call.door)).toContain("ruledownload");
    await expectProtected(profile, 1);
    expect(await bytesOf(profile, "bundle.json")).toEqual(before.bundle);
    expect(await bytesOf(profile, "catalogue.json")).toEqual(before.catalogue);
    expect(await bytesOf(profile, CHECKPOINT)).toEqual(before.checkpoint);
  });

  it("takes a bundle-only update and a complete pair that turns interception off", async () => {
    const { signer, registry, profile, envelope } = await pairRig();
    const checkpoint = record(await parsed(profile, CHECKPOINT));
    expect(record(record(checkpoint.bundle).bundle).bundleVersion).toBe(1);
    expect(record(record(checkpoint.catalogue).catalogue).version).toBe("v1");
    registry.serve({ bundle: envelope("bundle", chatBundle(signer, 2, "v1")), catalogue: null });
    expect((await sync(profile)).code).toBe(0);
    await expectProtected(profile, 2);
    registry.serve({ bundle: envelope("bundle", chatBundle(signer, 3, "v2")), catalogue: envelope("catalogue", chatCatalogue("v2", false)) });
    expect((await sync(profile)).code).toBe(0);
    const current = await status(profile);
    expect([current.bundleVersion, current.catalogueVersion]).toEqual([3, "v2"]);
    expect((await routing(profile))?.intercepted).toBe(false);
  });

  it("repairs both mirrors from the checkpoint whichever mirror write a stop interrupted", async () => {
    for (const completed of [0, 1, 2]) {
      const { signer, profile, envelope } = await pairRig();
      const next = { bundle: envelope("bundle", chatBundle(signer, 2, "v1")), catalogue: envelope("catalogue", chatCatalogue("v1", true)) };
      await writeFile(file(profile, CHECKPOINT), JSON.stringify(next), { mode: 0o600 });
      if (completed >= 1) await writeFile(file(profile, "bundle.json"), JSON.stringify(next.bundle), { mode: 0o600 });
      if (completed >= 2) await writeFile(file(profile, "catalogue.json"), JSON.stringify(next.catalogue), { mode: 0o600 });
      await expectProtected(profile, 2);
      expect(await parsed(profile, "bundle.json"), `bundle after ${completed}`).toEqual(next.bundle);
      expect(await parsed(profile, "catalogue.json"), `catalogue after ${completed}`).toEqual(next.catalogue);
    }
  });

  it("refuses a pair with an invalid half and leaves the checkpoint alone", async () => {
    const { signer, registry, profile, envelope } = await pairRig();
    const before = await bytesOf(profile, CHECKPOINT);
    const forged = envelope("bundle", chatBundle(signer, 2, "v2"));
    registry.serve({ bundle: { ...forged, bundle: { ...record(forged.bundle), bundleVersion: 99 } }, catalogue: envelope("catalogue", chatCatalogue("v2", false)) });
    expect((await sync(profile)).code).not.toBe(0);
    expect(await bytesOf(profile, CHECKPOINT)).toEqual(before);
    await expectProtected(profile, 1);
  });

  it("does not start from a mismatched pair and accepts a bundle alone only for the seed catalogue version", async () => {
    for (const kind of ["signed-mismatch", "seed-mismatch", "seed-match"] as const) {
      const signer = createSigner();
      const profile = await createProfile(suite.cleanup, {
        signer,
        bundle: chatBundle(signer, 1, kind === "seed-match" ? GUARD_CATALOGUE_SEED_VERSION : "mismatch"),
        catalogue: kind === "signed-mismatch" ? chatCatalogue("v1", true) : null,
      });
      const current = await status(profile);
      if (kind === "seed-match") {
        expect([current.bundleVersion, current.catalogueSource, current.catalogueVersion], kind).toEqual([1, "seed", GUARD_CATALOGUE_SEED_VERSION]);
        continue;
      }
      expect(current.bundleVersion, kind).toBeUndefined();
      await expect(stat(file(profile, CHECKPOINT)), kind).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("never falls back to the mirrors when the checkpoint is corrupt", async () => {
    const { profile } = await pairRig();
    await writeFile(file(profile, CHECKPOINT), '{"bundle":"corrupt"}', { mode: 0o600 });
    expect((await status(profile)).bundleVersion).toBeUndefined();
    expect(await routing(profile)).toBeUndefined();
  });

  it("drops the pair when the pinned key, organisation or device changes, or the device is revoked", async () => {
    const other = createSigner();
    for (const [name, changes] of [
      ["pem", { signing: { keyId: undefined, alg: "ES256", publicKeyPem: other.publicKeyPem } }],
      ["org", { orgId: "org_other" }],
      ["device", { deviceId: "gdev_other" }],
      ["revoked", { revoked: true }],
    ] as const) {
      const { signer, profile } = await pairRig();
      const device = deviceDocument(signer, profile.serverUrl);
      const signing = "signing" in changes ? { ...record(device.signing), keyId: signer.keyId, publicKeyPem: changes.signing.publicKeyPem } : device.signing;
      await profile.writeFile("device.json", JSON.stringify({ ...device, ...changes, signing }));
      expect((await status(profile)).bundleVersion, name).toBeUndefined();
      expect((await status(profile)).bundleVersion, `${name} after a restart`).toBeUndefined();
    }
  });

  it("finishes a committed update on the next start after a mirror write failed", async () => {
    const { signer, registry, profile, envelope } = await pairRig();
    await rm(file(profile, "catalogue.json"));
    await mkdir(file(profile, "catalogue.json"), { mode: 0o700 });
    registry.serve({ bundle: envelope("bundle", chatBundle(signer, 2, "v1")), catalogue: envelope("catalogue", chatCatalogue("v1", true)) });
    expect((await sync(profile)).code).not.toBe(0);
    await rm(file(profile, "catalogue.json"), { recursive: true });
    await expectProtected(profile, 2);
    expect(record(record(await parsed(profile, "catalogue.json")).catalogue).version).toBe("v1");
  });

  it("waits for the policy store lock another agent holds and then reads the newest checkpoint", async () => {
    const { signer, profile, envelope } = await pairRig();
    const holder = spawn("python3", ["-c", "import fcntl,sys\nf=open(sys.argv[1],'a')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\nsys.stdin.read()", file(profile, "policy.lock")], { stdio: ["pipe", "pipe", "inherit"] });
    suite.cleanup.defer(async () => {
      holder.kill("SIGKILL");
    });
    const [line]: unknown[] = await once(holder.stdout, "data");
    expect(String(line).trim()).toBe("locked");
    let finished = false;
    const reading = status(profile).then((value) => {
      finished = true;
      return value;
    });
    await delay(500);
    expect(finished, "status read the store while another process held the lock").toBe(false);
    await writeFile(file(profile, CHECKPOINT), JSON.stringify({ bundle: envelope("bundle", chatBundle(signer, 2, "v1")), catalogue: envelope("catalogue", chatCatalogue("v1", true)) }), { mode: 0o600 });
    holder.stdin.end();
    await once(holder, "exit");
    expect((await reading).bundleVersion).toBe(2);
  });
});

describe("signatures from the registry", () => {
  const fixtureDocument = async (name: string, kind: "bundle" | "catalogue"): Promise<Json> => record(record(JSON.parse(await readFile(path.join(FIXTURES, name), "utf8")))[kind]);
  const fernwood = (): PolicySigner => ({ ...createSigner(), orgId: "org_fernwood", deviceId: "gdev_0123456789abcdef" });

  const fixtureProfile = async (signer: PolicySigner, bundle: Json, catalogue: Json, claims: { deviceId?: string; keyId?: string } = {}): Promise<AgentProfile> => {
    const profile = await createProfile(suite.cleanup, { signer, bundle: null, catalogue: null });
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(signer, "bundle", bundle, claims)));
    await profile.writeFile("catalogue.json", JSON.stringify(signEnvelope(signer, "catalogue", catalogue)));
    return profile;
  };

  it("accepts the registry's fixture documents with the registry's digests and refuses other-device, other-key and tampered copies", async () => {
    const digests = record(JSON.parse(await readFile(path.join(FIXTURES, "digests.json"), "utf8")));
    const bundle = await fixtureDocument("signed-bundle.json", "bundle");
    const catalogue = await fixtureDocument("signed-catalogue.json", "catalogue");
    const scanDigests = async (profile: AgentProfile): Promise<unknown[]> => {
      const scanned = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: '{"id":"x","host":"chatgpt.com"}\n' });
      expect(scanned.code, scanned.stderr).toBe(0);
      const [row] = jsonLines(scanned.stdout);
      return [row?.bundleDigest, row?.catalogueDigest];
    };
    const signer = fernwood();
    const bundleSide = await fixtureProfile(signer, bundle, { ...catalogue, version: bundle.catalogueVersion });
    expect((await status(bundleSide)).bundleVersion).toBe(7);
    expect((await scanDigests(bundleSide))[0]).toBe(digests.bundleDigest);
    const catalogueSide = await fixtureProfile(signer, { ...bundle, catalogueVersion: catalogue.version }, catalogue);
    expect((await status(catalogueSide)).bundleVersion).toBe(7);
    expect((await scanDigests(catalogueSide))[1]).toBe(digests.catalogueDigest);
    const pairedCatalogue = { ...catalogue, version: bundle.catalogueVersion };
    for (const [name, profile] of [
      ["other device", await fixtureProfile(signer, bundle, pairedCatalogue, { deviceId: "gdev_fedcba9876543210" })],
      ["other key", await fixtureProfile(signer, bundle, pairedCatalogue, { keyId: "gk_wrong" })],
      ["tampered", await fixtureProfile(signer, bundle, pairedCatalogue)],
    ] as const) {
      if (name === "tampered") {
        const envelope = record(JSON.parse(await readFile(file(profile, "bundle.json"), "utf8")));
        await profile.writeFile("bundle.json", JSON.stringify({ ...envelope, bundle: { ...record(envelope.bundle), defaultAction: "block" } }));
      }
      expect((await status(profile)).bundleVersion, name).toBeUndefined();
    }
  });

  it("keeps the last verified policy when a tampered bundle replaces it on disk", async () => {
    const bundle = await fixtureDocument("signed-bundle.json", "bundle");
    const catalogue = { ...(await fixtureDocument("signed-catalogue.json", "catalogue")), version: bundle.catalogueVersion };
    const profile = await fixtureProfile(fernwood(), bundle, catalogue);
    expect((await status(profile)).bundleVersion).toBe(7);
    const envelope = record(JSON.parse(await readFile(file(profile, "bundle.json"), "utf8")));
    await profile.writeFile("bundle.json", JSON.stringify({ ...envelope, bundle: { ...record(envelope.bundle), clientMode: "monitor" } }));
    expect((await status(profile)).bundleVersion).toBe(7);
  });

  it("canonicalises JSON exactly as the TypeScript signer does", async () => {
    const signer = createSigner();
    const rule = { ruleId: "gcr_00000000000000e1", name: 'z <>&\u2028\u2029 "quoted" 😀 naïve', services: "*", detector: { kind: "keyword", keywords: ["Café", "<b>"] }, action: "block" };
    const profile = await createProfile(suite.cleanup, { signer, bundle: bundleDocument(signer, { contentRules: [rule] }) });
    expect((await status(profile)).bundleVersion).toBe(1);
  });

  it("makes its CA through the signer once and reuses it across commands", async () => {
    const profile = await createProfile(suite.cleanup);
    const first = await command(profile, ["ca", "export"]);
    expect(first.code, first.stderr).toBe(0);
    expect((await command(profile, ["ca", "export"])).stdout).toBe(first.stdout);
    const fingerprint = new X509Certificate(first.stdout).fingerprint256.replaceAll(":", "").toLowerCase();
    expect(record((await status(profile)).ca).fingerprintSha256).toBe(fingerprint);
  });
});

const zodDetail = (): string => {
  const legacy = GuardDeviceFacts.omit({ capabilities: true, supportedSurfaceBlocks: true });
  const result = legacy.safeParse({ hostname: "synthetic", osVersion: "darwin", agentVersion: "0.1.0", capabilities: { surfaceBlocks: 1 }, supportedSurfaceBlocks: ["claude-web", "chatgpt-web"] });
  if (result.success) throw new Error("the legacy strict schema accepted the new fields");
  return result.error.issues.map((issue) => `device${issue.path.length > 0 ? `.${issue.path.join(".")}` : ""}: ${issue.message}`).join("; ");
};

const deviceOf = (call: RegistryCall | undefined): Json => record(record(call?.body).device);

describe.runIf(process.platform === "darwin")("an older registry that rejects the new device facts", () => {
  it("matches the error a strict older registry really returns", () => {
    expect(zodDetail()).toBe("device: Unrecognized key(s) in object: 'capabilities', 'supportedSurfaceBlocks'");
  });

  it("retries a preflight once without the new facts, keeps authentication, and sends them again next time", async () => {
    const { registry, profile } = await pairRig();
    const detail = zodDetail();
    registry.override((call) => (call.door === "preflight" && "capabilities" in deviceOf(call) ? { status: 400, body: { code: "VALIDATION", message: PREFLIGHT_MESSAGE, detail } } : undefined));
    expect((await sync(profile)).code).toBe(0);
    const preflights = registry.calls.filter((call) => call.door === "preflight");
    expect(preflights).toHaveLength(2);
    const [strict, retried] = [deviceOf(preflights[0]), deviceOf(preflights[1])];
    const { capabilities, supportedSurfaceBlocks, ...rest } = strict;
    expect([capabilities, supportedSurfaceBlocks]).toEqual([{ surfaceBlocks: 1 }, ["claude-web", "claude-macos", "chatgpt-web", "chatgpt-macos"]]);
    expect(retried).toEqual(rest);
    expect(preflights[1]?.headers.authorization).toBe(preflights[0]?.headers.authorization);
    expect(preflights[0]?.headers.authorization).toMatch(/^Bearer gdt_/);
    registry.override(undefined);
    expect((await sync(profile)).code).toBe(0);
    expect(deviceOf(registry.calls.filter((call) => call.door === "preflight").at(-1)).capabilities).toEqual({ surfaceBlocks: 1 });
  });

  it("retries a preflight once when the detail names the two new facts in the other order", async () => {
    const { registry, profile } = await pairRig();
    const detail = "device: Unrecognized key(s) in object: 'supportedSurfaceBlocks', 'capabilities'";
    registry.override((call) => (call.door === "preflight" && "capabilities" in deviceOf(call) ? { status: 400, body: { code: "VALIDATION", message: PREFLIGHT_MESSAGE, detail } } : undefined));
    expect((await sync(profile)).code).toBe(0);
    const preflights = registry.calls.filter((call) => call.door === "preflight");
    expect(preflights).toHaveLength(2);
    expect([Object.keys(deviceOf(preflights[1])).filter((key) => key === "capabilities" || key === "supportedSurfaceBlocks"), preflights[1]?.headers.authorization]).toEqual([[], preflights[0]?.headers.authorization]);
  });

  it("retries an enrolment once without the new facts", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer)), catalogue: signEnvelope(signer, "catalogue", catalogueDocument()) });
    registry.override((call) => (call.door === "enrol" && "capabilities" in deviceOf(call) ? { status: 400, body: { code: "VALIDATION", message: ENROL_MESSAGE, detail: zodDetail() } } : undefined));
    const dataDir = await tempDir(suite.cleanup, "enrol");
    const result = await runAgentCommand(suite.binary(), ["enrol", "--server", registry.url, "--token", `genr_${"0".repeat(32)}`], { dataDir });
    expect(result.code, result.stderr).toBe(0);
    const enrols = registry.calls.filter((call) => call.door === "enrol");
    expect(enrols).toHaveLength(2);
    expect(Object.keys(deviceOf(enrols[1]))).not.toContain("capabilities");
    expect(record(JSON.parse(await readFile(path.join(dataDir, "device.json"), "utf8"))).deviceId).toBe(signer.deviceId);
  });

  it("does not retry for any other error, door or status", async () => {
    const detail = zodDetail();
    const cases: { name: string; door: string; status: number; code: string; message?: string; detail?: string }[] = [
      { name: "other field", door: "preflight", status: 400, code: "VALIDATION", detail: `${detail}, 'unknown'` },
      { name: "other validation", door: "preflight", status: 400, code: "VALIDATION", detail: `${detail}; device.hostname: Required` },
      { name: "wrong scope", door: "preflight", status: 400, code: "VALIDATION", detail: detail.replace("device:", "(root):") },
      { name: "wrong message", door: "preflight", status: 400, code: "VALIDATION", message: "Invalid request" },
      { name: "upgrade", door: "preflight", status: 409, code: "GUARD_UPGRADE_REQUIRED" },
      { name: "wrong status", door: "preflight", status: 409, code: "VALIDATION" },
      { name: "authentication", door: "preflight", status: 401, code: "GUARD_TOKEN_INVALID" },
      { name: "download", door: "ruledownload", status: 400, code: "VALIDATION" },
    ];
    for (const item of cases) {
      const { registry, profile } = await pairRig();
      registry.override((call) => (call.door === item.door ? { status: item.status, body: { code: item.code, message: item.message ?? PREFLIGHT_MESSAGE, detail: item.detail ?? detail } } : undefined));
      expect((await sync(profile)).code, item.name).not.toBe(0);
      expect(registry.calls.filter((call) => call.door === item.door), item.name).toHaveLength(1);
      expect((await status(profile)).enrolled, item.name).toBe(true);
    }
  });

  it("tries a dead registry once, and treats a revocation as final", async () => {
    let connections = 0;
    const dead = net.createServer((socket) => {
      connections += 1;
      socket.destroy();
    });
    dead.listen(0, "127.0.0.1");
    await once(dead, "listening");
    suite.cleanup.defer(async () => {
      dead.close();
    });
    const address = dead.address();
    if (address === null || typeof address === "string") throw new Error("the dead registry has no port");
    const signer = createSigner();
    const unreachable = await createProfile(suite.cleanup, { signer, serverUrl: `http://127.0.0.1:${address.port}`, bundle: chatBundle(signer, 1, "v1"), catalogue: chatCatalogue("v1", true) });
    expect((await sync(unreachable)).code).not.toBe(0);
    expect(connections).toBe(1);

    const { registry, profile } = await pairRig();
    registry.override((call) => (call.door === "preflight" ? { status: 401, body: { code: "GUARD_DEVICE_REVOKED", message: "revoked", detail: zodDetail() } } : undefined));
    expect((await sync(profile)).code).not.toBe(0);
    expect(registry.calls.filter((call) => call.door === "preflight")).toHaveLength(1);
    const revoked = await status(profile);
    expect([revoked.enrolled, revoked.revoked, revoked.bundleVersion]).toEqual([false, true, undefined]);
    expect(record(await parsed(profile, "device.json")).revoked).toBe(true);
  });

  it("refuses a signed bundle with an unsupported surface control and keeps the verified one", async () => {
    const { signer, registry, profile, envelope } = await pairRig();
    registry.serve({ bundle: envelope("bundle", chatBundle(signer, 2, "v1", { surfaceBlocks: { "chatgpt-web": true } })), catalogue: null });
    expect((await sync(profile)).code).toBe(0);
    const before = await bytesOf(profile, CHECKPOINT);
    registry.serve({ bundle: envelope("bundle", chatBundle(signer, 3, "v1", { surfaceBlocks: { "gemini-web": true } })), catalogue: null });
    expect((await sync(profile)).code).not.toBe(0);
    expect(await bytesOf(profile, CHECKPOINT)).toEqual(before);
    expect((await status(profile)).bundleVersion).toBe(2);
    expect(record(record(record(await parsed(profile, CHECKPOINT)).bundle).bundle).surfaceBlocks).toEqual({ "chatgpt-web": true });
  });
});

describe("enrolment against a registry the system does not trust", () => {
  it("refuses a registry whose certificate is not trusted, and an enrolment the registry refuses", async () => {
    const certificate = await selfSignedCertificate(suite.cleanup, "IP:127.0.0.1");
    let requests = 0;
    const server = https.createServer({ cert: certificate.cert, key: certificate.key }, (_request, response) => {
      requests += 1;
      response.writeHead(500).end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    suite.cleanup.defer(async () => {
      server.closeAllConnections();
      server.close();
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("the TLS registry has no port");
    const dataDir = await tempDir(suite.cleanup, "untrusted");
    const result = await runAgentCommand(suite.binary(), ["enrol", "--server", `https://127.0.0.1:${address.port}`, "--token", `genr_${"1".repeat(32)}`], { dataDir });
    expect(result.code).not.toBe(0);
    expect(requests).toBe(0);
    await expect(stat(path.join(dataDir, "device.json"))).rejects.toMatchObject({ code: "ENOENT" });

    const registry = await startFakeRegistry(suite.cleanup, createSigner());
    registry.override((call) => (call.door === "enrol" ? { status: 401, body: { code: "GUARD_TOKEN_INVALID", message: "This enrol token was already used." } } : undefined));
    const replayDir = await tempDir(suite.cleanup, "replayed");
    expect((await runAgentCommand(suite.binary(), ["enrol", "--server", registry.url, "--token", `genr_${"2".repeat(32)}`], { dataDir: replayDir })).code).not.toBe(0);
    await expect(stat(path.join(replayDir, "device.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

interface InboxRig {
  readonly signer: PolicySigner;
  readonly registry: FakeRegistry;
  readonly profile: AgentProfile;
  readonly inbox: string;
  uploaded(): Json[];
}

const TEST_AI_SERVICE = { serviceId: "test-ai", name: "Test AI", vendor: "Example", category: "chat", domains: ["ai.example.test"], bundleIds: [], cliNames: [], custom: true };
const TEST_AI = catalogueDocument({ services: [TEST_AI_SERVICE] });

const inboxRig = async (bundle: Json = {}, catalogue: Json = TEST_AI): Promise<InboxRig> => {
  const signer = createSigner();
  const registry = await startFakeRegistry(suite.cleanup, signer);
  const profile = await policyProfile(suite, { signer, serverUrl: registry.url, bundle: { bundleVersion: 7, defaultAction: "block", ...bundle }, catalogue });
  return {
    signer,
    registry,
    profile,
    inbox: file(profile, INBOX),
    uploaded: () => registry.calls.filter((call) => call.door === "eventupload").flatMap((call) => (Array.isArray(record(call.body).events) ? (record(call.body).events as unknown[]).map(record) : [])),
  };
};

const inboxRow = (eventId: string, changes: Json = {}): Json => ({
  eventId,
  occurredAt: new Date().toISOString(),
  kind: "flow",
  action: "blocked",
  serviceId: "test-ai",
  host: "ai.example.test",
  port: 443,
  ruleKind: "default",
  bundleVersion: 7,
  ...changes,
});
const line = (row: Json): string => `${JSON.stringify(row)}\n`;

describe("the extension inbox", () => {
  it("takes a complete new row once, waits for a partial one, shows it locally without a popup, and never replays it", async () => {
    const rig = await inboxRig();
    const agent = await startRunning(suite, rig.profile);
    const syncs = (): number => rig.registry.calls.filter((call) => call.door === "postflight").length;
    const afterSyncs = async (count: number): Promise<void> => {
      const target = syncs() + count;
      while (syncs() < target) await delay(100);
    };
    await afterSyncs(1);
    const stream = await decisions(agent);
    suite.cleanup.defer(async () => stream.close());
    const row = line(inboxRow("gev_0000000000000001"));
    await writeFile(rig.inbox, row.slice(0, -1), { mode: 0o600 });
    await afterSyncs(2);
    expect(rig.uploaded()).toEqual([]);
    await appendFile(rig.inbox, "\n");
    await afterSyncs(2);
    const uploaded = rig.uploaded();
    expect(uploaded.map((event) => [event.eventId, event.reason, event.app])).toEqual([["gev_0000000000000001", "extension-flow", undefined]]);
    const activity = await activityRows(agent);
    expect(activity.map((event) => event.enforced)).toEqual([true]);
    expect((await local(agent, "/blocked/gev_0000000000000001")).status).toBe(200);
    expect(stream.messages.filter((message) => message.name === "decision")).toEqual([]);
    await appendFile(rig.inbox, row);
    await afterSyncs(2);
    expect(rig.uploaded()).toHaveLength(1);
    expect(await activityRows(agent)).toHaveLength(1);
  });

  it("skips rows written before its first sync and refuses a truncated or replaced inbox", async () => {
    const rig = await inboxRig();
    await writeFile(rig.inbox, line(inboxRow("gev_0000000000000002")), { mode: 0o600 });
    expect((await sync(rig.profile)).code).toBe(0);
    expect(rig.uploaded()).toEqual([]);
    await truncate(rig.inbox, 0);
    expect((await sync(rig.profile)).code).not.toBe(0);
    await rm(rig.inbox);
    await writeFile(rig.inbox, "{}\n", { mode: 0o600 });
    expect((await sync(rig.profile)).code).not.toBe(0);
  });

  it("queues a row once even when it stopped between queueing and saving its cursor", async () => {
    const rig = await inboxRig();
    rig.registry.override((call) => (call.door === "eventupload" ? { status: 200, body: { accepted: 0, rejected: [] } } : undefined));
    expect((await sync(rig.profile)).code).toBe(0);
    const cursor = await bytesOf(rig.profile, CURSOR);
    await writeFile(rig.inbox, line(inboxRow("gev_0000000000000003")), { mode: 0o600 });
    await sync(rig.profile);
    expect((await queuedEvents(rig.profile.dataDir)).map((event) => event.eventId)).toEqual(["gev_0000000000000003"]);
    await writeFile(file(rig.profile, CURSOR), cursor, { mode: 0o600 });
    await sync(rig.profile);
    expect((await queuedEvents(rig.profile.dataDir)).map((event) => event.eventId)).toEqual(["gev_0000000000000003"]);
  });

  it("refuses a linked, readable-by-others or oversized inbox", async () => {
    for (const kind of ["symlink", "public", "oversize"] as const) {
      const rig = await inboxRig();
      expect((await sync(rig.profile)).code, kind).toBe(0);
      if (kind === "symlink") {
        const target = file(rig.profile, "target");
        await writeFile(target, "{}\n", { mode: 0o600 });
        await symlink(target, rig.inbox);
      }
      if (kind === "public") {
        await writeFile(rig.inbox, "{}\n");
        await chmod(rig.inbox, 0o644);
      }
      if (kind === "oversize") await writeFile(rig.inbox, Buffer.alloc(64 * 1024), { mode: 0o600 });
      expect((await sync(rig.profile)).code, kind).not.toBe(0);
    }
  });

  it("drops rows it cannot trust and keeps the valid row after them", async () => {
    const rig = await inboxRig();
    expect((await sync(rig.profile)).code).toBe(0);
    await writeFile(rig.inbox, [line({ ...inboxRow("gev_0000000000000004"), snippet: "must not upload" }), "malformed\n", line(inboxRow("gev_0000000000000005"))].join(""), { mode: 0o600 });
    expect((await sync(rig.profile)).code).toBe(0);
    expect(rig.uploaded().map((event) => event.eventId)).toEqual(["gev_0000000000000005"]);
    expect(JSON.stringify(rig.uploaded())).not.toContain("must not upload");
  });

  it("drops a row for a disabled service, a monitor-mode policy or a stale bundle", async () => {
    const disabled = catalogueDocument({ services: [{ ...TEST_AI_SERVICE, enabled: false }] });
    for (const [name, eventId, bundle, catalogue] of [
      ["disabled service", "gev_0000000000000011", {}, disabled],
      ["monitor", "gev_0000000000000012", { clientMode: "monitor" }, TEST_AI],
      ["stale bundle", "gev_0000000000000013", { bundleVersion: 8 }, TEST_AI],
    ] as const) {
      const rig = await inboxRig(bundle, catalogue);
      expect((await sync(rig.profile)).code, name).toBe(0);
      await writeFile(rig.inbox, line(inboxRow(eventId)), { mode: 0o600 });
      expect((await sync(rig.profile)).code, name).toBe(0);
      expect(rig.uploaded(), name).toEqual([]);
    }
  });

  it("keeps an ask from the policy, strips the app name and refuses process details", async () => {
    const rig = await inboxRig({ services: { "test-ai": { action: "ask", ruleId: "gsr_12345678" } } });
    expect((await sync(rig.profile)).code).toBe(0);
    const ask = { action: "asked", ruleKind: "service", ruleId: "gsr_12345678" };
    await writeFile(
      rig.inbox,
      line(inboxRow("gev_0000000000000020", { ...ask, app: { bundleId: "com.example.Browser" } })) + line(inboxRow("gev_0000000000000021", { ...ask, app: { bundleId: "com.example.Browser", pid: 123 } })),
      { mode: 0o600 },
    );
    expect((await sync(rig.profile)).code).toBe(0);
    expect(rig.uploaded().map((event) => [event.eventId, event.action, event.app])).toEqual([["gev_0000000000000020", "asked", undefined]]);
  });

  it("still takes a verified policy when the inbox cursor is corrupt, but holds back the upload", async () => {
    const rig = await inboxRig();
    rig.registry.override((call) => (call.door === "eventupload" ? { status: 200, body: { accepted: 0, rejected: [] } } : undefined));
    expect((await sync(rig.profile)).code).toBe(0);
    await writeFile(rig.inbox, line(inboxRow("gev_0000000000000006")), { mode: 0o600 });
    await sync(rig.profile);
    expect(await queuedEvents(rig.profile.dataDir)).toHaveLength(1);
    rig.registry.override(undefined);
    await writeFile(file(rig.profile, CURSOR), "corrupt", { mode: 0o600 });
    rig.registry.serve({ bundle: signEnvelope(rig.signer, "bundle", bundleDocument(rig.signer, { bundleVersion: 8, defaultAction: "block" })), catalogue: null });
    const before = rig.registry.calls.length;
    expect((await sync(rig.profile)).code).not.toBe(0);
    expect(rig.registry.calls.slice(before).map((call) => call.door)).toEqual(["preflight", "ruledownload", "postflight"]);
    expect(await queuedEvents(rig.profile.dataDir)).toHaveLength(1);
    expect((await status(rig.profile)).bundleVersion).toBe(8);
  });

  it("uploads a contract-valid inbox row and keeps it until the registry acknowledges it", async () => {
    for (const acknowledged of [true, false]) {
      const rig = await inboxRig();
      rig.registry.override((call) => (call.door === "eventupload" ? { status: 200, body: { accepted: acknowledged ? 1 : 0, rejected: [] } } : undefined));
      expect((await sync(rig.profile)).code).toBe(0);
      const row = inboxRow("gev_0000000000000007");
      await writeFile(rig.inbox, line(row), { mode: 0o600 });
      const result = await sync(rig.profile);
      const uploads = rig.registry.calls.filter((call) => call.door === "eventupload");
      expect(uploads).toHaveLength(1);
      const body = GuardEventUploadRequest.parse(uploads[0]?.body);
      expect(body.events.map((event) => [event.eventId, event.occurredAt, event.action, event.reason, event.app])).toEqual([["gev_0000000000000007", row.occurredAt, "blocked", "extension-flow", undefined]]);
      expect((await queuedEvents(rig.profile.dataDir)).length, String(acknowledged)).toBe(acknowledged ? 0 : 1);
      expect(result.code === 0, String(acknowledged)).toBe(acknowledged);
      if (acknowledged) {
        expect((await sync(rig.profile)).code).toBe(0);
        expect(rig.registry.calls.filter((call) => call.door === "eventupload")).toHaveLength(1);
      }
    }
  });
});
