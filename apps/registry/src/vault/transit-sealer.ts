import { VibtraError } from "../errors.js";
import {
  DEFAULT_NAMESPACE_PREFIX,
  assertPathSegment,
  createOpenBaoClient,
  dataOf,
  errorsOf,
  openbaoRefused as refused,
  openbaoUnreachable as unreachable,
  type OpenBaoApiResult,
  type OpenBaoClient,
} from "./openbao-client.js";
import { sealBindingTuple, type SealBinding, type SealedKeyState, type VaultSealer } from "./seal.js";

export const TRANSIT_SEALED_PREFIX = "bao.v1.";

export const TRANSIT_KEY_NAME = "org";

export { DEFAULT_NAMESPACE_PREFIX };

const DEFAULT_KEY_METADATA_TTL_MS = 5_000;

export type { MaybePromise } from "./seal.js";

export type AsyncVaultSealer = VaultSealer;

export interface TransitKeyDestroyer {
  destroyOrgKey(orgId: string): Promise<"destroyed" | "absent" | "unavailable">;
}

export interface TransitSealerOptions {
  addr: string;
  roleId: string;
  secretId: string;
  namespacePrefix?: string | null | undefined;
  timeoutMs?: number | undefined;
  keyMetadataTtlMs?: number | undefined;
  client?: OpenBaoClient | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

const MOUNT_PATH = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/;

const TRANSIT_CIPHERTEXT = /^vault:v(\d+):[A-Za-z0-9+/=_-]+$/;

export const derivationContext = (binding: SealBinding): string =>
  Buffer.from(JSON.stringify(sealBindingTuple(binding)), "utf8").toString("base64");

export interface TransitEnvelope {
  mount: string;
  version: number;
  ciphertext: string;
}

export const parseTransitEnvelope = (sealed: string): TransitEnvelope | undefined => {
  if (!sealed.startsWith(TRANSIT_SEALED_PREFIX)) return undefined;
  const rest = sealed.slice(TRANSIT_SEALED_PREFIX.length);
  const cut = rest.indexOf(".");
  if (cut <= 0) return undefined;
  const mount = rest.slice(0, cut);
  const ciphertext = rest.slice(cut + 1);
  if (!MOUNT_PATH.test(mount)) return undefined;
  const matched = TRANSIT_CIPHERTEXT.exec(ciphertext);
  if (matched === null) return undefined;
  const version = Number(matched[1]);
  if (!Number.isSafeInteger(version) || version < 1) return undefined;
  return { mount, version, ciphertext };
};

const malformedEnvelope = (): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "Stored credential envelope is malformed",
    detail:
      "the stored value carries the OpenBao envelope marker but is not a well-formed " +
      `${TRANSIT_SEALED_PREFIX}<mount>.vault:v<N>:… envelope — refusing to interpret it`,
  });

const undecryptable = (status: number): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "Stored credential could not be decrypted",
    detail:
      `OpenBao refused the decryption (HTTP ${status}) — the ciphertext is bound to its org and connection id ` +
      "through the transit key's derivation context, so this means the row was moved, altered, or is being read " +
      "under the wrong identity. OpenBao's own words are deliberately not repeated here.",
  });

const outOfRange = (mount: string, version: number, latest: number, min: number): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "This credential was sealed under a key version OpenBao will no longer open",
    detail:
      `the row names ${mount} term v${version}; that key is at v${latest} and will not decrypt below ` +
      `v${min} (its min_decryption_version). Lower min_decryption_version on that key to re-seal the row, ` +
      "or have the admin re-enter the credential. No key material can be read out of OpenBao to recover it.",
  });

const missingKey = (mount: string): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "This credential names an OpenBao transit key this registry cannot find",
    detail:
      `the row was sealed under the mount ${mount}, which does not exist or is not readable with this ` +
      "registry's credential — check OPENBAO_NAMESPACE_PREFIX and the AppRole's policy, or have the admin " +
      "re-enter the credential",
  });

interface KeyMetadata {
  latest: number;
  min: number;
}

