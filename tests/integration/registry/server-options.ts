import { readFile } from "node:fs/promises";
import path from "node:path";
import type { HostedConfig } from "@vibtra/registry";
import type { RegistryServerOptions } from "@vibtra/registry/src/server.ts";
import { createPostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";

export type Configure = (options: RegistryServerOptions) => RegistryServerOptions;

export const withHosted =
  (patch: (hosted: HostedConfig) => HostedConfig): Configure =>
  (options) => {
    const config = options.config;
    if (config?.hosted === undefined) throw new Error("startRegistry did not build a hosted configuration");
    return { ...options, config: { ...config, hosted: patch(config.hosted) } };
  };

export interface ManualClock {
  now(): Date;
  set(at: string): void;
  advance(ms: number): void;
}

export const manualClock = (start: Date = new Date()): ManualClock => {
  let current = start.getTime();
  return {
    now: () => new Date(current),
    set: (at) => {
      const next = new Date(at).getTime();
      if (Number.isNaN(next)) throw new Error(`not an instant: ${at}`);
      current = next;
    },
    advance: (ms) => {
      current += ms;
    },
  };
};

export interface Storage {
  readonly dataDir: string;
  readonly databaseUrl: string | undefined;
}

export const capturingStorage =
  (sink: (storage: Storage) => void, next: Configure = (options) => options): Configure =>
  (options) => {
    if (options.dataDir === undefined) throw new Error("startRegistry did not set a data folder");
    sink({ dataDir: options.dataDir, databaseUrl: options.config?.databaseUrl });
    return next(options);
  };

export const sqlRows = async <Row>(databaseUrl: string, sql: string, values: unknown[] = []): Promise<Row[]> => {
  const stores = createPostgresRegistryStores(databaseUrl);
  try {
    return (await stores.pool.query(sql, values)).rows as Row[];
  } finally {
    await stores.close();
  }
};

export interface PersistedAuditRow {
  readonly event: string;
  readonly actorKind: string;
  readonly detail?: string | null;
}

export const persistedVaultAudit = async (storage: Storage): Promise<PersistedAuditRow[]> => {
  if (storage.databaseUrl !== undefined) {
    return sqlRows<PersistedAuditRow>(storage.databaseUrl, 'SELECT event, actor_kind AS "actorKind", detail FROM vault_audit ORDER BY seq');
  }
  const file = JSON.parse(await readFile(path.join(storage.dataDir, "vault.json"), "utf8")) as { audit: PersistedAuditRow[] };
  return file.audit;
};

const inCi = (): boolean => !["", "0", "false"].includes(process.env.CI ?? "");

export const postgresMissing = (): boolean => {
  if (process.env.VIBTRA_TEST_DATABASE_URL !== undefined) return false;
  if (inCi()) throw new Error("VIBTRA_TEST_DATABASE_URL is required when CI is set: the Postgres-only tests must run there, not skip");
  return true;
};
