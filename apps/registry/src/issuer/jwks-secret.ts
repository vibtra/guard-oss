import crypto from "node:crypto";
import { VibtraError } from "../errors.js";

export const GATE_SEALED_PREFIX = "vgk.v1.";

const GATE_KEY_INFO = "vibtra-registry/tool-gate-signing-key/v1";

const b64url = (buf: Buffer): string => buf.toString("base64url");

const gateKey = (secret: string): { key: Buffer; keyId: string } => {
  const trimmed = secret.trim();
  if (trimmed === "") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "The tool gate has no signing secret",
      detail:
        "REGISTRY_GATE_SIGNING_SECRET (or REGISTRY_SESSION_SECRET, which it falls back to) is empty, so the private " +
        "half of the signing key could not be encrypted. Set it — openssl rand -hex 32 — and restart; see " +
        "docs/deploy-registry-aws.md §1.5.",
    });
  }
  const key = Buffer.from(
    crypto.hkdfSync("sha256", Buffer.from(trimmed, "utf8"), Buffer.alloc(0), Buffer.from(GATE_KEY_INFO, "utf8"), 32),
  );
  return { key, keyId: crypto.createHash("sha256").update(key).digest("hex").slice(0, 12) };
};

export const gateSigningKeyId = (secret: string): string => gateKey(secret).keyId;

export const isGateSealed = (stored: string): boolean => stored.startsWith(GATE_SEALED_PREFIX);

export const sealGateSigningKey = (secret: string, privateWebKey: string): string => {
  const { key, keyId } = gateKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(GATE_KEY_INFO, "utf8"));
  const ct = Buffer.concat([cipher.update(privateWebKey, "utf8"), cipher.final()]);
  return `${GATE_SEALED_PREFIX}${keyId}.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`;
};

export const openGateSigningKey = (secret: string, stored: string): string => {
  const parts = isGateSealed(stored) ? stored.slice(GATE_SEALED_PREFIX.length).split(".") : [];
  const [storedKeyId, iv, tag, ct] = parts;
  if (parts.length !== 4 || storedKeyId === undefined || iv === undefined || tag === undefined || ct === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "The tool gate's signing key is not in this registry's envelope",
      detail:
        "the stored private key does not carry the `vgk.v1.` marker — refusing to interpret it. A key minted before " +
        "DECISIONS.md host-9 landed carries better-auth's own encryption instead, and issuer/provider.ts opens that " +
        "shape and re-seals it; anything else is a row this registry did not write.",
    });
  }
  const { key, keyId } = gateKey(secret);
  if (storedKeyId !== keyId) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "The tool gate's signing key was encrypted under a different secret",
      detail:
        `the stored key names ${storedKeyId} and this process holds ${keyId}. REGISTRY_GATE_SIGNING_SECRET has ` +
        "changed (or was set for the first time while rows existed under REGISTRY_SESSION_SECRET). Put the old value " +
        "back and run `pnpm --filter @vibtra/registry rotate-issuer-key`, which mints a fresh key under the current " +
        "secret and retires the old one without signing anybody out — docs/deploy-registry-aws.md §1.5.",
    });
  }
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    decipher.setAAD(Buffer.from(GATE_KEY_INFO, "utf8"));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new VibtraError({
      code: "INTERNAL",
      message: "The tool gate's signing key failed its integrity check",
      detail:
        `the envelope names ${storedKeyId}, which this process holds, but the authentication tag did not verify — ` +
        "the stored row has been altered or truncated. Run `pnpm --filter @vibtra/registry rotate-issuer-key` to " +
        "mint a fresh key; every ID token already in a browser keeps verifying until its own exp.",
    });
  }
};
