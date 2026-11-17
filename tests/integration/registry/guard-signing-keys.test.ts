import { randomBytes, verify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { generateGuardSigningKey } from "@vibtra/guard-contract/signing";
import { createLocalSigner } from "@vibtra/registry/src/guard/local-signer.ts";
import { createGuardPostgresStore } from "@vibtra/registry/src/guard/postgres-store.ts";
import { createFileGuardStore, createMemoryGuardStore, type GuardSigningKeyRow, type GuardSigningKeyStore, parseSigningKeyRow } from "@vibtra/registry/src/guard/store.ts";
import { createPostgresRegistryStores, type PostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { postgresMissing, sqlRows } from "./server-options.ts";

const SEALER = createVaultSealer("b".repeat(64));
const INPUT = Buffer.from("made-up signing input");
const KMS_REF = "arn:aws:kms:eu-west-2:000000000000:key/made-up";

const localRow = (orgId: string): { row: GuardSigningKeyRow; privateKeyPem: string } => {
  const key = generateGuardSigningKey();
  return {
    privateKeyPem: key.privateKeyPem,
    row: {
      keyId: key.keyId,
      orgId,
      publicKeyPem: key.publicKeyPem,
      sealedPrivateKey: SEALER.seal(key.privateKeyPem, { orgId, connectionId: key.keyId }),
      backend: "local",
      keyRef: null,
      createdAt: "2026-11-17T00:00:00.000Z",
    },
  };
};

const signsWith = async (store: GuardSigningKeyStore, row: Pick<GuardSigningKeyRow, "orgId" | "keyId" | "publicKeyPem">): Promise<void> => {
  const signed = await createLocalSigner({ store, sealer: SEALER, now: () => new Date() }).sign(row.orgId, () => INPUT);
  expect(signed.keyId).toBe(row.keyId);
  expect(verify("sha256", INPUT, { key: row.publicKeyPem, dsaEncoding: "ieee-p1363" }, signed.signature)).toBe(true);
};

describe("a Guard signing-key row", () => {
  it("is refused unless a local row carries a sealed key and no key ref, and any other backend the reverse", () => {
    const { row } = localRow("org_mixed");
    expect(parseSigningKeyRow(row)).toEqual(row);
    expect(parseSigningKeyRow({ ...row, backend: "kms", sealedPrivateKey: null, keyRef: KMS_REF })).toMatchObject({ backend: "kms", keyRef: KMS_REF });
    for (const mixed of [
      { ...row, keyRef: KMS_REF },
      { ...row, sealedPrivateKey: null },
      { ...row, sealedPrivateKey: null, keyRef: KMS_REF },
      { ...row, backend: "kms" },
      { ...row, backend: "kms", keyRef: KMS_REF },
      { ...row, backend: "kms", sealedPrivateKey: null },
    ]) {
      expect(() => parseSigningKeyRow(mixed), JSON.stringify({ backend: mixed.backend, sealed: mixed.sealedPrivateKey !== null, keyRef: mixed.keyRef })).toThrow();
    }
  });

  it("held by another backend is refused by the LocalSigner for both its public key and a signature, before it asks for the signing input", async () => {
    const { row } = localRow("org_kms");
    const store = createMemoryGuardStore();
    await store.putSigningKeyIfAbsent({ ...row, backend: "kms", sealedPrivateKey: null, keyRef: KMS_REF });
    const signer = createLocalSigner({ store, sealer: SEALER, now: () => new Date() });
    await expect(signer.publicKey("org_kms")).rejects.toMatchObject({ code: "INTERNAL", detail: expect.stringContaining("held by the kms key backend") });
    let asked = 0;
    await expect(
      signer.sign("org_kms", () => {
        asked += 1;
        return INPUT;
      }),
    ).rejects.toMatchObject({ code: "INTERNAL", detail: expect.stringContaining("held by the kms key backend") });
    expect(asked).toBe(0);
    expect(await store.getSigningKey("org_kms")).toMatchObject({ keyId: row.keyId, backend: "kms" });
  });

  it("written by the JSON file store before key backends existed reads as local, and the LocalSigner signs with it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "guard-legacy-keys-"));
    try {
      const { row } = localRow("org_legacy");
      const { backend: _backend, keyRef: _keyRef, ...legacy } = row;
      const file = path.join(dir, "guard.json");
      await writeFile(file, JSON.stringify({ signingKeys: { org_legacy: legacy } }));
      const store = await createFileGuardStore(file);
      expect(await store.getSigningKey("org_legacy")).toEqual(row);
      await signsWith(store, row);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const withSchema = async (run: (stores: PostgresRegistryStores) => Promise<void>): Promise<void> => {
  const shared = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
  const schema = `guard_keys_${randomBytes(6).toString("hex")}`;
  await sqlRows(shared, `CREATE SCHEMA ${schema}`);
  const stores = createPostgresRegistryStores(`${shared}${shared.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`);
  try {
    await stores.migrate();
    await run(stores);
  } finally {
    await stores.close();
    await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
};

const INSERT = "INSERT INTO guard_org_signing_keys (key_id, org_id, status, public_key_pem, sealed_private_key, created_at, backend, key_ref) VALUES ($1, $2, 'active', $3, $4, $5, $6, $7)";

describe.skipIf(postgresMissing())("guard_org_signing_keys on Postgres", () => {
  it("refuses a kms row that carries a sealed key and a local row that carries a key ref", async () => {
    await withSchema(async ({ pool }) => {
      const { row } = localRow("org_check");
      await expect(pool.query(INSERT, [row.keyId, row.orgId, row.publicKeyPem, row.sealedPrivateKey, row.createdAt, "kms", KMS_REF])).rejects.toThrow(/check constraint/);
      await expect(pool.query(INSERT, [row.keyId, row.orgId, row.publicKeyPem, row.sealedPrivateKey, row.createdAt, "local", KMS_REF])).rejects.toThrow(/check constraint/);
      await expect(pool.query(INSERT, [row.keyId, row.orgId, row.publicKeyPem, null, row.createdAt, "local", null])).rejects.toThrow(/check constraint/);
      await pool.query(INSERT, [row.keyId, row.orgId, row.publicKeyPem, row.sealedPrivateKey, row.createdAt, "local", null]);
    });
  });

  it("keeps a row written under 0114 valid after 0115, read as local with no key ref, and the LocalSigner signs with it", async () => {
    await withSchema(async (stores) => {
      const { pool } = stores;
      await pool.query(`
        ALTER TABLE guard_org_signing_keys DROP CONSTRAINT guard_org_signing_keys_backend_material;
        ALTER TABLE guard_org_signing_keys DROP COLUMN backend;
        ALTER TABLE guard_org_signing_keys DROP COLUMN key_ref;
        ALTER TABLE guard_org_signing_keys ALTER COLUMN sealed_private_key SET NOT NULL;
        DELETE FROM registry_migrations WHERE name = '0115_guard_signing_key_backend.sql';
      `);
      const { row } = localRow("org_0114");
      await pool.query("INSERT INTO guard_org_signing_keys (key_id, org_id, status, public_key_pem, sealed_private_key, created_at) VALUES ($1, $2, 'active', $3, $4, $5)", [
        row.keyId,
        row.orgId,
        row.publicKeyPem,
        row.sealedPrivateKey,
        row.createdAt,
      ]);
      await stores.migrate();
      const store = createGuardPostgresStore(pool);
      expect(await store.getSigningKey("org_0114")).toEqual(row);
      await signsWith(store, row);
    });
  });
});
