import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { VibtraError } from "../errors.js";
import { ConnectorConnectionSlug, ConnectorProbeStatus, ConnectorProviderIdEnum } from "./connector.js";
import { DynamicConfig } from "./dynamic.js";
import { emptyResealCounts, tallySealedRow, type ResealCounts, type VaultSealer } from "./seal.js";

export const CONNECTION_ID_PATTERN = /^conn_[0-9a-f]{16}$/;

export const StoredProbe = z
  .object({
    status: ConnectorProbeStatus,
    checkedAt: z.string().min(1),
    missingScopes: z.array(z.string().min(1)),
    detail: z.string().min(1).optional(),
  })
  .strict();
export type StoredProbe = z.infer<typeof StoredProbe>;

export const OrgConnectionRow = z.object({
  connectionId: z.string().regex(CONNECTION_ID_PATTERN),
  orgId: z.string().min(1),
  provider: ConnectorProviderIdEnum,
  catalogId: z.string().min(1).optional(),
  slug: ConnectorConnectionSlug,
  displayName: z.string().min(1).max(64),
  grantedScopes: z.array(z.string().min(1)).min(1),
  scopeKind: z.string().min(1),
  scopeSubjects: z.array(z.string().min(1)),
  credentialMode: z.enum(["static", "dynamic"]).optional(),
  dynamicConfig: DynamicConfig.optional(),
  credentialRef: z.string().min(1).optional(),
  credentialRefs: z.record(z.string().min(1), z.string().min(1)).optional(),
  expiresAt: z.string().min(1).optional(),
  lastProbe: StoredProbe.optional(),
  region: z.string().min(1).max(64).optional(),
  baseUrlHost: z
    .string()
    .regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/)
    .optional(),
  sealedCredential: z.string().min(1),
  keyId: z.string().min(1),
  createdBy: z.string().min(1),
  createdAt: z.string(),
  updatedBy: z.string().min(1),
  updatedAt: z.string(),
});
export type OrgConnectionRow = z.infer<typeof OrgConnectionRow>;

export const VAULT_AUDIT_EVENTS = [
  "connection.added",
  "connection.rescoped",
  "connection.region_set",
  "credential.replaced",
  "connection.removed",
  "door.fetch",
  "door.describe",
  "connection.tested",
  "deploy-target.added",
  "deploy-target.removed",
  "deploy-target.used",
  "deploy-target.default",
  "dynamic.mint",
  "dynamic.renew",
  "dynamic.revoke",
  "integration.connect",
  "integration.disconnect",
  "integration.resolve",
  "integration.writeback",
  "policy.changed",
  "group.created",
  "group.renamed",
  "group.deleted",
  "group.member.added",
  "group.member.removed",
  "org.exported",
  "org.renamed",
  "org.handle_changed",
  "plan.changed",
  "limit.changed",
  "plan.migrated",
  "billing.status_changed",
  "sessions.revoked",
  "model-gateway.added",
  "model-gateway.removed",
  "model-gateway.tested",
  "model-gateway.leased",
  "engine-session.minted",
  "engine-session.revoked",
  "git.connect",
  "git.disconnect",
  "git.token_minted",
  "code.fallback_migrated",
  "project.pulled",
  "project.pushed",
  "model-gateway.settings_changed",
  "model-gateway.discovered",
  "model-gateway.key_replaced",
  "host.enrolment_minted",
  "host.enrolled",
  "host.renewed",
  "host.revoked",
  "host.pinned",
  "host.unpinned",
  "host.tier_changed",
  "host.drained",
  "host.undrained",
  "host.failed_over",
  "host.fenced",
  "cli.login",
  "cli.logout",
  "policy.changed",
  "policy.request.decided",
  "policy.grant.revoked",
  "policy.push.pending",
  "billing.spending_cap_changed",
  "usage.quota_stop",
  "org.waitlist_admitted",
  "usage.report_exceeds_meter",
  "usage.credit_due",
  "workspace.stopped_by_admin",
  "appbox.promotion_requested",
  "appbox.promotion_approved",
  "appbox.promotion_declined",
  "appbox.built",
  "appbox.activated",
  "appbox.build_failed",
  "appbox.owner_left",
  "appbox.owner_set",
  "appbox.secret_set",
  "appbox.secret_delivered",
  "appbox.woke",
  "appbox.slept",
  "appbox.crashed",
  "appbox.failed",
  "appbox.parked",
  "appbox.deleted",
  "appbox.restored",
  "appbox.moved",
  "appbox.backup",
  "appbox.backup_reaped",
  "appbox.storage_warning",
  "appbox.object_key_unwrapped",
  "appbox.image_moved",
  "appbox.data_lost",
  "appbox.build_started",
  "appbox.logs_read",
  "appbox.tier_move_pending",
  "appbox.failover_kept",
] as const;
export const VaultAuditEvent = z.enum(VAULT_AUDIT_EVENTS);
export type VaultAuditEvent = z.infer<typeof VaultAuditEvent>;

