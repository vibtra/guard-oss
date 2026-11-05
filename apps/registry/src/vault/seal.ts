import crypto from "node:crypto";
import { VibtraError } from "../errors.js";

export const SEALED_PREFIX = "vault.v1.";

export interface SealBinding {
  orgId: string;
  connectionId: string;
}

export type SealedKeyState =
  | "current"
  | "previous"
  | "unknown"
  | "malformed";

export type MaybePromise<T> = T | Promise<T>;

export interface VaultSealer {
  readonly keyId: string;
  readonly keyIds: readonly string[];
  seal(plaintext: string, binding: SealBinding): MaybePromise<string>;
  open(sealed: string, binding: SealBinding): MaybePromise<string>;
  reseal(sealed: string, binding: SealBinding): MaybePromise<string>;
  keyState(sealed: string): MaybePromise<SealedKeyState>;
}

export interface SyncVaultSealer extends VaultSealer {
  seal(plaintext: string, binding: SealBinding): string;
  open(sealed: string, binding: SealBinding): string;
  reseal(sealed: string, binding: SealBinding): string;
  keyState(sealed: string): SealedKeyState;
}

export interface ResealCounts {
  scanned: number;
  current: number;
  stale: number;
  unreadable: number;
  unreadableKeyIds: string[];
}

export interface RotationCensus {
  connections: ResealCounts;
  tools: ResealCounts;
  deployTargets?: ResealCounts;
  integrations?: ResealCounts;
  modelGateways?: ResealCounts;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");

export const sealBindingTuple = (binding: SealBinding): [string, string] => [binding.orgId, binding.connectionId];

const aad = (binding: SealBinding): Buffer => Buffer.from(JSON.stringify(sealBindingTuple(binding)), "utf8");

export const parseVaultKey = (raw: string, label = "VIBTRA_VAULT_KEY"): Buffer => {
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(value)) {
    const buf = Buffer.from(value, "base64");
    if (buf.length === 32) return buf;
  }
  throw new VibtraError({
    code: "VALIDATION",
    message: `${label} is not a 256-bit key`,
    detail:
      "expected 64 hex characters (openssl rand -hex 32) or base64 of exactly 32 bytes; " +
      "the value itself is never echoed, by design",
  });
};

const fingerprint = (key: Buffer): string =>
  crypto.createHash("sha256").update("vibtra:vault:keyid:").update(key).digest("hex").slice(0, 12);

export const sealedKeyId = (sealed: string): string | undefined => {
  if (!sealed.startsWith(SEALED_PREFIX)) return undefined;
  const parts = sealed.slice(SEALED_PREFIX.length).split(".");
  if (parts.length !== 4) return undefined;
  const id = parts[0] as string;
  return /^[0-9a-f]{12}$/.test(id) ? id : undefined;
};

export const splitVaultKeyList = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

export interface VaultKeyRing {
  current: { keyId: string; key: Buffer };
  previous: Array<{ keyId: string; key: Buffer }>;
}

export const buildVaultKeyRing = (rawCurrent: string, rawPrevious: readonly string[] = []): VaultKeyRing => {
  const key = parseVaultKey(rawCurrent);
  const current = { key, keyId: fingerprint(key) };
  const previous: Array<{ keyId: string; key: Buffer }> = [];
  for (let i = 0; i < rawPrevious.length; i += 1) {
    const entry = rawPrevious[i] as string;
    const prevKey = parseVaultKey(entry, `VIBTRA_VAULT_KEY_PREVIOUS entry ${i + 1}`);
    const keyId = fingerprint(prevKey);
    if (keyId === current.keyId) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "VIBTRA_VAULT_KEY is also listed in VIBTRA_VAULT_KEY_PREVIOUS",
        detail:
          `entry ${i + 1} of VIBTRA_VAULT_KEY_PREVIOUS is the current key (fingerprint ${keyId}) — ` +
          "the previous list is for keys you have rotated AWAY from, and leaving the current one in it makes " +
          "an unfinished rotation indistinguishable from a finished one. Neither key is echoed.",
      });
    }
    if (previous.some((p) => p.keyId === keyId)) continue;
    previous.push({ key: prevKey, keyId });
  }
  return { current, previous };
};

export const emptyResealCounts = (): ResealCounts => ({
  scanned: 0,
  current: 0,
  stale: 0,
  unreadable: 0,
  unreadableKeyIds: [],
});

