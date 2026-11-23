import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SignedGuardBundle } from "@vibtra/guard-contract";
import { verifyGuardBundle } from "@vibtra/guard-contract/signing";

const SEVENTY_TWO_HOURS_S = 72 * 60 * 60;
const FIXTURES = new URL("../../../guard/agent/tests/fixtures/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, FIXTURES), "utf8");

const signedFixture = (name: string): unknown => {
  const raw = JSON.parse(read(name)) as { signature: { jwsParts: string[] } & Record<string, unknown> } & Record<string, unknown>;
  const { jwsParts, ...signature } = raw.signature;
  return { ...raw, signature: { ...signature, jws: jwsParts.join(".") } };
};

describe("the Rust agent's committed fixtures (regenerate with guard/agent/scripts/make-fixtures.ts)", () => {
  it("hold a bundle on the contract's current shape, signed with an expiry 72 hours after iat", () => {
    const signed = SignedGuardBundle.parse(signedFixture("signed-bundle.json"));
    const { keyId } = JSON.parse(read("digests.json")) as { keyId: string };
    const verified = verifyGuardBundle(signed, read("signing-public.pem"), keyId, signed.bundle.deviceId);
    if (!verified.ok) throw new Error(`the fixture bundle did not verify: ${verified.reason}`);
    expect(verified.payload.validUntil).toBe(verified.payload.iat + SEVENTY_TWO_HOURS_S);
    expect(signed.bundle).toMatchObject({ clientMode: "enforce", defaultMode: "monitor", protectionRevision: 4 });
  });
});
