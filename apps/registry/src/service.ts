import path from "node:path";
import type pg from "pg";
import { VibtraError } from "./errors.js";
import { createFileRecordStore, type RecordStore } from "./records/store.js";
import {
  createFileRegistrationAllowlistStore,
  type RegistrationAllowlistStore,
} from "./registration/store.js";
import type { MemberDirectory } from "./tenancy/members.js";
import { createFileOrgStore, createTenancyStore, type TenancyStore } from "./tenancy/store.js";
import { createFileToolStore, type ToolStore } from "./tools/store.js";
import { createFileUsageStore, type UsageStore } from "./usage/store.js";
import { createFilePlanRequestStore, type PlanRequestStore } from "./tenancy/plan-request-store.js";
import { createFileVaultStore, type VaultStore } from "./vault/store.js";
import { createFileGuardStore, type GuardStore } from "./guard/store.js";
import { createFileWorkspaceStore, type WorkspaceStore } from "./workspaces/store.js";
import { createFileMeteringStore, type MeteringStore } from "./metering/store.js";
import { createFileGuardRequestStore, type GuardRequestStore } from "./guard/requests/store.js";

export interface RegistryService {
  records: RecordStore;
  tenancy?: TenancyStore;
  vault?: VaultStore;
  tools?: ToolStore;
  registrationAllowlist?: RegistrationAllowlistStore;
  usage?: UsageStore;
  planRequests?: PlanRequestStore;
  guard?: GuardStore;
  workspaces?: WorkspaceStore;
  metering?: MeteringStore;
  guardRequests?: GuardRequestStore;
  pool?: pg.Pool;
  close(): Promise<void>;
}

export interface RegistryServiceOptions {
  dataDir?: string;
  databaseUrl?: string;
  tenancy?: boolean;
  members?: MemberDirectory;
}

const requireMembers = (options: RegistryServiceOptions): MemberDirectory => {
  if (options.members !== undefined) return options.members;
  throw new VibtraError({
    code: "VALIDATION",
    message: "A tenancy store needs a member directory",
    detail:
      "createRegistryService({ tenancy: true }) also needs { members } — Better Auth owns membership since " +
      "migration 0006, and a tenancy store with no people half would report every org as empty.",
  });
};

export const createRegistryService = async (options: RegistryServiceOptions): Promise<RegistryService> => {
  if (options.databaseUrl !== undefined && options.databaseUrl !== "") {
    const { createPostgresRegistryStores } = await import("./store/postgres.js");
    const { createGuardPostgresStore } = await import("./guard/postgres-store.js");
    const { createWorkspacePostgresStore } = await import("./workspaces/postgres-store.js");
    const { createMeteringPostgresStore } = await import("./metering/postgres-store.js");
    const { createGuardRequestPostgresStore } = await import("./guard/requests/postgres-store.js");
    const stores = createPostgresRegistryStores(options.databaseUrl);
    await stores.migrate();
    return {
      records: stores.records,
      ...(options.tenancy === true
        ? {
            tenancy: createTenancyStore(stores.orgs, requireMembers(options)),
            vault: stores.vault,
            tools: stores.tools,
            registrationAllowlist: stores.registrationAllowlist,
            usage: stores.usage,
            planRequests: stores.planRequests,
            guard: createGuardPostgresStore(stores.pool),
            workspaces: createWorkspacePostgresStore(stores.pool),
            metering: createMeteringPostgresStore(stores.pool),
            guardRequests: createGuardRequestPostgresStore(stores.pool),
          }
        : {}),
      pool: stores.pool,
      close: async () => {
        await stores.close();
      },
    };
  }

  const dataDir = options.dataDir;
  if (dataDir === undefined || dataDir === "") {
    throw new VibtraError({
      code: "VALIDATION",
      message: "The registry needs somewhere to store data",
      detail: "createRegistryService requires dataDir when no databaseUrl is configured",
    });
  }
  const records = await createFileRecordStore(path.join(dataDir, "records.jsonl"));
  const tenancy =
    options.tenancy === true
      ? createTenancyStore(await createFileOrgStore(path.join(dataDir, "tenancy.json")), requireMembers(options))
      : undefined;
  const vault = options.tenancy === true ? await createFileVaultStore(path.join(dataDir, "vault.json")) : undefined;
  const tools = options.tenancy === true ? await createFileToolStore(path.join(dataDir, "tools.json")) : undefined;
  const usage =
    options.tenancy === true ? await createFileUsageStore(path.join(dataDir, "usage.json")) : undefined;
  const registrationAllowlist =
    options.tenancy === true
      ? await createFileRegistrationAllowlistStore(path.join(dataDir, "registration-allowlist.json"))
      : undefined;
  const planRequests =
    options.tenancy === true
      ? await createFilePlanRequestStore(path.join(dataDir, "plan-requests.json"))
      : undefined;
  const guard = options.tenancy === true ? await createFileGuardStore(path.join(dataDir, "guard.json")) : undefined;
  const workspaces = options.tenancy === true ? await createFileWorkspaceStore(path.join(dataDir, "workspaces.json")) : undefined;
  const metering = options.tenancy === true ? await createFileMeteringStore(path.join(dataDir, "metering.json")) : undefined;
  const guardRequests = options.tenancy === true ? await createFileGuardRequestStore(path.join(dataDir, "workspace-policy.json")) : undefined;
  return {
    records,
    ...(tenancy !== undefined ? { tenancy } : {}),
    ...(vault !== undefined ? { vault } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(registrationAllowlist !== undefined ? { registrationAllowlist } : {}),
    ...(usage !== undefined ? { usage } : {}),
    ...(planRequests !== undefined ? { planRequests } : {}),
    ...(guard !== undefined ? { guard } : {}),
    ...(workspaces !== undefined ? { workspaces } : {}),
    ...(metering !== undefined ? { metering } : {}),
    ...(guardRequests !== undefined ? { guardRequests } : {}),
    close: async () => {},
  };
};
