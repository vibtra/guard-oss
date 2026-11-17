import type { GuardSigner } from "@vibtra/guard-contract/signing";
import { createMemoryGuardStore, type GuardSigningKeyStore } from "@vibtra/registry/src/guard/store.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import type { LocalSignerOptions } from "@vibtra/registry/src/guard/local-signer.ts";
import { describeGuardSignerContract } from "../../contracts/guard-signer.ts";

const modulePath = process.env.VIBTRA_LOCAL_SIGNER_MODULE;
if (modulePath === undefined || modulePath === "") throw new Error("set VIBTRA_LOCAL_SIGNER_MODULE to the LocalSigner module under test");
const { createLocalSigner } = (await import(modulePath)) as { createLocalSigner: (options: LocalSignerOptions) => GuardSigner };

const SEALER = createVaultSealer("b".repeat(64));

describeGuardSignerContract("LocalSigner module under test", async () => {
  const store = createMemoryGuardStore();
  const outages: Error[] = [];
  const flaky: GuardSigningKeyStore = {
    getSigningKey: async (orgId) => {
      const outage = outages.shift();
      if (outage !== undefined) throw outage;
      return store.getSigningKey(orgId);
    },
    putSigningKeyIfAbsent: async (row) => store.putSigningKeyIfAbsent(row),
  };
  return {
    signer: () => createLocalSigner({ store: flaky, sealer: SEALER, now: () => new Date() }),
    failNextLoad: () => {
      const outage = new Error(`made-up store outage ${outages.length + 1}`);
      outages.push(outage);
      return outage;
    },
    close: async () => undefined,
  };
});
