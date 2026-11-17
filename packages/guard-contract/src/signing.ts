// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { GUARD_SIGNATURE_TYP, GuardBundle, GuardSignature, GuardSignaturePayload, SignedGuardBundle, SignedGuardCatalogue, canonicalJson } from "./bundle.js";
import { GuardCatalogue } from "./catalogue.js";

export interface GuardSigner {
  publicKey(orgId: string): Promise<{ keyId: string; publicKeyPem: string }>;
  sign(orgId: string, signingInput: (keyId: string) => Buffer): Promise<{ keyId: string; signature: Buffer }>;
}

export interface GuardSigningKeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export const ES256_SIGNATURE_BYTES = 64;

export const generateGuardSigningKey = (): GuardSigningKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    keyId: `gk_${randomBytes(8).toString("hex")}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

export const signEs256 = (input: Buffer, privateKeyPem: string): Buffer => nodeSign("sha256", input, { key: createPrivateKey(privateKeyPem), dsaEncoding: "ieee-p1363" });

export const digestOf = (document: unknown): string => createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

export type GuardUnsignedPayload = Omit<GuardSignaturePayload, "keyId">;

export interface GuardSigningInput {
  keyId: string;
  header: string;
  body: string;
  bytes: Buffer;
}

export const signingInputFor = (payload: GuardUnsignedPayload, keyId: string): GuardSigningInput => {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: GUARD_SIGNATURE_TYP, kid: keyId }));
  const body = b64url(JSON.stringify(GuardSignaturePayload.parse({ ...payload, keyId })));
  return { keyId, header, body, bytes: Buffer.from(`${header}.${body}`) };
};

export const assembleJws = (header: string, body: string, signature: Buffer): string => {
  if (signature.length !== ES256_SIGNATURE_BYTES) throw new Error(`an ES256 signature is ${ES256_SIGNATURE_BYTES} bytes (r||s); the signer returned ${signature.length}`);
  return `${header}.${body}.${b64url(signature)}`;
};

const signWithKeyPair = (payload: GuardUnsignedPayload, key: GuardSigningKeyPair): GuardSignature => {
  const input = signingInputFor(payload, key.keyId);
  return { keyId: key.keyId, alg: "ES256", jws: assembleJws(input.header, input.body, signEs256(input.bytes, key.privateKeyPem)) };
};

const signWithSigner = async (signer: GuardSigner, orgId: string, payload: GuardUnsignedPayload): Promise<GuardSignature> => {
  let built: GuardSigningInput | undefined;
  const { keyId, signature } = await signer.sign(orgId, (chosen) => {
    if (built !== undefined) throw new Error(`the signer for ${orgId} asked for a second signing input; a signer builds exactly one`);
    built = signingInputFor(payload, chosen);
    return built.bytes;
  });
  if (built === undefined || built.keyId !== keyId) throw new Error(`the signer for ${orgId} reported key ${keyId} but did not sign an input built for that key`);
  return { keyId, alg: "ES256", jws: assembleJws(built.header, built.body, signature) };
};

const isKeyPair = (key: GuardSigningKeyPair | GuardSigner): key is GuardSigningKeyPair => "privateKeyPem" in key;

const iatOf = (now: Date): number => Math.floor(now.getTime() / 1000);

export function signGuardBundle(bundle: GuardBundle, key: GuardSigningKeyPair, now?: Date): SignedGuardBundle;
export function signGuardBundle(bundle: GuardBundle, signer: GuardSigner, now?: Date): Promise<SignedGuardBundle>;
export function signGuardBundle(bundle: GuardBundle, key: GuardSigningKeyPair | GuardSigner, now = new Date()): SignedGuardBundle | Promise<SignedGuardBundle> {
  const parsed = GuardBundle.parse(bundle);
  const payload: GuardUnsignedPayload = { kind: "bundle", iat: iatOf(now), orgId: parsed.orgId, deviceId: parsed.deviceId, version: parsed.bundleVersion, digest: digestOf(parsed) };
  if (isKeyPair(key)) return { bundle: parsed, signature: signWithKeyPair(payload, key) };
  return signWithSigner(key, parsed.orgId, payload).then((signature) => ({ bundle: parsed, signature }));
}

export function signGuardCatalogue(catalogue: GuardCatalogue, orgId: string, key: GuardSigningKeyPair, now?: Date): SignedGuardCatalogue;
export function signGuardCatalogue(catalogue: GuardCatalogue, orgId: string, signer: GuardSigner, now?: Date): Promise<SignedGuardCatalogue>;
export function signGuardCatalogue(catalogue: GuardCatalogue, orgId: string, key: GuardSigningKeyPair | GuardSigner, now = new Date()): SignedGuardCatalogue | Promise<SignedGuardCatalogue> {
  const parsed = GuardCatalogue.parse(catalogue);
  const payload: GuardUnsignedPayload = { kind: "catalogue", iat: iatOf(now), orgId, version: parsed.version, digest: digestOf(parsed) };
  if (isKeyPair(key)) return { catalogue: parsed, signature: signWithKeyPair(payload, key) };
  return signWithSigner(key, orgId, payload).then((signature) => ({ catalogue: parsed, signature }));
}

export interface VerifyFailure {
  ok: false;
  reason: "malformed" | "wrong-key" | "bad-signature" | "digest-mismatch" | "wrong-kind" | "wrong-device";
}
export type VerifyResult = { ok: true; payload: GuardSignaturePayload } | VerifyFailure;

const verifyPayload = (signature: GuardSignature, publicKeyPem: string, document: unknown, expect: { kind: "bundle" | "catalogue"; keyId: string; deviceId?: string }): VerifyResult => {
  const parts = signature.jws.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  let header: { alg?: string; kid?: string; typ?: string };
  let payload: GuardSignaturePayload;
  try {
    header = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8")) as typeof header;
    payload = GuardSignaturePayload.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "ES256" || header.typ !== GUARD_SIGNATURE_TYP) return { ok: false, reason: "malformed" };
  if (header.kid !== expect.keyId || payload.keyId !== expect.keyId || signature.keyId !== expect.keyId) return { ok: false, reason: "wrong-key" };
  if (payload.kind !== expect.kind) return { ok: false, reason: "wrong-kind" };
  if (expect.deviceId !== undefined && payload.deviceId !== expect.deviceId) return { ok: false, reason: "wrong-device" };
  let ok = false;
  try {
    ok = nodeVerify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2]!, "base64url"));
  } catch {
    ok = false;
  }
  if (!ok) return { ok: false, reason: "bad-signature" };
  if (payload.digest !== digestOf(document)) return { ok: false, reason: "digest-mismatch" };
  return { ok: true, payload };
};

export const verifyGuardBundle = (signed: SignedGuardBundle, publicKeyPem: string, keyId: string, deviceId?: string): VerifyResult =>
  verifyPayload(signed.signature, publicKeyPem, signed.bundle, { kind: "bundle", keyId, ...(deviceId === undefined ? {} : { deviceId }) });

export const verifyGuardCatalogue = (signed: SignedGuardCatalogue, publicKeyPem: string, keyId: string): VerifyResult =>
  verifyPayload(signed.signature, publicKeyPem, signed.catalogue, { kind: "catalogue", keyId });

export const mintGuardId = (prefix: "gdev" | "gev" | "gsr" | "gcr" | "genr" | "gdt", bytes = 8): string => `${prefix}_${randomBytes(bytes).toString("hex")}`;
export const mintEnrolToken = (): string => mintGuardId("genr", 16);
export const mintDeviceToken = (): string => mintGuardId("gdt", 24);
export const tokenHashOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