export const tallySealedRow = async (counts: ResealCounts, sealer: VaultSealer, sealed: string): Promise<boolean> => {
  counts.scanned += 1;
  const state = await sealer.keyState(sealed);
  if (state === "current") {
    counts.current += 1;
    return false;
  }
  if (state === "previous") {
    counts.stale += 1;
    return true;
  }
  counts.unreadable += 1;
  const id = sealedKeyId(sealed);
  if (id !== undefined && !counts.unreadableKeyIds.includes(id)) counts.unreadableKeyIds.push(id);
  return false;
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export const formatRotationLine = (census: RotationCensus, keyIds: readonly string[]): string => {
  const ring =
    keyIds.length > 1
      ? `vault key ring: current ${keyIds[0]}, previous ${keyIds.slice(1).join(" ")}`
      : `vault key ring: current ${keyIds[0]} (no previous keys configured)`;
  const conns = plural(census.connections.scanned, "connection credential", "connection credentials");
  const secrets = plural(census.tools.scanned, "tool secret", "tool secrets");
  const dt = census.deployTargets;
  const ints = census.integrations;
  const integrationsClause =
    ints === undefined ? "" : ` and ${plural(ints.scanned, "1Password integration", "1Password integrations")}`;
  const gws = census.modelGateways;
  const gatewaysClause =
    gws === undefined ? "" : ` and ${plural(gws.scanned, "model gateway", "model gateways")}`;
  const targets =
    (dt === undefined ? "" : ` and ${plural(dt.scanned, "deploy target", "deploy targets")}`) +
    integrationsClause +
    gatewaysClause;
  const stale =
    census.connections.stale + census.tools.stale + (dt?.stale ?? 0) + (ints?.stale ?? 0) + (gws?.stale ?? 0);
  const unreadable =
    census.connections.unreadable +
    census.tools.unreadable +
    (dt?.unreadable ?? 0) +
    (ints?.unreadable ?? 0) +
    (gws?.unreadable ?? 0);
  const body =
    stale > 0
      ? `${census.connections.stale} of ${conns} and ${census.tools.stale} of ${secrets}` +
        (dt === undefined ? "" : ` and ${dt.stale} of ${plural(dt.scanned, "deploy target", "deploy targets")}`) +
        (ints === undefined
          ? ""
          : ` and ${ints.stale} of ${plural(ints.scanned, "1Password integration", "1Password integrations")}`) +
        (gws === undefined ? "" : ` and ${gws.stale} of ${plural(gws.scanned, "model gateway", "model gateways")}`) +
        ` are still sealed under a previous key — run "pnpm --filter @vibtra/registry reseal" to finish the rotation`
      : unreadable === 0
        ? `all ${conns} and ${secrets}${targets} are sealed under the current key`
        : `${census.connections.current} of ${conns} and ${census.tools.current} of ${secrets}` +
          (dt === undefined ? "" : ` and ${dt.current} of ${plural(dt.scanned, "deploy target", "deploy targets")}`) +
          (ints === undefined
            ? ""
            : ` and ${ints.current} of ${plural(ints.scanned, "1Password integration", "1Password integrations")}`) +
          (gws === undefined
            ? ""
            : ` and ${gws.current} of ${plural(gws.scanned, "model gateway", "model gateways")}`) +
          " are sealed under the current key";
  if (unreadable === 0) return `${ring} — ${body}`;
  const ids = [
    ...new Set([
      ...census.connections.unreadableKeyIds,
      ...census.tools.unreadableKeyIds,
      ...(dt?.unreadableKeyIds ?? []),
      ...(ints?.unreadableKeyIds ?? []),
      ...(gws?.unreadableKeyIds ?? []),
    ]),
  ];
  const named = ids.length === 0 ? "no readable key id" : ids.join(" ");
  const advice =
    ids.length === 0
      ? " — check OPENBAO_ADDR before re-entering anything: a row sealed in OpenBao names no key of this family and " +
        "is opened by OpenBao, not by a key in this process"
      : " — those credentials must be re-entered";
  return (
    `${ring} — ${body}; ${plural(unreadable, "row names", "rows name")} a key this registry does not hold ` +
    `(${named}) and cannot be re-sealed${advice}`
  );
};

export const createVaultSealer = (rawKey: string, rawPrevious: readonly string[] = []): SyncVaultSealer => {
  const ring = buildVaultKeyRing(rawKey, rawPrevious);
  const key = ring.current.key;
  const keyId = ring.current.keyId;
  const byId = new Map<string, Buffer>();
  byId.set(keyId, key);
  for (const p of ring.previous) byId.set(p.keyId, p.key);
  const keyIds: readonly string[] = [keyId, ...ring.previous.map((p) => p.keyId)];

  const sealValue = (plaintext: string, binding: SealBinding): string => {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(binding));
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return `${SEALED_PREFIX}${keyId}.${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(ct)}`;
  };

  const openValue = (sealed: string, binding: SealBinding): string => {
    if (!sealed.startsWith(SEALED_PREFIX)) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "Stored credential is not a sealed envelope",
        detail:
          "the stored value does not carry THIS key family's envelope marker (vault.v1.) — refusing to interpret it. " +
          "A row sealed while OPENBAO_ADDR was set carries a different marker and is opened by OpenBao rather than by " +
          "a key in this process: if that is what happened, restore OPENBAO_ADDR with its AppRole — nothing has been " +
          "lost and no credential needs re-entering",
      });
    }
    const parts = sealed.slice(SEALED_PREFIX.length).split(".");
    if (parts.length !== 4) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "Stored credential envelope is malformed",
        detail: `expected 4 envelope segments, found ${parts.length}`,
      });
    }
    const [rowKeyId, ivPart, tagPart, ctPart] = parts as [string, string, string, string];
    const rowKey = byId.get(rowKeyId);
    if (rowKey === undefined) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "This connection was sealed with a different vault key",
        detail:
          `the row was sealed under key ${rowKeyId}, this registry holds ${keyIds.join(", ")} (current first) — ` +
          "add the original key to VIBTRA_VAULT_KEY_PREVIOUS and run the reseal command (see README, " +
          '"Rotating the vault key"), or have the admin re-enter the credential under the new one',
      });
    }
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", rowKey, Buffer.from(ivPart, "base64url"));
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ctPart, "base64url")), decipher.final()]).toString("utf8");
    } catch {
      throw new VibtraError({
        code: "INTERNAL",
        message: "Stored credential could not be decrypted",
        detail:
          "authenticated decryption failed — the ciphertext is bound to its org and connection id, so this means " +
          "the row was moved, altered, or is being read under the wrong identity",
      });
    }
  };

  return {
    keyId,
    keyIds,

    keyState(sealed) {
      const id = sealedKeyId(sealed);
      if (id === undefined) return "malformed";
      if (id === keyId) return "current";
      return byId.has(id) ? "previous" : "unknown";
    },

    seal: sealValue,
    open: openValue,

    reseal(sealed, binding) {
      if (sealedKeyId(sealed) === keyId) return sealed;
      return sealValue(openValue(sealed, binding), binding);
    },
  };
};
