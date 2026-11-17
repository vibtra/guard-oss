import { randomBytes, verify } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuardSignaturePayload, compileGuardBundle, defaultGuardSettings, emptyGuardRules, seedCatalogue, type GuardBundle } from "@vibtra/guard-contract";
import {
  ES256_SIGNATURE_BYTES,
  assembleJws,
  mintGuardId,
  signGuardBundle,
  signGuardCatalogue,
  signingInputFor,
  verifyGuardBundle,
  verifyGuardCatalogue,
  type GuardSigner,
} from "@vibtra/guard-contract/signing";

export interface GuardSignerBackend {
  signer(): GuardSigner;
  failNextLoad(): Error;
  close(): Promise<void>;
}

const orgOf = (): string => `org_${randomBytes(6).toString("hex")}`;

const bundleFor = (orgId: string, deviceId = mintGuardId("gdev")): GuardBundle =>
  compileGuardBundle({
    document: emptyGuardRules(),
    catalogue: seedCatalogue(),
    person: { userId: "usr_contract", email: "person@example.com", groupIds: [] },
    settings: defaultGuardSettings(),
    grants: [],
    orgId,
    deviceId,
    now: new Date("2026-11-01T00:00:00.000Z"),
  });

const headerOf = (jws: string): { kid?: string } => JSON.parse(Buffer.from(jws.split(".")[0] ?? "", "base64url").toString("utf8")) as { kid?: string };

