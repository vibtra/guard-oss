import { randomBytes } from "node:crypto";
import { describe } from "vitest";
import { createGuardPostgresStore } from "@vibtra/registry/src/guard/postgres-store.ts";
import { createLocalSigner } from "@vibtra/registry/src/guard/local-signer.ts";
import { createMemoryGuardStore, type GuardSigningKeyStore } from "@vibtra/registry/src/guard/store.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { createSealerRing } from "@vibtra/registry/src/vault/sealer-ring.ts";
import { describeGuardSignerContract, type GuardSignerBackend } from "../../contracts/guard-signer.ts";
import { describeVaultSealerContract } from "../../contracts/vault-sealer.ts";
import { postgresMissing, sqlRows } from "./server-options.ts";

const KEY_A = "a".repeat(64);
const KEY_B = "b".repeat(64);
const KEY_C = "c".repeat(64);
const SEALER = createVaultSealer(KEY_B, [KEY_A]);

const localBackend = (open: () => GuardSigningKeyStore, close: () => Promise<void>): GuardSignerBackend => {
  let failures = 0;
  const flaky = (store: GuardSigningKeyStore): GuardSigningKeyStore => ({
    getSigningKey: async (orgId) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("made-up store outage");
      }
      return store.getSigningKey(orgId);
    },
    putSigningKeyIfAbsent: (row) => store.putSigningKeyIfAbsent(row),
  });
  return {
    signer: () => createLocalSigner({ store: flaky(open()), sealer: SEALER, now: () => new Date() }),
    failNextLoad: () => {
      failures += 1;
    },
    close,
  };
};

describeGuardSignerContract("LocalSigner on the in-memory store", async () => {
  const store = createMemoryGuardStore();
  return localBackend(
    () => store,
    async () => undefined,
  );
});

describe.skipIf(postgresMissing())("on Postgres", () => {
  describeGuardSignerContract("LocalSigner on Postgres, a separate pool per signer", async () => {
    const shared = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
    const schema = `guard_signer_${randomBytes(6).toString("hex")}`;
    await sqlRows(shared, `CREATE SCHEMA ${schema}`);
    const databaseUrl = `${shared}${shared.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
    const pools = [createPostgresRegistryStores(databaseUrl)];
    await pools[0]?.migrate();
    return localBackend(
      () => {
        const stores = createPostgresRegistryStores(databaseUrl);
        pools.push(stores);
        return createGuardPostgresStore(stores.pool);
      },
      async () => {
        await Promise.all(pools.map((stores) => stores.close()));
        await sqlRows(shared, `DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      },
    );
  });
});

describeVaultSealerContract("the vault key with a previous key", async () => ({
  sealer: createVaultSealer(KEY_B, [KEY_A]),
  older: createVaultSealer(KEY_A),
  stranger: createVaultSealer(KEY_C),
}));

describeVaultSealerContract("a sealer ring with a decrypt-only member", async () => ({
  sealer: createSealerRing(createVaultSealer(KEY_B), [createVaultSealer(KEY_A)]),
  older: createVaultSealer(KEY_A),
  stranger: createVaultSealer(KEY_C),
}));
