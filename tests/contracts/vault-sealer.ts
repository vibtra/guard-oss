import { describe, expect, it } from "vitest";
import type { SealBinding, VaultSealer } from "@vibtra/registry/src/vault/seal.ts";

export interface VaultSealerUnderTest {
  sealer: VaultSealer;
  older: VaultSealer;
  stranger: VaultSealer;
}

const BINDING: SealBinding = { orgId: "org_contract", connectionId: "conn_contract" };
const SECRET = "made-up-credential-0123456789";

const opens = async (sealer: VaultSealer, sealed: string, binding: SealBinding): Promise<string> => sealer.open(sealed, binding);

const tampered = (sealed: string): string => {
  const at = sealed.length - 2;
  const swapped = sealed[at] === "A" ? "B" : "A";
  return `${sealed.slice(0, at)}${swapped}${sealed.slice(at + 1)}`;
};

export const describeVaultSealerContract = (name: string, makeSealer: () => Promise<VaultSealerUnderTest>): void => {
  describe(`the VaultSealer contract (${name})`, () => {
    it("opens what it sealed, and the sealed value does not carry the plaintext", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, BINDING);
      expect(sealed).not.toContain(SECRET);
      expect(await opens(sealer, sealed, BINDING)).toBe(SECRET);
    });

    it("refuses to open a value under another orgId or another connectionId", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, BINDING);
      await expect(opens(sealer, sealed, { ...BINDING, orgId: "org_other" })).rejects.toThrow();
      await expect(opens(sealer, sealed, { ...BINDING, connectionId: "conn_other" })).rejects.toThrow();
    });

    it("refuses to open tampered ciphertext", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, BINDING);
      await expect(opens(sealer, tampered(sealed), BINDING)).rejects.toThrow();
    });

    it("says a value is current, previous or unknown by the key that sealed it", async () => {
      const { sealer, older, stranger } = await makeSealer();
      expect(await sealer.keyState(await sealer.seal(SECRET, BINDING))).toBe("current");
      expect(await sealer.keyState(await older.seal(SECRET, BINDING))).toBe("previous");
      expect(await sealer.keyState(await stranger.seal(SECRET, BINDING))).toBe("unknown");
    });

    it("reseals a row onto the current key, and leaves a current row readable", async () => {
      const { sealer, older } = await makeSealer();
      const moved = await sealer.reseal(await older.seal(SECRET, BINDING), BINDING);
      expect(await sealer.keyState(moved)).toBe("current");
      expect(await opens(sealer, moved, BINDING)).toBe(SECRET);
      const again = await sealer.reseal(moved, BINDING);
      expect(await sealer.keyState(again)).toBe("current");
      expect(await opens(sealer, again, BINDING)).toBe(SECRET);
    });

    it("opens rows its decrypt-only key sealed, but never seals a new row under that key", async () => {
      const { sealer, older } = await makeSealer();
      expect(await opens(sealer, await older.seal(SECRET, BINDING), BINDING)).toBe(SECRET);
      const fresh = await sealer.seal(SECRET, BINDING);
      expect(await sealer.keyState(fresh)).toBe("current");
      expect(await older.keyState(fresh)).not.toMatch(/^(current|previous)$/);
      await expect(opens(older, fresh, BINDING)).rejects.toThrow();
    });
  });
};
