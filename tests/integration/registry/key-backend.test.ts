import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GuardRuleDownloadResponse, GuardSigningKeyResponse } from "@vibtra/guard-contract";
import { generateGuardSigningKey, verifyGuardBundle } from "@vibtra/guard-contract/signing";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import type { RegistryEnterprise } from "@vibtra/registry/src/enterprise.ts";
import { createLocalSigner } from "@vibtra/registry/src/guard/local-signer.ts";
import type { GuardSigningKeyRefStore } from "@vibtra/registry/src/guard/store.ts";
import { createRegistryServer } from "@vibtra/registry/src/server.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { createSealerRing } from "@vibtra/registry/src/vault/sealer-ring.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, type Configure, type Storage, withHosted } from "./server-options.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_MAIN = path.join(REPO, "apps", "registry", "src", "main.ts");
const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_E = "e".repeat(64);

const baseEnv: NodeJS.ProcessEnv = {
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "http://localhost:4700",
  REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
  REGISTRY_GATE_SIGNING_SECRET: "guard-tests-gate-secret-0123456789abcdef0123456",
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  NODE_ENV: "test",
};

const enterpriseWith = (extra: Partial<RegistryEnterprise>, licensed = true): RegistryEnterprise => ({
  status: { licensed, features: [], ...(licensed ? {} : { reason: "made-up licence expired" }) },
  available: () => (licensed ? { ok: true } : { ok: false, reason: "made-up licence expired" }),
  ...extra,
});

const enterpriseBackend: Configure = withHosted((hosted) => ({ ...hosted, keyBackend: "enterprise" }));

const refusedStart = async (enterprise: RegistryEnterprise | undefined): Promise<string> => {
  const options = enterpriseBackend({
    config: {
      mode: "hosted",
      hosted: {
        baseUrl: "http://registry.test.local",
        sessionSecret: "guard-tests-session-secret-0123456789abcdef0123",
        oidc: { issuer: "https://accounts.google.com", clientId: "guard-tests-client-id.apps.example", clientSecret: "guard-tests-client-secret-not-real" },
        testAuth: true,
        vaultKey: KEY_A,
      },
    },
    ...(enterprise === undefined ? {} : { enterprise }),
  });
  const started = await createRegistryServer(options).then(
    async (server) => {
      await server.app.close();
      return "started";
    },
    (error: unknown) => (error instanceof Error ? `${error.message} — ${(error as { detail?: string }).detail ?? ""}` : String(error)),
  );
  return started;
};

const onShared =
  (shared: Storage, vaultKey: string): Configure =>
  (options) => {
    const { databaseUrl: _own, ...config } = required(options.config, "a configuration");
    const hosted = required(config.hosted, "a hosted configuration");
    return { ...options, dataDir: shared.dataDir, config: { ...config, ...(shared.databaseUrl === undefined ? {} : { databaseUrl: shared.databaseUrl }), hosted: { ...hosted, vaultKey } } };
  };

const download = async (registry: TestRegistry, laptop: EnrolledDevice) => {
  const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
  expect(reply.status, reply.text).toBe(200);
  return required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle on a first download");
};

