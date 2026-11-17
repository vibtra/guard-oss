import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { SealBinding, VaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { createCiphertextTripwire } from "@vibtra/registry/src/vault/tripwire.ts";

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

export interface VaultSealerContractOptions {
  numRuns?: number;
  nonEmpty?: boolean;
}

export const vaultSealerProperties = (options: VaultSealerContractOptions = {}) => {
  const least = options.nonEmpty === true ? 1 : 0;
  const resplits = fc
    .tuple(fc.string({ minLength: 2 + least, maxLength: 64 }), fc.nat(), fc.nat())
    .map(([joined, first, second]) => {
      const room = joined.length + 1 - 2 * least;
      const at = (pick: number): number => least + (pick % room);
      return { binding: { orgId: joined.slice(0, at(first)), connectionId: joined.slice(at(first)) }, other: { orgId: joined.slice(0, at(second)), connectionId: joined.slice(at(second)) } };
    })
    .filter(({ binding, other }) => binding.orgId !== other.orgId);
  return {
    parameters: { seed: Number(process.env.FC_SEED ?? 0x5eed), numRuns: options.numRuns ?? 100 },
    plaintexts: fc.oneof(fc.string({ unit: "binary", minLength: least, maxLength: 256 }), fc.uint8Array({ minLength: least, maxLength: 512 }).map((bytes) => Buffer.from(bytes).toString("latin1"))),
    bindings: fc.record({ orgId: fc.string({ minLength: least, maxLength: 64 }), connectionId: fc.string({ minLength: least, maxLength: 64 }) }),
    resplits,
  };
};

const sameBinding = (a: SealBinding, b: SealBinding): boolean => a.orgId === b.orgId && a.connectionId === b.connectionId;

const rejects = async (attempt: () => unknown): Promise<void> => {
  await expect((async () => attempt())()).rejects.toThrow();
};

export const describeVaultSealerContract = (name: string, makeSealer: () => Promise<VaultSealerUnderTest>, options: VaultSealerContractOptions = {}): void => {
  const { parameters, plaintexts, bindings, resplits } = vaultSealerProperties(options);
  describe(`the VaultSealer contract (${name})`, () => {
    it("opens what it sealed, and the sealed value does not carry the plaintext", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, BINDING);
      expect(sealed).not.toContain(SECRET);
      expect(await opens(sealer, sealed, BINDING)).toBe(SECRET);
    });

    it("starts every sealed value with its envelope prefix, and lists that prefix among the ones it recognises", async () => {
      const { sealer } = await makeSealer();
      expect(sealer.envelopePrefixes).toContain(sealer.envelopePrefix);
      for (const plaintext of [SECRET, "", "x".repeat(4096)]) {
        expect((await sealer.seal(plaintext, BINDING)).startsWith(sealer.envelopePrefix), `${plaintext.length} characters`).toBe(true);
      }
    });

    it("opens what it sealed for any plaintext and any orgId and connectionId, and refuses it under any other pair", async () => {
      const { sealer } = await makeSealer();
      await fc.assert(
        fc.asyncProperty(plaintexts, bindings, bindings, async (plaintext, binding, other) => {
          fc.pre(!sameBinding(binding, other));
          const sealed = await sealer.seal(plaintext, binding);
          expect(await opens(sealer, sealed, binding)).toBe(plaintext);
          await expect(opens(sealer, sealed, other)).rejects.toThrow();
        }),
        parameters,
      );
    });

    it("refuses a value under any re-split of the same orgId and connectionId, so the binding is not their plain concatenation", async () => {
      const { sealer } = await makeSealer();
      await fc.assert(
        fc.asyncProperty(plaintexts, resplits, async (plaintext, { binding, other }) => {
          const sealed = await sealer.seal(plaintext, binding);
          expect(await opens(sealer, sealed, binding)).toBe(plaintext);
          await expect(opens(sealer, sealed, other)).rejects.toThrow();
        }),
        parameters,
      );
    });

    it("refuses a value sealed for orgId ab and connectionId c under orgId a and connectionId bc", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal(SECRET, { orgId: "ab", connectionId: "c" });
      expect(await opens(sealer, sealed, { orgId: "ab", connectionId: "c" })).toBe(SECRET);
      await expect(opens(sealer, sealed, { orgId: "a", connectionId: "bc" })).rejects.toThrow();
    });

    it("round-trips an empty plaintext", async () => {
      const { sealer } = await makeSealer();
      const sealed = await sealer.seal("", BINDING);
      expect(sealed).not.toBe("");
      expect(await opens(sealer, sealed, BINDING)).toBe("");
    });

    it("is caught by the ciphertext tripwire built from it, in a response body, for rows it seals and rows its decrypt-only key sealed", async () => {
      const { sealer, older } = await makeSealer();
      const tripwire = createCiphertextTripwire(sealer);
      for (const sealed of [await sealer.seal(SECRET, BINDING), await sealer.seal("", BINDING), await older.seal(SECRET, BINDING)]) {
        expect(tripwire.catches(JSON.stringify({ name: "made-up org", credential: sealed }))).toBe(true);
      }
      expect(tripwire.catches(JSON.stringify({ name: "made-up org", credential: SECRET }))).toBe(false);
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
