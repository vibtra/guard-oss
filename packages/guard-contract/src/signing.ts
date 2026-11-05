// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { GUARD_SIGNATURE_TYP, GuardBundle, GuardSignature, GuardSignaturePayload, SignedGuardBundle, SignedGuardCatalogue, canonicalJson } from "./bundle.js";
import { GuardCatalogue } from "./catalogue.js";

export interface GuardSigningKeyPair {
  keyId: string;
  publicKeyPem: string;
  privateKeyPem: string;
}

export const generateGuardSigningKey = (): GuardSigningKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    keyId: `gk_${randomBytes(4).toString("hex")}`,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
};

export const digestOf = (document: unknown): string => createHash("sha256").update(canonicalJson(document), "utf8").digest("hex");

const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString("base64url");

const signPayload = (payload: GuardSignaturePayload, key: GuardSigningKeyPair): GuardSignature => {
  const header = b64url(JSON.stringify({ alg: "ES256", typ: GUARD_SIGNATURE_TYP, kid: key.keyId }));
  const body = b64url(JSON.stringify(GuardSignaturePayload.parse(payload)));
  const signature = nodeSign("sha256", Buffer.from(`${header}.${body}`), { key: createPrivateKey(key.privateKeyPem), dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { keyId: key.keyId, alg: "ES256", jws: `${header}.${body}.${signature}` };
};

export const signGuardBundle = (bundle: GuardBundle, key: GuardSigningKeyPair, now = new Date()): SignedGuardBundle => {
  const parsed = GuardBundle.parse(bundle);
  const signature = signPayload(
    { kind: "bundle", keyId: key.keyId, iat: Math.floor(now.getTime() / 1000), orgId: parsed.orgId, deviceId: parsed.deviceId, version: parsed.bundleVersion, digest: digestOf(parsed) },
    key,
  );
  return { bundle: parsed, signature };
};

export const signGuardCatalogue = (catalogue: GuardCatalogue, orgId: string, key: GuardSigningKeyPair, now = new Date()): SignedGuardCatalogue => {
  const parsed = GuardCatalogue.parse(catalogue);
  const signature = signPayload({ kind: "catalogue", keyId: key.keyId, iat: Math.floor(now.getTime() / 1000), orgId, version: parsed.version, digest: digestOf(parsed) }, key);
  return { catalogue: parsed, signature };
};

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
