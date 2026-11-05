import type { BetterAuthPlugin } from "better-auth";
import { VibtraError } from "../errors.js";
import type { ResealCounts, SealBinding, VaultSealer } from "../vault/seal.js";

const SSO_PROVIDER_MODEL = "ssoProvider";

export const SSO_CLIENT_SECRET_KEY_ID_FIELD = "clientSecretKeyId";

const bindingFor = (orgId: string, providerId: string): SealBinding => ({
  orgId,
  connectionId: `sso-provider:${providerId}`,
});

export const sealSsoClientSecret = async (
  sealer: VaultSealer,
  orgId: string,
  providerId: string,
  secret: string,
): Promise<string> => sealer.seal(secret, bindingFor(orgId, providerId));

export const openSsoClientSecret = async (
  sealer: VaultSealer,
  orgId: string,
  providerId: string,
  sealed: string,
): Promise<string> => sealer.open(sealed, bindingFor(orgId, providerId));

export const resealSsoClientSecret = async (
  sealer: VaultSealer,
  orgId: string,
  providerId: string,
  sealed: string,
): Promise<string> => sealer.reseal(sealed, bindingFor(orgId, providerId));

export const requireSsoSecretSealer = (sealer: VaultSealer | undefined): VaultSealer => {
  if (sealer === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "This registry cannot store a sign-in provider's client secret",
      detail:
        "VIBTRA_VAULT_KEY is not configured, so an SSO client secret would have to be stored in the clear and this " +
        "registry refuses to (DECISIONS.md host-10). Set it (openssl rand -hex 32) and restart — or point the " +
        "registry at OpenBao with OPENBAO_ADDR and its AppRole. See apps/registry/README.md.",
    });
  }
  return sealer;
};

interface ProviderRowShape {
  providerId?: unknown;
  organizationId?: unknown;
  oidcConfig?: unknown;
  [SSO_CLIENT_SECRET_KEY_ID_FIELD]?: unknown;
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const parseOidcConfig = (raw: unknown): Record<string, unknown> | undefined => {
  const text = asString(raw);
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
};

const SECRET_FIELD = "clientSecret";

const plaintextSecretOf = (config: Record<string, unknown> | undefined): string | undefined =>
  config === undefined ? undefined : asString(config[SECRET_FIELD]);

const sealWriteData = async (
  sealer: VaultSealer | undefined,
  data: Record<string, unknown>,
  existing?: ProviderRowShape | undefined,
): Promise<Record<string, unknown>> => {
  const config = parseOidcConfig(data["oidcConfig"]);
  const secret = plaintextSecretOf(config);
  if (config === undefined || secret === undefined) return data;

  const providerId = asString(data["providerId"]) ?? asString(existing?.providerId);
  const orgId = asString(data["organizationId"]) ?? asString(existing?.organizationId);
  if (providerId === undefined || orgId === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "This registry cannot store a sign-in provider without an organisation",
      detail:
        "an SSO client secret is sealed against (orgId, sso-provider:<providerId>), and this row carries no " +
        "organisation id — refusing to write it, because a row sealed under an empty binding is a row bound to " +
        "nothing (DECISIONS.md host-10).",
    });
  }
  const ring = requireSsoSecretSealer(sealer);
  return {
    ...data,
    oidcConfig: JSON.stringify({ ...config, [SECRET_FIELD]: await sealSsoClientSecret(ring, orgId, providerId, secret) }),
    [SSO_CLIENT_SECRET_KEY_ID_FIELD]: ring.keyId,
  };
};

