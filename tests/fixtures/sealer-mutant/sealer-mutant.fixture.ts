import type { SyncVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { describeVaultSealerContract } from "../../contracts/vault-sealer.ts";

const modulePath = process.env.VIBTRA_VAULT_SEAL_MODULE;
if (modulePath === undefined || modulePath === "") throw new Error("set VIBTRA_VAULT_SEAL_MODULE to the vault seal module under test");
const { createVaultSealer } = (await import(modulePath)) as { createVaultSealer: (rawKey: string, rawPrevious?: readonly string[]) => SyncVaultSealer };

describeVaultSealerContract("vault seal module under test", async () => ({
  sealer: createVaultSealer("b".repeat(64), ["a".repeat(64)]),
  older: createVaultSealer("a".repeat(64)),
  stranger: createVaultSealer("c".repeat(64)),
}));
