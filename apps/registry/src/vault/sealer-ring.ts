import type { OpenBaoClient } from "./openbao-client.js";
import { createVaultSealer, type SealedKeyState, type VaultSealer } from "./seal.js";
import { TRANSIT_SEALED_PREFIX, createTransitSealer, type AsyncVaultSealer } from "./transit-sealer.js";

export interface SealerRingParts {
  transit?: AsyncVaultSealer | undefined;
  env?: VaultSealer | undefined;
}

export const createSealerRing = (parts: SealerRingParts): AsyncVaultSealer | undefined => {
  const { transit, env } = parts;
  if (transit === undefined) return env;
  if (env === undefined) return transit;

  const keyIds: readonly string[] = [transit.keyId, ...env.keyIds];

  const isTransit = (sealed: string): boolean => sealed.startsWith(TRANSIT_SEALED_PREFIX);

  return {
    keyId: transit.keyId,
    keyIds,

    seal: (plaintext, binding) => transit.seal(plaintext, binding),

    open: (sealed, binding) => (isTransit(sealed) ? transit.open(sealed, binding) : env.open(sealed, binding)),

    async keyState(sealed): Promise<SealedKeyState> {
      if (isTransit(sealed)) return transit.keyState(sealed);
      const state = await env.keyState(sealed);
      return state === "current" || state === "previous" ? "previous" : state;
    },

    async reseal(sealed, binding) {
      if (isTransit(sealed)) return transit.reseal(sealed, binding);
      const plaintext = await env.open(sealed, binding);
      return transit.seal(plaintext, binding);
    },
  };
};

export interface OrgVaultConfig {
  vaultKey?: string | undefined;
  vaultKeyPrevious?: readonly string[] | undefined;
  openbaoAddr?: string | undefined;
  openbaoRoleId?: string | undefined;
  openbaoSecretId?: string | undefined;
  openbaoNamespacePrefix?: string | undefined;
}

export const createOrgVaultSealer = (
  config: OrgVaultConfig,
  client?: OpenBaoClient | undefined,
): AsyncVaultSealer | undefined =>
  createSealerRing({
    ...(config.vaultKey === undefined
      ? {}
      : { env: createVaultSealer(config.vaultKey, config.vaultKeyPrevious ?? []) }),
    ...(config.openbaoAddr === undefined || config.openbaoRoleId === undefined || config.openbaoSecretId === undefined
      ? {}
      : {
          transit: createTransitSealer({
            addr: config.openbaoAddr,
            roleId: config.openbaoRoleId,
            secretId: config.openbaoSecretId,
            ...(config.openbaoNamespacePrefix === undefined
              ? {}
              : { namespacePrefix: config.openbaoNamespacePrefix }),
            ...(client === undefined ? {} : { client }),
          }),
        }),
  });