const openReadRow = async <T>(
  sealer: VaultSealer | undefined,
  row: T,
  upgrade: (row: ProviderRowShape, orgId: string, providerId: string, secret: string) => void,
): Promise<T> => {
  if (typeof row !== "object" || row === null) return row;
  const shape = row as ProviderRowShape;
  const config = parseOidcConfig(shape.oidcConfig);
  const stored = plaintextSecretOf(config);
  if (config === undefined || stored === undefined) return row;

  const providerId = asString(shape.providerId);
  const orgId = asString(shape.organizationId);
  const keyId = asString(shape[SSO_CLIENT_SECRET_KEY_ID_FIELD]);

  if (keyId === undefined) {
    if (orgId !== undefined && providerId !== undefined) upgrade(shape, orgId, providerId, stored);
    return row;
  }
  if (orgId === undefined || providerId === undefined) return row;
  const ring = requireSsoSecretSealer(sealer);
  const opened = await openSsoClientSecret(ring, orgId, providerId, stored);
  return { ...shape, oidcConfig: JSON.stringify({ ...config, [SECRET_FIELD]: opened }) } as T;
};

interface SsoStorageAdapter {
  create: <T>(args: { model: string; data: Record<string, unknown>; [k: string]: unknown }) => Promise<T>;
  update: <T>(args: { model: string; where: unknown; update: Record<string, unknown> }) => Promise<T | null>;
  findOne: <T>(args: { model: string; where: unknown; [k: string]: unknown }) => Promise<T | null>;
  findMany: <T>(args: { model: string; [k: string]: unknown }) => Promise<T[]>;
  transaction: <R>(cb: (trx: unknown) => Promise<R>) => Promise<R>;
}

type PluginInitResult = Exclude<Awaited<ReturnType<NonNullable<BetterAuthPlugin["init"]>>>, void>;
type AuthContextAdapter = NonNullable<NonNullable<PluginInitResult["context"]>["adapter"]>;

export interface SsoSecretSealing {
  id: "vibtra-sso-secret-sealing";
  init: (context: { adapter: unknown }) => { context: { adapter: AuthContextAdapter } };
  storedAdapter: () => SsoStorageAdapter;
}