export const createTransitSealer = (
  options: TransitSealerOptions,
): AsyncVaultSealer & TransitKeyDestroyer => {
  const metadataTtlMs = options.keyMetadataTtlMs ?? DEFAULT_KEY_METADATA_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const client =
    options.client ??
    createOpenBaoClient({
      addr: options.addr,
      roleId: options.roleId,
      secretId: options.secretId,
      ...(options.namespacePrefix === undefined ? {} : { namespacePrefix: options.namespacePrefix }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  const namespacePrefix = client.namespacePrefix;
  const authed = client.authed;

  const keyId =
    namespacePrefix === undefined
      ? `bao:transit/${TRANSIT_KEY_NAME}`
      : `bao:${namespacePrefix}/…/transit/${TRANSIT_KEY_NAME}`;

  const metadata = new Map<string, { at: number; value: KeyMetadata | undefined }>();

  const ensureKey = async (mount: string): Promise<void> => {
    const made = await authed("POST", `${mount}/keys/${TRANSIT_KEY_NAME}`, "creating the organisation's transit key", {
      type: "aes256-gcm96",
      derived: true,
      exportable: false,
      allow_plaintext_backup: false,
    });
    if (!made.ok) throw refused("creating the organisation's transit key", made.status);
  };

  const ensureMount = async (orgId: string): Promise<string> =>
    client.ensureMount(orgId, "transit", ensureKey);

  const keyMetadata = async (mount: string): Promise<KeyMetadata | undefined> => {
    const cached = metadata.get(mount);
    if (cached !== undefined && now() - cached.at < metadataTtlMs) return cached.value;
    const stage = "reading the organisation's transit key version";
    const read = await authed("GET", `${mount}/keys/${TRANSIT_KEY_NAME}`, stage);
    let value: KeyMetadata | undefined;
    if (read.status === 404) {
      value = undefined;
    } else if (!read.ok) {
      throw refused(stage, read.status);
    } else {
      const data = dataOf(read);
      const latest = data?.["latest_version"];
      const min = data?.["min_decryption_version"];
      if (typeof latest !== "number" || typeof min !== "number") throw refused(stage, read.status);
      value = { latest, min };
    }
    metadata.set(mount, { at: now(), value });
    return value;
  };

  const classify = async (sealed: string): Promise<SealedKeyState> => {
    const envelope = parseTransitEnvelope(sealed);
    if (envelope === undefined) return "malformed";
    const meta = await keyMetadata(envelope.mount);
    if (meta === undefined) return "unknown";
    if (envelope.version === meta.latest) return "current";
    if (envelope.version >= meta.min && envelope.version < meta.latest) return "previous";
    return "unknown";
  };

  const ciphertextOf = (result: OpenBaoApiResult, stage: string): string => {
    const value = dataOf(result)?.["ciphertext"];
    if (typeof value !== "string" || !TRANSIT_CIPHERTEXT.test(value)) throw refused(stage, result.status);
    return value;
  };

  return {
    keyId,
    keyIds: [keyId],

    keyState: classify,

    async seal(plaintext, binding) {
      const mount = await ensureMount(binding.orgId);
      const stage = "sealing a credential in OpenBao";
      const res = await authed("POST", `${mount}/encrypt/${TRANSIT_KEY_NAME}`, stage, {
        plaintext: Buffer.from(plaintext, "utf8").toString("base64"),
        context: derivationContext(binding),
      });
      if (!res.ok) throw refused(stage, res.status);
      return `${TRANSIT_SEALED_PREFIX}${mount}.${ciphertextOf(res, stage)}`;
    },

    async open(sealed, binding) {
      const envelope = parseTransitEnvelope(sealed);
      if (envelope === undefined) throw malformedEnvelope();
      const stage = "opening a sealed credential in OpenBao";
      const res = await authed("POST", `${envelope.mount}/decrypt/${TRANSIT_KEY_NAME}`, stage, {
        ciphertext: envelope.ciphertext,
        context: derivationContext(binding),
      });
      if (!res.ok) throw undecryptable(res.status);
      const value = dataOf(res)?.["plaintext"];
      if (typeof value !== "string") throw undecryptable(res.status);
      return Buffer.from(value, "base64").toString("utf8");
    },

    async reseal(sealed, binding) {
      const state = await classify(sealed);
      if (state === "current") return sealed;
      if (state === "malformed") throw malformedEnvelope();
      const envelope = parseTransitEnvelope(sealed);
      if (envelope === undefined) throw malformedEnvelope();
      if (state === "unknown") {
        const meta = await keyMetadata(envelope.mount);
        throw meta === undefined
          ? missingKey(envelope.mount)
          : outOfRange(envelope.mount, envelope.version, meta.latest, meta.min);
      }
      const stage = "re-sealing a credential in OpenBao";
      const res = await authed("POST", `${envelope.mount}/rewrap/${TRANSIT_KEY_NAME}`, stage, {
        ciphertext: envelope.ciphertext,
        context: derivationContext(binding),
      });
      if (!res.ok) throw undecryptable(res.status);
      return `${TRANSIT_SEALED_PREFIX}${envelope.mount}.${ciphertextOf(res, stage)}`;
    },

    async destroyOrgKey(orgId: string): Promise<"destroyed" | "absent" | "unavailable"> {
      assertPathSegment(orgId);
      if (namespacePrefix === undefined) return "unavailable";
      const mount = `${namespacePrefix}/${orgId}/transit`;
      metadata.delete(mount);
      const allowStage = "allowing deletion of the organisation's transit key";
      const allowed = await authed("POST", `${mount}/keys/${TRANSIT_KEY_NAME}/config`, allowStage, {
        deletion_allowed: true,
      });
      if (allowed.status === 404) return "absent";
      if (!allowed.ok) throw refused(allowStage, allowed.status);
      const destroyStage = "destroying the organisation's transit key";
      const destroyed = await authed("DELETE", `${mount}/keys/${TRANSIT_KEY_NAME}`, destroyStage);
      if (destroyed.status === 404) return "absent";
      if (!destroyed.ok) throw refused(destroyStage, destroyed.status);
      return "destroyed";
    },
  };
};

export const probeOpenBao = async (
  addr: string,
  options: { timeoutMs?: number | undefined; fetchImpl?: typeof fetch | undefined } = {},
): Promise<"reachable" | "unreachable"> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 2_000);
  try {
    const res = await (options.fetchImpl ?? fetch)(`${addr.replace(/\/+$/, "")}/v1/sys/health`, {
      method: "GET",
      signal: controller.signal,
    });
    return res.status === 200 || res.status === 429 || res.status === 472 || res.status === 473
      ? "reachable"
      : "unreachable";
  } catch {
    return "unreachable";
  } finally {
    clearTimeout(timer);
  }
};