export const describeGuardSignerContract = (name: string, makeSigner: () => Promise<GuardSignerBackend>): void => {
  describe(`the GuardSigner contract (${name})`, () => {
    let backend: GuardSignerBackend;

    beforeEach(async () => {
      backend = await makeSigner();
    });

    afterEach(async () => {
      await backend.close();
    });

    it("signs a bundle and a catalogue that verify with publicKey() through guard-contract's verifier", async () => {
      const signer = backend.signer();
      const orgId = orgOf();
      const bundle = bundleFor(orgId);
      const [signedBundle, signedCatalogue] = await Promise.all([signGuardBundle(bundle, signer), signGuardCatalogue(seedCatalogue(), orgId, signer)]);
      const key = await signer.publicKey(orgId);
      expect(verifyGuardBundle(signedBundle, key.publicKeyPem, key.keyId, bundle.deviceId)).toMatchObject({ ok: true, payload: { orgId, keyId: key.keyId } });
      expect(verifyGuardCatalogue(signedCatalogue, key.publicKeyPem, key.keyId)).toMatchObject({ ok: true, payload: { orgId, keyId: key.keyId } });
    });

    it("returns a raw 64-byte r||s ES256 signature over exactly the input it was handed", async () => {
      const signer = backend.signer();
      const orgId = orgOf();
      const input = Buffer.from("made-up signing input");
      const { keyId, signature } = await signer.sign(orgId, () => input);
      const key = await signer.publicKey(orgId);
      expect(keyId).toBe(key.keyId);
      expect(signature).toHaveLength(ES256_SIGNATURE_BYTES);
      expect(verify("sha256", input, { key: key.publicKeyPem, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
      expect(verify("sha256", Buffer.from("another input"), { key: key.publicKeyPem, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
    });

    it("builds the input from the key id it signs with, so the JWS kid names the key that signed", async () => {
      const signer = backend.signer();
      const orgId = orgOf();
      const offered: string[] = [];
      const { keyId } = await signer.sign(orgId, (chosen) => {
        offered.push(chosen);
        return Buffer.from(chosen);
      });
      expect(offered).toEqual([keyId]);
      const signed = await signGuardBundle(bundleFor(orgId), signer);
      expect(signed.signature.keyId).toBe(keyId);
      expect(headerOf(signed.signature.jws).kid).toBe(keyId);
    });

    it("keeps one key for an organisation across calls and across a second signer on the same store", async () => {
      const orgId = orgOf();
      const first = backend.signer();
      const key = await first.publicKey(orgId);
      expect(await first.publicKey(orgId)).toEqual(key);
      const second = backend.signer();
      expect(await second.publicKey(orgId)).toEqual(key);
      const bundle = bundleFor(orgId);
      expect(verifyGuardBundle(await signGuardBundle(bundle, second), key.publicKeyPem, key.keyId, bundle.deviceId)).toMatchObject({ ok: true });
    });

    it("gives each organisation its own key", async () => {
      const signer = backend.signer();
      const [orgA, orgB] = [orgOf(), orgOf()];
      const [keyA, keyB] = await Promise.all([signer.publicKey(orgA), signer.publicKey(orgB)]);
      expect(keyA.keyId).not.toBe(keyB.keyId);
      expect(keyA.publicKeyPem).not.toBe(keyB.publicKeyPem);
      const bundle = bundleFor(orgB);
      expect(verifyGuardBundle(await signGuardBundle(bundle, signer), keyA.publicKeyPem, keyA.keyId, bundle.deviceId)).toMatchObject({ ok: false });
    });

    it("refuses a bundle that names org B but was signed with org A's key, under org A's key id or under org B's", async () => {
      const signer = backend.signer();
      const [orgA, orgB] = [orgOf(), orgOf()];
      const [keyA, keyB] = await Promise.all([signer.publicKey(orgA), signer.publicKey(orgB)]);
      const { bundle, signature } = await signGuardBundle(bundleFor(orgB), signer);
      const { keyId: _signedWith, ...payload } = GuardSignaturePayload.parse(JSON.parse(Buffer.from(signature.jws.split(".")[1] ?? "", "base64url").toString("utf8")));
      expect(payload.orgId).toBe(orgB);
      const signedByA = async (keyId: string) => {
        const input = signingInputFor(payload, keyId);
        const raw = await signer.sign(orgA, () => input.bytes);
        expect(raw.keyId).toBe(keyA.keyId);
        return { bundle, signature: { keyId, alg: "ES256" as const, jws: assembleJws(input.header, input.body, raw.signature) } };
      };
      expect(verifyGuardBundle(await signedByA(keyA.keyId), keyB.publicKeyPem, keyB.keyId, bundle.deviceId)).toEqual({ ok: false, reason: "wrong-key" });
      expect(verifyGuardBundle(await signedByA(keyB.keyId), keyB.publicKeyPem, keyB.keyId, bundle.deviceId)).toEqual({ ok: false, reason: "bad-signature" });
    });

    it("signs with exactly the one stored key when two signers race to first use of one organisation", async () => {
      const signers = [backend.signer(), backend.signer()];
      const input = Buffer.from("made-up race signing input");
      for (let round = 0; round < 3; round += 1) {
        const orgId = orgOf();
        const signatures = await Promise.all(signers.flatMap((signer) => Array.from({ length: 10 }, () => signer.sign(orgId, () => input))));
        const stored = await backend.signer().publicKey(orgId);
        expect(new Set(signatures.map((signed) => signed.keyId)), `round ${round}`).toEqual(new Set([stored.keyId]));
        for (const [racer, signed] of signatures.entries()) {
          expect(verify("sha256", input, { key: stored.publicKeyPem, dsaEncoding: "ieee-p1363" }, signed.signature), `round ${round}, racer ${racer}`).toBe(true);
        }
        expect(await Promise.all(signers.map((signer) => signer.publicKey(orgId)))).toEqual([stored, stored]);
      }
    });

    it("does not cache a failed load: the next call loads the key again", async () => {
      const signer = backend.signer();
      const orgId = orgOf();
      const outage = backend.failNextLoad();
      await expect(signer.publicKey(orgId)).rejects.toThrow(outage.message);
      const key = await signer.publicKey(orgId);
      expect(await signer.publicKey(orgId)).toEqual(key);
      expect(await backend.signer().publicKey(orgId)).toEqual(key);
    });

    it("when the backend fails, the caller gets an error and no document, signed or not", async () => {
      const signer = backend.signer();
      const orgId = orgOf();
      const outage = backend.failNextLoad();
      const outcome = await signGuardBundle(bundleFor(orgId), signer).then(
        (signed) => ({ signed }),
        (error: unknown) => ({ error }),
      );
      expect(outcome).not.toHaveProperty("signed");
      expect((outcome as { error?: Error }).error?.message).toBe(outage.message);
      const again = backend.failNextLoad();
      await expect(signGuardCatalogue(seedCatalogue(), orgId, signer)).rejects.toThrow(again.message);
    });
  });
};
