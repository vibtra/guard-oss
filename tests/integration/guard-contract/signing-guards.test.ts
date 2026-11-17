import { describe, expect, it } from "vitest";
import { GuardSignaturePayload, compileGuardBundle, defaultGuardSettings, emptyGuardRules, seedCatalogue, type GuardBundle } from "@vibtra/guard-contract";
import {
  ES256_SIGNATURE_BYTES,
  assembleJws,
  generateGuardSigningKey,
  signEs256,
  signGuardBundle,
  signGuardCatalogue,
  signingInputFor,
  verifyGuardBundle,
  type GuardSigner,
} from "@vibtra/guard-contract/signing";

const ORG = "org_signing_guards";
const KEY = generateGuardSigningKey();

const bundle = (): GuardBundle =>
  compileGuardBundle({
    document: emptyGuardRules(),
    catalogue: seedCatalogue(),
    person: { userId: "usr_signing_guards", email: "person@example.com", groupIds: [] },
    settings: defaultGuardSettings(),
    grants: [],
    orgId: ORG,
    deviceId: "gdev_0123456789abcdef",
    now: new Date("2026-11-01T00:00:00.000Z"),
  });

const payloadOf = (jws: string): GuardSignaturePayload => GuardSignaturePayload.parse(JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")));

const signerThat = (sign: GuardSigner["sign"]): GuardSigner => ({
  publicKey: async () => ({ keyId: KEY.keyId, publicKeyPem: KEY.publicKeyPem }),
  sign,
});

describe("signing through a GuardSigner", () => {
  it("refuses a signer that builds the signing input twice", async () => {
    const twice = signerThat(async (_orgId, input) => {
      input(KEY.keyId);
      return { keyId: KEY.keyId, signature: signEs256(input(KEY.keyId), KEY.privateKeyPem) };
    });
    await expect(signGuardBundle(bundle(), twice)).rejects.toThrow(`the signer for ${ORG} asked for a second signing input; a signer builds exactly one`);
  });

  it("refuses a signer that reports a key other than the one it built the input for", async () => {
    const other = generateGuardSigningKey();
    const lying = signerThat(async (_orgId, input) => ({ keyId: other.keyId, signature: signEs256(input(KEY.keyId), KEY.privateKeyPem) }));
    await expect(signGuardCatalogue(seedCatalogue(), ORG, lying)).rejects.toThrow(`the signer for ${ORG} reported key ${other.keyId} but did not sign an input built for that key`);
  });

  it("refuses a signer that never builds the signing input", async () => {
    const blind = signerThat(async () => ({ keyId: KEY.keyId, signature: signEs256(Buffer.from("made-up other input"), KEY.privateKeyPem) }));
    await expect(signGuardBundle(bundle(), blind)).rejects.toThrow(`the signer for ${ORG} reported key ${KEY.keyId} but did not sign an input built for that key`);
  });

  it("refuses a signature that is not 64 bytes of r||s", async () => {
    for (const length of [0, ES256_SIGNATURE_BYTES - 1, ES256_SIGNATURE_BYTES + 1, 72]) {
      const short = signerThat(async (_orgId, input) => {
        input(KEY.keyId);
        return { keyId: KEY.keyId, signature: Buffer.alloc(length, 1) };
      });
      await expect(signGuardBundle(bundle(), short), `${length} bytes`).rejects.toThrow(`an ES256 signature is 64 bytes (r||s); the signer returned ${length}`);
    }
    const input = signingInputFor({ kind: "catalogue", iat: 0, orgId: ORG, version: "1", digest: "0".repeat(64) }, KEY.keyId);
    expect(() => assembleJws(input.header, input.body, Buffer.alloc(63))).toThrow("an ES256 signature is 64 bytes (r||s); the signer returned 63");
    expect(assembleJws(input.header, input.body, Buffer.alloc(64)).split(".")).toEqual([input.header, input.body, Buffer.alloc(64).toString("base64url")]);
  });

  it("stamps iat in whole seconds from the clock it was given", async () => {
    const now = new Date("2026-11-17T09:30:15.999Z");
    const seconds = Math.floor(now.getTime() / 1000);
    const synchronous = signGuardBundle(bundle(), KEY, now);
    expect(payloadOf(synchronous.signature.jws).iat).toBe(seconds);
    const through = await signGuardCatalogue(seedCatalogue(), ORG, signerThat(async (_orgId, input) => ({ keyId: KEY.keyId, signature: signEs256(input(KEY.keyId), KEY.privateKeyPem) })), now);
    expect(payloadOf(through.signature.jws).iat).toBe(seconds);
    expect(verifyGuardBundle(synchronous, KEY.publicKeyPem, KEY.keyId)).toMatchObject({ ok: true, payload: { iat: seconds } });
  });
});
