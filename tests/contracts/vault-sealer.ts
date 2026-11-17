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

const flipAt = (sealed: string, at: number): string => `${sealed.slice(0, at)}${sealed[at] === "A" ? "B" : "A"}${sealed.slice(at + 1)}`;

const tamperPositions = (sealed: string): number[] => {
  const usable = (at: number): boolean => at > 0 && at < sealed.length - 1 && sealed[at] !== "." && sealed[at + 1] !== ".";
  const nearest = (at: number): number => {
    for (let back = Math.min(at, sealed.length - 2); back > 0; back -= 1) if (usable(back)) return back;
    return 1;
  };
  const ciphertext = sealed.lastIndexOf(".") + 1;
  const anchors = [0.15, 0.35, 0.5, 0.65, 0.85].map((share) => Math.floor(sealed.length * share));
  return [...new Set([...anchors, ciphertext + Math.floor((sealed.length - ciphertext) / 2), sealed.length - 2].map(nearest))];
};

const rejects = async (attempt: () => unknown): Promise<void> => {
  await expect((async () => attempt())()).rejects.toThrow();
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

    it("refuses to open ciphertext tampered at any of several positions, the middle of the ciphertext included", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, BINDING);
      const positions = tamperPositions(sealed);
      expect(positions.length).toBeGreaterThanOrEqual(4);
      for (const at of positions) {
        const altered = flipAt(sealed, at);
        expect(altered).not.toBe(sealed);
        await expect(opens(sealer, altered, BINDING), `tampered at ${at} of ${sealed.length}`).rejects.toThrow();
      }
    });

    it("says a value is current, previous or unknown by the key that sealed it", async () => {
      const { sealer, older, stranger } = await makeSealer();
      expect(await sealer.keyState(await sealer.seal(SECRET, BINDING))).toBe("current");
      expect(await sealer.keyState(await older.seal(SECRET, BINDING))).toBe("previous");
      expect(await sealer.keyState(await stranger.seal(SECRET, BINDING))).toBe("unknown");
    });

    it("reseals a row onto the current key, still bound to its orgId and connectionId, and leaves a current row readable", async () => {
      const { sealer, older } = await makeSealer();
      const moved = await sealer.reseal(await older.seal(SECRET, BINDING), BINDING);
      expect(await sealer.keyState(moved)).toBe("current");
      expect(await opens(sealer, moved, BINDING)).toBe(SECRET);
      const again = await sealer.reseal(moved, BINDING);
      expect(await sealer.keyState(again)).toBe("current");
      expect(await opens(sealer, again, BINDING)).toBe(SECRET);
      await expect(opens(sealer, moved, { ...BINDING, orgId: "org_other" })).rejects.toThrow();
      await expect(opens(sealer, moved, { ...BINDING, connectionId: "conn_other" })).rejects.toThrow();
    });

    it("refuses to open or reseal a row sealed under a key it does not hold", async () => {
      const { sealer, stranger } = await makeSealer();
      const foreign = await stranger.seal(SECRET, BINDING);
      await rejects(() => sealer.open(foreign, BINDING));
      await rejects(() => sealer.reseal(foreign, BINDING));
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
