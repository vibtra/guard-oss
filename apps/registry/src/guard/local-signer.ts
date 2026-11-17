import { type GuardSigner, type GuardSigningKeyPair, generateGuardSigningKey, signEs256 } from "@vibtra/guard-contract/signing";
import { VibtraError } from "../errors.js";
import type { VaultSealer } from "../vault/seal.js";
import { type GuardSigningKeyStore, LOCAL_KEY_BACKEND } from "./store.js";

export interface LocalSignerOptions {
  store: GuardSigningKeyStore;
  sealer: VaultSealer;
  now: () => Date;
}

export const createLocalSigner = ({ store, sealer, now }: LocalSignerOptions): GuardSigner => {
  const load = async (orgId: string): Promise<GuardSigningKeyPair> => {
    let row = await store.getSigningKey(orgId);
    if (row === undefined) {
      const fresh = generateGuardSigningKey();
      const sealedPrivateKey = await sealer.seal(fresh.privateKeyPem, { orgId, connectionId: fresh.keyId });
      row = await store.putSigningKeyIfAbsent({ keyId: fresh.keyId, orgId, publicKeyPem: fresh.publicKeyPem, sealedPrivateKey, backend: LOCAL_KEY_BACKEND, keyRef: null, createdAt: now().toISOString() });
    }
    if (row.backend !== LOCAL_KEY_BACKEND || row.sealedPrivateKey === null) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "Something went wrong",
        detail: `org ${orgId}'s Guard signing key ${row.keyId} is held by the ${row.backend} key backend, and this registry signs with local keys; start it with VIBTRA_KEY_BACKEND=enterprise`,
      });
    }
    const privateKeyPem = await sealer.open(row.sealedPrivateKey, { orgId, connectionId: row.keyId });
    return { keyId: row.keyId, publicKeyPem: row.publicKeyPem, privateKeyPem };
  };

  const opened = new Map<string, Promise<GuardSigningKeyPair>>();
  const keyOf = (orgId: string): Promise<GuardSigningKeyPair> => {
    const cached = opened.get(orgId);
    if (cached !== undefined) return cached;
    const loading = load(orgId);
    opened.set(orgId, loading);
    loading.catch(() => {
      if (opened.get(orgId) === loading) opened.delete(orgId);
    });
    return loading;
  };

  return {
    async publicKey(orgId) {
      const { keyId, publicKeyPem } = await keyOf(orgId);
      return { keyId, publicKeyPem };
    },
    async sign(orgId, signingInput) {
      const { keyId, privateKeyPem } = await keyOf(orgId);
      return { keyId, signature: signEs256(signingInput(keyId), privateKeyPem) };
    },
  };
};
