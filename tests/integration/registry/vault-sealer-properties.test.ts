import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import type { SealBinding, VaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { createVaultSealer } from "@vibtra/registry/src/vault/seal.ts";
import { describeVaultSealerContract, vaultSealerProperties } from "../../contracts/vault-sealer.ts";

const seed = process.env.FC_SEED;

afterEach(() => {
  if (seed === undefined) delete process.env.FC_SEED;
  else process.env.FC_SEED = seed;
});

describe("the VaultSealer contract's property settings (S5)", () => {
  it("seeds every property run with 0x5eed unless FC_SEED says otherwise, so a Stryker result cannot flip between runs", () => {
    delete process.env.FC_SEED;
    expect(vaultSealerProperties().parameters).toEqual({ seed: 0x5eed, numRuns: 100 });
    process.env.FC_SEED = "42";
    expect(vaultSealerProperties({ numRuns: 7 }).parameters).toEqual({ seed: 42, numRuns: 7 });
  });

  it("draws the same values on every run with the same seed", () => {
    delete process.env.FC_SEED;
    const { parameters, bindings, plaintexts, resplits } = vaultSealerProperties();
    const draw = () => fc.sample(fc.tuple(bindings, plaintexts, resplits), { seed: parameters.seed, numRuns: 50 });
    expect(draw()).toEqual(draw());
  });

  it("draws only non-empty orgIds, connectionIds and plaintexts when a reuser asks, and empty ones otherwise", () => {
    const sample = (nonEmpty: boolean) => {
      const { bindings, plaintexts, resplits } = vaultSealerProperties({ nonEmpty });
      const values = fc.sample(fc.tuple(bindings, plaintexts, resplits), { seed: 1, numRuns: 300 });
      return values.flatMap(([binding, plaintext, { binding: split, other }]) => [binding.orgId, binding.connectionId, plaintext, split.orgId, split.connectionId, other.orgId, other.connectionId]);
    };
    expect(sample(true).filter((value) => value === "")).toEqual([]);
    expect(sample(false)).toContain("");
  });
});

const seen: SealBinding[] = [];
const recording = (inner: VaultSealer): VaultSealer => ({
  ...inner,
  seal: (plaintext, binding) => {
    seen.push(binding);
    return inner.seal(plaintext, binding);
  },
});

describeVaultSealerContract(
  "a recording sealer with numRuns 3 and non-empty values",
  async () => ({ sealer: recording(createVaultSealer("b".repeat(64), ["a".repeat(64)])), older: createVaultSealer("a".repeat(64)), stranger: createVaultSealer("c".repeat(64)) }),
  { numRuns: 3, nonEmpty: true },
);

describe("a reuser's contract options (S5)", () => {
  it("bound the property runs to the reuser's numRuns and keep every binding non-empty", () => {
    const fixed = (binding: SealBinding) => ["org_contract", "ab"].includes(binding.orgId);
    const drawn = seen.filter((binding) => !fixed(binding));
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThanOrEqual(2 * 3);
    expect(seen.filter((binding) => binding.orgId === "" || binding.connectionId === "")).toEqual([]);
  });
});