const wrapAdapter = (base: SsoStorageAdapter, sealer: VaultSealer | undefined): SsoStorageAdapter => {
  const upgradeInPlace = (row: ProviderRowShape, orgId: string, providerId: string, secret: string): void => {
    if (sealer === undefined) return;
    void (async () => {
      try {
        const sealed = await sealSsoClientSecret(sealer, orgId, providerId, secret);
        const config = parseOidcConfig(row.oidcConfig);
        if (config === undefined) return;
        await base.update({
          model: SSO_PROVIDER_MODEL,
          where: [{ field: "providerId", value: providerId }],
          update: {
            oidcConfig: JSON.stringify({ ...config, [SECRET_FIELD]: sealed }),
            [SSO_CLIENT_SECRET_KEY_ID_FIELD]: sealer.keyId,
          },
        });
      } catch {
      }
    })();
  };

  const handler: ProxyHandler<SsoStorageAdapter> = {
    get(target, property, receiver) {
      if (property === "create") {
        return async <T>(args: { model: string; data: Record<string, unknown> }): Promise<T> =>
          args.model !== SSO_PROVIDER_MODEL
            ? target.create<T>(args)
            : target.create<T>({ ...args, data: await sealWriteData(sealer, args.data) });
      }
      if (property === "update") {
        return async <T>(args: { model: string; where: unknown; update: Record<string, unknown> }): Promise<T | null> => {
          if (args.model !== SSO_PROVIDER_MODEL) return target.update<T>(args);
          const needsRow = plaintextSecretOf(parseOidcConfig(args.update["oidcConfig"])) !== undefined;
          const existing = needsRow
            ? ((await target.findOne<ProviderRowShape>({ model: SSO_PROVIDER_MODEL, where: args.where })) ?? undefined)
            : undefined;
          return target.update<T>({ ...args, update: await sealWriteData(sealer, args.update, existing) });
        };
      }
      if (property === "findOne") {
        return async <T>(args: { model: string; where: unknown }): Promise<T | null> => {
          const row = await target.findOne<T>(args);
          return args.model !== SSO_PROVIDER_MODEL || row === null ? row : await openReadRow(sealer, row, upgradeInPlace);
        };
      }
      if (property === "findMany") {
        return async <T>(args: { model: string }): Promise<T[]> => {
          const rows = await target.findMany<T>(args);
          if (args.model !== SSO_PROVIDER_MODEL) return rows;
          const opened: T[] = [];
          for (const row of rows) opened.push(await openReadRow(sealer, row, upgradeInPlace));
          return opened;
        };
      }
      if (property === "transaction") {
        return async <R>(cb: (trx: unknown) => Promise<R>): Promise<R> =>
          target.transaction<R>((trx) => cb(wrapAdapter(trx as SsoStorageAdapter, sealer)));
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  };
  return new Proxy(base, handler);
};

export const ssoSecretSealing = (options: { sealer?: VaultSealer | undefined }): SsoSecretSealing => {
  let base: SsoStorageAdapter | undefined;
  return {
    id: "vibtra-sso-secret-sealing",
    init: (context) => {
      base = context.adapter as SsoStorageAdapter;
      return { context: { adapter: wrapAdapter(base, options.sealer) as unknown as AuthContextAdapter } };
    },
    storedAdapter: () => {
      if (base === undefined) {
        throw new Error(
          "the SSO secret sealing plugin was asked for the raw storage seam before Better Auth had built its " +
            "context — nothing has read or written a provider row yet",
        );
      }
      return base;
    },
  };
};

export const resealSsoProviders = async (
  adapter: {
    findMany: <T>(args: { model: string }) => Promise<T[]>;
    update: <T>(args: {
      model: string;
      where: Array<{ field: string; value: string }>;
      update: Record<string, unknown>;
    }) => Promise<T | null>;
  },
  sealer: VaultSealer,
  options: { dryRun?: boolean } = {},
): Promise<ResealCounts> => {
  const counts: ResealCounts = { scanned: 0, current: 0, stale: 0, unreadable: 0, unreadableKeyIds: [] };
  const noteUnreadable = (keyId: string | undefined): void => {
    counts.unreadable += 1;
    if (keyId !== undefined && !counts.unreadableKeyIds.includes(keyId)) counts.unreadableKeyIds.push(keyId);
  };

  const rows = await adapter.findMany<ProviderRowShape>({ model: SSO_PROVIDER_MODEL });
  for (const row of rows) {
    counts.scanned += 1;
    const config = parseOidcConfig(row.oidcConfig);
    const stored = plaintextSecretOf(config);
    const providerId = asString(row.providerId);
    const orgId = asString(row.organizationId);
    if (config === undefined || stored === undefined) continue;
    if (providerId === undefined || orgId === undefined) {
      noteUnreadable(undefined);
      continue;
    }
    const keyId = asString(row[SSO_CLIENT_SECRET_KEY_ID_FIELD]);

    if (keyId === undefined) {
      counts.stale += 1;
      if (options.dryRun === true) continue;
      await adapter.update({
        model: SSO_PROVIDER_MODEL,
        where: [{ field: "providerId", value: providerId }],
        update: {
          oidcConfig: JSON.stringify({
            ...config,
            [SECRET_FIELD]: await sealSsoClientSecret(sealer, orgId, providerId, stored),
          }),
          [SSO_CLIENT_SECRET_KEY_ID_FIELD]: sealer.keyId,
        },
      });
      continue;
    }

    const state = await sealer.keyState(stored);
    if (state === "current") {
      counts.current += 1;
      continue;
    }
    if (state !== "previous") {
      noteUnreadable(state === "unknown" ? keyId : undefined);
      continue;
    }
    counts.stale += 1;
    if (options.dryRun === true) continue;
    try {
      const rewritten = await resealSsoClientSecret(sealer, orgId, providerId, stored);
      await adapter.update({
        model: SSO_PROVIDER_MODEL,
        where: [{ field: "providerId", value: providerId }],
        update: {
          oidcConfig: JSON.stringify({ ...config, [SECRET_FIELD]: rewritten }),
          [SSO_CLIENT_SECRET_KEY_ID_FIELD]: sealer.keyId,
        },
      });
    } catch {
      counts.stale -= 1;
      noteUnreadable(keyId);
    }
  }
  return counts;
};