export const VaultAuditRow = z.object({
  auditId: z.string().min(1),
  orgId: z.string().min(1),
  at: z.string(),
  event: VaultAuditEvent,
  actorKind: z.enum(["admin", "door", "member", "app"]),
  actor: z.string().min(1),
  tokenId: z.string().min(1).optional(),
  tokenName: z.string().min(1).optional(),
  connectionId: z.string().min(1).optional(),
  provider: z.string().min(1).optional(),
  toolId: z.string().min(1).optional(),
  granted: z.number().int().min(0).optional(),
  withheld: z.number().int().min(0).optional(),
  outcome: z.enum(["allowed", "refused"]),
  detail: z.string().optional(),
  seq: z.number().int().min(0).optional(),
});
export type VaultAuditRow = z.infer<typeof VaultAuditRow>;

export interface VaultStore {
  listConnections(orgId: string): Promise<OrgConnectionRow[]>;
  getConnection(orgId: string, connectionId: string): Promise<OrgConnectionRow | undefined>;
  countConnections(orgId: string): Promise<number>;
  createConnection(row: OrgConnectionRow): Promise<void>;
  updateScope(args: {
    orgId: string;
    connectionId: string;
    scopeKind: string;
    scopeSubjects: string[];
    updatedBy: string;
    updatedAt: string;
  }): Promise<boolean>;
  setRegion(args: {
    orgId: string;
    connectionId: string;
    region: string | null;
    updatedBy: string;
    updatedAt: string;
  }): Promise<boolean>;
  setBaseUrlHost(args: { orgId: string; connectionId: string; baseUrlHost: string }): Promise<boolean>;
  setDynamicConfig(args: {
    orgId: string;
    connectionId: string;
    dynamicConfig: DynamicConfig;
    updatedBy: string;
    updatedAt: string;
  }): Promise<boolean>;
  replaceCredential(args: {
    orgId: string;
    connectionId: string;
    sealedCredential: string;
    keyId: string;
    grantedScopes: string[];
    expiresAt?: string | null;
    updatedBy: string;
    updatedAt: string;
  }): Promise<boolean>;
  recordProbe(args: { orgId: string; connectionId: string; lastProbe: StoredProbe }): Promise<boolean>;
  removeConnection(orgId: string, connectionId: string): Promise<OrgConnectionRow | undefined>;
  appendAudit(row: VaultAuditRow): Promise<void>;
  listAudit(orgId: string, limit: number): Promise<VaultAuditRow[]>;
  listAuditPage(
    orgId: string,
    args: { limit: number; before?: string },
  ): Promise<{ rows: VaultAuditRow[]; nextCursor?: string }>;
  resealAll(sealer: VaultSealer, options?: { dryRun?: boolean }): Promise<ResealCounts>;
}

const VaultFile = z.object({
  connections: z.array(OrgConnectionRow).default([]),
  audit: z.array(VaultAuditRow).default([]),
});

