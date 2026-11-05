import crypto from "node:crypto";
import type { VaultSealer } from "../vault/seal.js";

const bindingFor = (orgId: string, toolId: string): { orgId: string; connectionId: string } => ({
  orgId,
  connectionId: `tool:${toolId}`,
});

export const resealToolSecret = async (
  sealer: VaultSealer,
  orgId: string,
  toolId: string,
  sealed: string,
): Promise<string> => sealer.reseal(sealed, bindingFor(orgId, toolId));

const secretsEqual = (a: string, b: string): boolean =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a, "utf8").digest(),
    crypto.createHash("sha256").update(b, "utf8").digest(),
  );

const CLIENT_SECRET_DIGEST_PREFIX = "sha256:";

export const hashToolClientSecret = (secret: string): string =>
  `${CLIENT_SECRET_DIGEST_PREFIX}${crypto.createHash("sha256").update(secret, "utf8").digest("base64url")}`;

export const verifyToolClientSecret = (secret: string, storedHash: string): boolean =>
  secretsEqual(hashToolClientSecret(secret), storedHash);
