import { verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateGuardSigningKey } from "@vibtra/guard-contract/signing";
import { createLocalSigner } from "@vibtra/registry/src/guard/local-signer.ts";
import { createMemoryGuardStore, type GuardSigningKeyRow, type GuardSigningKeyStore } from "@vibtra/registry/src/guard/store.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";

const SEALER = createVaultSealer("b".repeat(64));
const INPUT = Buffer.from("made-up signing input");

const counted = (inner: GuardSigningKeyStore) => {
  const calls = { reads: 0, writes: 0 };
  const store: GuardSigningKeyStore = {
    getSigningKey: async (orgId) => {
      calls.reads += 1;
      return inner.getSigningKey(orgId);
    },
    putSigningKeyIfAbsent: async (row) => {
      calls.writes += 1;
      return inner.putSigningKeyIfAbsent(row);
    },
  };
  return { store, calls };
};

const rawStore = (row: GuardSigningKeyRow): GuardSigningKeyStore => ({
  getSigningKey: async () => row,
  putSigningKeyIfAbsent: async () => row,
});

const sealedRow = (orgId: string, overrides: Partial<GuardSigningKeyRow> = {}): GuardSigningKeyRow => {
  const key = generateGuardSigningKey();
  return {
    keyId: key.keyId,
    orgId,
    publicKeyPem: key.publicKeyPem,
    sealedPrivateKey: SEALER.seal(key.privateKeyPem, { orgId, connectionId: key.keyId }),
    backend: "local",
    keyRef: null,
    createdAt: "2026-11-17T00:00:00.000Z",
    ...overrides,
  };
};

const refusal = { name: "VibtraError", code: "INTERNAL", message: "Something went wrong" };

describe("the LocalSigner", () => {
  it("reads an organisation's key from the store once per signer, however many times it signs", async () => {
    const { store, calls } = counted(createMemoryGuardStore());
    const signer = createLocalSigner({ store, sealer: SEALER, now: () => new Date() });
    const first = await signer.publicKey("org_cached");
    for (let i = 0; i < 3; i += 1) {
      expect((await signer.sign("org_cached", () => INPUT)).keyId).toBe(first.keyId);
      expect(await signer.publicKey("org_cached")).toEqual(first);
    }
    expect(calls).toEqual({ reads: 1, writes: 1 });
  });

  it("does not generate or write a key for an organisation that already has one", async () => {
    const shared = createMemoryGuardStore();
    const stored = await createLocalSigner({ store: shared, sealer: SEALER, now: () => new Date() }).publicKey("org_existing");
    const { store, calls } = counted(shared);
    const signed = await createLocalSigner({ store, sealer: SEALER, now: () => new Date() }).sign("org_existing", () => INPUT);
    expect(signed.keyId).toBe(stored.keyId);
    expect(verify("sha256", INPUT, { key: stored.publicKeyPem, dsaEncoding: "ieee-p1363" }, signed.signature)).toBe(true);
    expect(calls).toEqual({ reads: 1, writes: 0 });
  });

  it("stamps a key it creates with the clock it was given", async () => {
    const store = createMemoryGuardStore();
    const created = new Date("2026-11-17T09:30:00.000Z");
    const { keyId } = await createLocalSigner({ store, sealer: SEALER, now: () => created }).publicKey("org_clock");
    expect(await store.getSigningKey("org_clock")).toMatchObject({ keyId, orgId: "org_clock", backend: "local", keyRef: null, createdAt: created.toISOString() });
  });

  it("refuses a row another backend claims even when it carries a sealed key, and never asks for the signing input", async () => {
    const row = sealedRow("org_claimed", { backend: "kms", keyRef: "made-up-key-ref" });
    const signer = createLocalSigner({ store: rawStore(row), sealer: SEALER, now: () => new Date() });
    let asked = 0;
    const attempt = signer.sign("org_claimed", () => {
      asked += 1;
      return INPUT;
    });
    await expect(attempt).rejects.toMatchObject({ ...refusal, detail: expect.stringContaining(`org org_claimed's Guard signing key ${row.keyId} is held by the kms key backend`) });
    await expect(signer.publicKey("org_claimed")).rejects.toMatchObject(refusal);
    expect(asked).toBe(0);
  });

  it("refuses a local row without a sealed key with the generic message, not a crash in the sealer", async () => {
    const row = sealedRow("org_unsealed", { sealedPrivateKey: null });
    const signer = createLocalSigner({ store: rawStore(row), sealer: SEALER, now: () => new Date() });
    await expect(signer.publicKey("org_unsealed")).rejects.toMatchObject({ ...refusal, detail: expect.stringContaining("VIBTRA_KEY_BACKEND=enterprise") });
  });
});