export const createFileVaultStore = async (file: string): Promise<VaultStore> => {
  let connections: OrgConnectionRow[] = [];
  let audit: VaultAuditRow[] = [];

  let nextSeq = 1;

  try {
    const parsed = VaultFile.parse(JSON.parse(await readFile(file, "utf8")));
    connections = parsed.connections;
    audit = parsed.audit.map((row, index) => (row.seq === undefined ? { ...row, seq: index + 1 } : row));
    nextSeq = audit.reduce((highest, row) => Math.max(highest, row.seq ?? 0), 0) + 1;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ connections, audit }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  const find = (orgId: string, connectionId: string): OrgConnectionRow | undefined =>
    connections.find((c) => c.orgId === orgId && c.connectionId === connectionId);

  return {
    async listConnections(orgId) {
      return connections.filter((c) => c.orgId === orgId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async getConnection(orgId, connectionId) {
      return find(orgId, connectionId);
    },

    async countConnections(orgId) {
      return connections.filter((c) => c.orgId === orgId).length;
    },

    async createConnection(row) {
      const parsed = OrgConnectionRow.parse(row);
      if (connections.some((c) => c.connectionId === parsed.connectionId)) {
        throw new VibtraError({ code: "VALIDATION", message: "Connection id already exists", detail: parsed.connectionId });
      }
      if (connections.some((c) => c.orgId === parsed.orgId && c.provider === parsed.provider && c.slug === parsed.slug)) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "That handle is already used by another connection",
          detail: `org ${parsed.orgId} already has a ${parsed.provider} connection with handle "${parsed.slug}" — handles decide the environment variable names, so they must be unique per provider`,
        });
      }
      connections.push(parsed);
      await persist();
    },

    async updateScope({ orgId, connectionId, scopeKind, scopeSubjects, updatedBy, updatedAt }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      row.scopeKind = scopeKind;
      row.scopeSubjects = scopeSubjects;
      row.updatedBy = updatedBy;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },

    async setDynamicConfig({ orgId, connectionId, dynamicConfig, updatedBy, updatedAt }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      row.dynamicConfig = DynamicConfig.parse(dynamicConfig);
      row.updatedBy = updatedBy;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },

    async replaceCredential({ orgId, connectionId, sealedCredential, keyId, grantedScopes, expiresAt, updatedBy, updatedAt }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      row.sealedCredential = sealedCredential;
      row.keyId = keyId;
      row.grantedScopes = grantedScopes;
      if (expiresAt === null) delete row.expiresAt;
      else if (expiresAt !== undefined) row.expiresAt = expiresAt;
      row.updatedBy = updatedBy;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },

    async recordProbe({ orgId, connectionId, lastProbe }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      row.lastProbe = StoredProbe.parse(lastProbe);
      await persist();
      return true;
    },

    async setRegion({ orgId, connectionId, region, updatedBy, updatedAt }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      if (region === null) delete row.region;
      else row.region = region;
      row.updatedBy = updatedBy;
      row.updatedAt = updatedAt;
      await persist();
      return true;
    },

    async setBaseUrlHost({ orgId, connectionId, baseUrlHost }) {
      const row = find(orgId, connectionId);
      if (row === undefined) return false;
      row.baseUrlHost = OrgConnectionRow.shape.baseUrlHost.unwrap().parse(baseUrlHost);
      await persist();
      return true;
    },

    async removeConnection(orgId, connectionId) {
      const row = find(orgId, connectionId);
      if (row === undefined) return undefined;
      connections = connections.filter((c) => c !== row);
      await persist();
      return row;
    },

    async appendAudit(row) {
      audit.push(VaultAuditRow.parse({ ...row, seq: nextSeq++ }));
      await persist();
    },

    async listAudit(orgId, limit) {
      return audit
        .filter((a) => a.orgId === orgId)
        .slice()
        .reverse()
        .slice(0, limit);
    },

    async listAuditPage(orgId, args) {
      const before = args.before === undefined ? undefined : Number(args.before);
      const mine = audit
        .filter((a) => a.orgId === orgId)
        .filter((a) => before === undefined || Number.isNaN(before) || (a.seq ?? 0) < before)
        .slice()
        .sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0));
      const rows = mine.slice(0, args.limit);
      const last = rows[rows.length - 1];
      return {
        rows,
        ...(rows.length === args.limit && last?.seq !== undefined
          ? { nextCursor: String(last.seq) }
          : {}),
      };
    },

    async resealAll(sealer, options) {
      const counts = emptyResealCounts();
      const dryRun = options?.dryRun === true;
      let written = 0;
      for (const row of connections) {
        if (!(await tallySealedRow(counts, sealer, row.sealedCredential))) continue;
        if (dryRun) continue;
        row.sealedCredential = await sealer.reseal(row.sealedCredential, {
          orgId: row.orgId,
          connectionId: row.connectionId,
        });
        row.keyId = sealer.keyId;
        written += 1;
      }
      if (written > 0) await persist();
      return counts;
    },
  };
};