describe("the key backend", () => {
  it("reads VIBTRA_KEY_BACKEND as local or enterprise, defaults to local, and refuses anything else", () => {
    expect(loadRegistryConfig(baseEnv).hosted?.keyBackend).toBeUndefined();
    expect(loadRegistryConfig({ ...baseEnv, VIBTRA_KEY_BACKEND: "local" }).hosted?.keyBackend).toBe("local");
    expect(loadRegistryConfig({ ...baseEnv, VIBTRA_KEY_BACKEND: " enterprise " }).hosted?.keyBackend).toBe("enterprise");
    expect(() => loadRegistryConfig({ ...baseEnv, VIBTRA_KEY_BACKEND: "kms" })).toThrow("Invalid registry configuration");
  });

  it("refuses VIBTRA_KEY_BACKEND outside hosted mode, set to any value", () => {
    for (const env of [{ VIBTRA_KEY_BACKEND: "local" }, { REGISTRY_MODE: "single", VIBTRA_KEY_BACKEND: "enterprise" }, { VIBTRA_KEY_BACKEND: "" }]) {
      expect(() => loadRegistryConfig(env), JSON.stringify(env)).toThrow("VIBTRA_KEY_BACKEND is set but REGISTRY_MODE is not hosted");
    }
  });

  it("refuses to start with VIBTRA_KEY_BACKEND=enterprise when ee/ is not loaded, not licensed, or provides no key backend", async () => {
    const sealer = createVaultSealer(KEY_E);
    expect(await refusedStart(undefined)).toMatch(/^VIBTRA_KEY_BACKEND=enterprise, but the enterprise key backend is not available — the ee\/ module is not loaded\. This registry refuses to start rather than fall back to local keys/);
    expect(await refusedStart(enterpriseWith({ guardSigner: ({ local }) => local, vaultSealer: () => sealer }, false))).toMatch(
      /the ee\/ module is not licensed: made-up licence expired/,
    );
    expect(await refusedStart(enterpriseWith({}))).toMatch(/the ee\/ module provides no guardSigner or no vaultSealer factory/);
    expect(await refusedStart(enterpriseWith({ vaultSealer: () => sealer }))).toMatch(/provides no guardSigner or no vaultSealer factory/);
    expect(await refusedStart(enterpriseWith({ guardSigner: ({ local }) => local }))).toMatch(/provides no guardSigner or no vaultSealer factory/);
  });

  it("builds ee/'s sealer from the local one, hands its signer a LocalSigner over that sealer, and shows it signing-key refs without sealed keys", async () => {
    const sealer = createVaultSealer(KEY_E);
    const handed: { localSealerKeyId?: string | undefined; refs?: GuardSigningKeyRefStore } = {};
    const enterprise = enterpriseWith({
      vaultSealer: ({ localSealer }) => {
        handed.localSealerKeyId = localSealer?.keyId;
        return sealer;
      },
      guardSigner: ({ local, signingKeys }) => {
        handed.refs = signingKeys;
        return local;
      },
    });
    const registry = await startRegistry({ domain: "key-backend-ee.example", configure: (options) => ({ ...enterpriseBackend(options), enterprise }) });
    try {
      expect(handed.localSealerKeyId).toBe(createVaultSealer(KEY_A).keyId);
      expect(registry.server.vaultSealer?.keyId).toBe(sealer.keyId);
      const laptop = await enrolDevice(registry, registry.people.owner, registry.people.member, "ee-key-mbp");
      const signing = await agentDoor(registry, "GET", `/signing/${laptop.deviceId}`, laptop.token);
      expect(GuardSigningKeyResponse.parse(signing.body).signing).toEqual(laptop.enrol.signing);
      expect(await createLocalSigner({ store: required(registry.server.service.guard, "the guard store"), sealer, now: () => new Date() }).publicKey(laptop.enrol.orgId)).toEqual({
        keyId: laptop.enrol.signing.keyId,
        publicKeyPem: laptop.enrol.signing.publicKeyPem,
      });
      const refs = required(handed.refs, "the signing-key refs");
      const ref = required(await refs.getSigningKey(laptop.enrol.orgId), "the org's signing-key ref");
      expect(ref).toEqual({ keyId: laptop.enrol.signing.keyId, orgId: laptop.enrol.orgId, publicKeyPem: laptop.enrol.signing.publicKeyPem, backend: "local", keyRef: null, createdAt: expect.any(String) });
      expect(Object.keys(ref)).not.toContain("sealedPrivateKey");
      const fresh = generateGuardSigningKey();
      await expect(
        refs.putSigningKeyIfAbsent({ keyId: fresh.keyId, orgId: "org_made_up", publicKeyPem: fresh.publicKeyPem, backend: "local", keyRef: null, createdAt: new Date().toISOString() }),
      ).rejects.toMatchObject({ code: "INTERNAL" });
      expect(await refs.getSigningKey("org_made_up")).toBeUndefined();
    } finally {
      await registry.close();
    }
  });

  it("builds the ciphertext tripwire from the configured sealer's envelope prefixes, keeps vault.v1. covered, and no longer knows bao.v1.", async () => {
    const kms = { ...createVaultSealer(KEY_E), envelopePrefix: "kms.v1.", envelopePrefixes: ["kms.v1."] };
    const enterprise = enterpriseWith({ vaultSealer: () => kms, guardSigner: ({ local }) => local });
    const registry = await startRegistry({ domain: "key-tripwire.example", configure: (options) => ({ ...enterpriseBackend(options), enterprise }) });
    try {
      const { owner } = registry.people;
      for (const [name, status] of [
        ["kms.v1.key-tripwire-probe", 500],
        ["vault.v1.key-tripwire-probe", 500],
        ["bao.v1.key-tripwire-probe", 200],
        ["Key Tripwire", 200],
      ] as const) {
        const renamed = await registry.consoleWrite(owner, "POST", "/org/name", { name });
        expect(renamed.status, `${name}: ${renamed.text}`).toBe(status);
        if (status === 500) expect(renamed.body).toMatchObject({ code: "INTERNAL", message: "Refusing to send this response" });
      }
    } finally {
      await registry.close();
    }
    const malformed = { ...createVaultSealer(KEY_E), envelopePrefixes: ["vault.v1.", ""] };
    expect(await refusedStart(enterpriseWith({ vaultSealer: () => malformed, guardSigner: ({ local }) => local }))).toMatch(
      /^The vault sealer declares an envelope prefix the ciphertext tripwire cannot use — got ""/,
    );
  });

  it("cuts over from the local vault key to an ee/ primary sealer, and keeps signing with the same key once the local vault key is gone", { timeout: 120_000 }, async () => {
    let storage: Storage | undefined;
    const first = await startRegistry({ domain: "key-cutover.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const laptop = await enrolDevice(first, first.people.owner, first.people.member, "cutover-mbp");
      const shared = required(storage, "the captured storage");
      const primary = createVaultSealer(KEY_E);
      const ringed = enterpriseWith({
        vaultSealer: ({ localSealer }) => createSealerRing(primary, [required(localSealer, "the local sealer")]),
        guardSigner: ({ local }) => local,
      });
      const second = await startRegistry({ domain: "key-cutover-second.example", configure: (options) => ({ ...enterpriseBackend(onShared(shared, KEY_A)(options)), enterprise: ringed }) });
      try {
        const signing = await agentDoor(second, "GET", `/signing/${laptop.deviceId}`, laptop.token);
        expect(GuardSigningKeyResponse.parse(signing.body).signing).toEqual(laptop.enrol.signing);
        const counts = await required(second.server.service.guard, "the guard store").resealAll(required(second.server.vaultSealer, "the ee sealer"));
        expect(counts).toMatchObject({ scanned: 1, stale: 1, current: 0, unreadable: 0 });
      } finally {
        await second.close();
      }

      const primaryOnly = enterpriseWith({ vaultSealer: () => primary, guardSigner: ({ local }) => local });
      const third = await startRegistry({ domain: "key-cutover-third.example", configure: (options) => ({ ...enterpriseBackend(onShared(shared, KEY_B)(options)), enterprise: primaryOnly }) });
      try {
        const signing = await agentDoor(third, "GET", `/signing/${laptop.deviceId}`, laptop.token);
        expect(signing.status, signing.text).toBe(200);
        const key = GuardSigningKeyResponse.parse(signing.body).signing;
        expect(key).toEqual(laptop.enrol.signing);
        expect(verifyGuardBundle(await download(third, laptop), key.publicKeyPem, key.keyId, laptop.deviceId)).toMatchObject({ ok: true });
      } finally {
        await third.close();
      }
    } finally {
      await first.close();
    }
  });
});

describe("OpenBao", () => {
  it("refuses to start while any OPENBAO_* variable is set, set to a value or empty, and names them without echoing a value", () => {
    for (const env of [{ OPENBAO_ADDR: "https://bao.example:8200" }, { OPENBAO_SECRET_ID: "made-up-secret-id", OPENBAO_ROLE_ID: "made-up-role" }, { OPENBAO_NAMESPACE_PREFIX: "" }]) {
      let refusal: { message?: string; detail?: string } = {};
      try {
        loadRegistryConfig({ ...baseEnv, ...env });
      } catch (error) {
        refusal = error as typeof refusal;
      }
      expect(refusal.message).toBe("OpenBao support was removed; unset OPENBAO_*");
      expect(refusal.detail).toContain(Object.keys(env).sort().join(", "));
      for (const value of Object.values(env).filter((v) => v !== "")) expect(refusal.detail).not.toContain(value);
    }
  });
});

const runCli = (args: readonly string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", REGISTRY_MAIN, ...args], { cwd: REPO, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

describe("vibtra-registry reseal", () => {
  it("moves every Guard signing key onto a new vault key, and the registry still signs with the same keys once the old vault key is gone", { timeout: 180_000 }, async () => {
    let storage: Storage | undefined;
    const first = await startRegistry({ domain: "reseal-signing.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const laptop = await enrolDevice(first, first.people.owner, first.people.member, "reseal-mbp");
      const shared = required(storage, "the captured storage");
      const result = await runCli(["reseal"], {
        PATH: process.env.PATH,
        HOME: shared.dataDir,
        ...baseEnv,
        VIBTRA_REGISTRY_DATA_DIR: shared.dataDir,
        ...(shared.databaseUrl === undefined ? {} : { DATABASE_URL: shared.databaseUrl }),
        VIBTRA_VAULT_KEY: KEY_B,
        VIBTRA_VAULT_KEY_PREVIOUS: KEY_A,
      });
      expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Guard signing keys: 1 scanned, 1 re-sealed, 0 already current, 0 unreadable");
      expect(result.stdout).toMatch(/verification: vault key ring: current \w+, previous \w+ — all .* and 1 Guard signing key are sealed under the current key/);

      const second = await startRegistry({
        domain: "reseal-signing-second.example",
        configure: onShared(shared, KEY_B),
      });
      try {
        const signing = await agentDoor(second, "GET", `/signing/${laptop.deviceId}`, laptop.token);
        expect(signing.status, signing.text).toBe(200);
        const key = GuardSigningKeyResponse.parse(signing.body).signing;
        expect(key).toEqual(laptop.enrol.signing);
        expect(verifyGuardBundle(await download(second, laptop), key.publicKeyPem, key.keyId, laptop.deviceId)).toMatchObject({ ok: true });
      } finally {
        await second.close();
      }
    } finally {
      await first.close();
    }
  });
});
