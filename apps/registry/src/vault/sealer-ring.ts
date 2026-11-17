import type { SealBinding, SealedKeyState, VaultSealer } from "./seal.js";

const holds = (state: SealedKeyState): boolean => state === "current" || state === "previous";

export const createSealerRing = (primary: VaultSealer, decryptOnly: readonly VaultSealer[]): VaultSealer => {
  if (decryptOnly.length === 0) return primary;

  const holderOf = async (sealed: string): Promise<VaultSealer | undefined> => {
    for (const member of decryptOnly) {
      if (holds(await member.keyState(sealed))) return member;
    }
    return undefined;
  };

  const ownerOf = async (sealed: string): Promise<VaultSealer> => (holds(await primary.keyState(sealed)) ? primary : ((await holderOf(sealed)) ?? primary));

  return {
    keyId: primary.keyId,
    keyIds: [...new Set([...primary.keyIds, ...decryptOnly.flatMap((member) => member.keyIds)])],

    seal: (plaintext: string, binding: SealBinding) => primary.seal(plaintext, binding),

    open: async (sealed: string, binding: SealBinding) => (await ownerOf(sealed)).open(sealed, binding),

    async keyState(sealed: string): Promise<SealedKeyState> {
      const state = await primary.keyState(sealed);
      if (holds(state)) return state;
      return (await holderOf(sealed)) === undefined ? state : "previous";
    },

    async reseal(sealed: string, binding: SealBinding): Promise<string> {
      const owner = await ownerOf(sealed);
      if (owner === primary) return primary.reseal(sealed, binding);
      return primary.seal(await owner.open(sealed, binding), binding);
    },
  };
};
