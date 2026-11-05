import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { VibtraError } from "../errors.js";
import { parseRegistryRecord, serializeRegistryRecord, type RegistryRecord } from "../records/ledger.js";
import { planFor } from "../config.js";
import { boundOf, type AppendOutcome, type RecordStore } from "../records/store.js";
import {
  AllowlistRow,
  allowlistSubjectsFor,
  mintAllowlistId,
  type RegistrationAllowlistStore,
} from "../registration/store.js";
import { deriveOrgHandle, isReservedOrgHandle } from "../tenancy/handle.js";
import { BillingEventRow, OrgHandleAliasRow, OrgRow, OrgTokenRow, type OrgStore } from "../tenancy/store.js";
import { PlanChangeRequestRow, type PlanRequestStore } from "../tenancy/plan-request-store.js";
import { resealToolSecret } from "../tools/secret.js";
import { OrgToolRow, ToolVendorDeployment, type ToolStore } from "../tools/store.js";
import { UsageSnapshotRow, type UsageStore } from "../usage/store.js";
import {
  createPostgresCoordinator,
  ensureCoordinationSchema,
  type Coordinated,
  type Coordinator,
} from "./coordination.js";
import { emptyResealCounts, tallySealedRow } from "../vault/seal.js";
import { OrgConnectionRow, StoredProbe, VaultAuditRow, type VaultStore } from "../vault/store.js";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../migrations", import.meta.url));

const migrationStem = (file: string): string => file.replace(/^\d+/, "");

const orphanMigrationRefusal = (applied: readonly string[], onDisk: readonly string[]): VibtraError | undefined => {
  const present = new Set(onDisk);
  const orphans = applied.filter((name) => !present.has(name)).sort();
  if (orphans.length === 0) return undefined;

  const recorded = new Set(applied);
  const remedies = orphans.map((orphan) => {
    const twins = onDisk.filter((f) => migrationStem(f) === migrationStem(orphan));
    const twin = twins.length === 1 ? twins[0] : undefined;
    if (twin === undefined) {
      return `  ${orphan} — no file in this directory carries that name. Restore it (git show <commit>:apps/registry/migrations/${orphan}), or, if it was deleted on purpose, drop the row: DELETE FROM registry_migrations WHERE name='${orphan}';`;
    }
    const already = recorded.has(twin)
      ? ` (${twin} is already recorded here, so that rename has happened and this row is a leftover — then it is DELETE FROM registry_migrations WHERE name='${orphan}'; instead.)`
      : "";
    return `  ${orphan} — looks renumbered to ${twin}: UPDATE registry_migrations SET name='${twin}' WHERE name='${orphan}';${already}`;
  });

  return new VibtraError({
    code: "INTERNAL",
    message:
      `The migration directory is corrupt, the following files are missing: ${orphans.join(", ")}. ` +
      `Each name is recorded in registry_migrations but is no longer a file in apps/registry/migrations, ` +
      `so this registry will not start and NOTHING has been applied — re-running a renamed migration under its new number is what took the dev registry down on 13 September 2026. ` +
      `Fix the bookkeeping, then boot again:\n${remedies.join("\n")}\n` +
      `The alternative to every edit above is to restore the missing file itself, which leaves the table alone.`,
    detail: `${orphans.length} recorded migration(s) with no file; ${applied.length} recorded, ${onDisk.length} .sql file(s) in ${MIGRATIONS_DIR}`,
  });
};

export interface PostgresRegistryStores {
  records: RecordStore;
  orgs: OrgStore & Coordinated;
  vault: VaultStore;
  tools: ToolStore;
  registrationAllowlist: RegistrationAllowlistStore;
  usage: UsageStore;
  planRequests: PlanRequestStore;
  pool: pg.Pool;
  coordinator: Coordinator;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

const isUniqueViolation = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";

const orgOf = (value: unknown): string =>
  typeof value === "object" && value !== null && typeof (value as { orgId?: unknown }).orgId === "string"
    ? (value as { orgId: string }).orgId
    : "";

const toolOf = (value: unknown): string | null =>
  typeof value === "object" && value !== null && typeof (value as { toolId?: unknown }).toolId === "string"
    ? (value as { toolId: string }).toolId
    : null;

const typeOf = (value: unknown): string =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string"
    ? (value as { type: string }).type
    : "";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));

const isoDay = (v: Date): string =>
  `${String(v.getFullYear()).padStart(4, "0")}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;

export const createPostgresRegistryStores = (databaseUrl: string): PostgresRegistryStores => {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const coordinator = createPostgresCoordinator(pool);

  const records: RecordStore = {
    async append(record) {
      const line = serializeRegistryRecord(record);
      const res = await pool.query(
        `INSERT INTO registry_records (org_id, record_id, tool_id, type, known, body)
         VALUES ($1, $2, $3, $4, TRUE, $5::jsonb)
         ON CONFLICT (org_id, record_id) DO NOTHING`,
        [record.orgId, record.recordId, record.toolId, record.type, line],
      );
      return (res.rowCount ?? 0) > 0 ? "appended" : ("duplicate" as AppendOutcome);
    },

    async appendUnknown(raw, recordId) {
      const res = await pool.query(
        `INSERT INTO registry_records (org_id, record_id, tool_id, type, known, body)
         VALUES ($1, $2, $3, $4, FALSE, $5::jsonb)
         ON CONFLICT (org_id, record_id) DO NOTHING`,
        [orgOf(raw), recordId, toolOf(raw), typeOf(raw), JSON.stringify(raw)],
      );
      return (res.rowCount ?? 0) > 0 ? "appended" : ("duplicate" as AppendOutcome);
    },

    async list(filter = {}) {
      const where: string[] = ["known"];
      const params: unknown[] = [];
      if (filter.orgId !== undefined) {
        params.push(filter.orgId);
        where.push(`org_id = $${params.length}`);
      }
      if (filter.toolId !== undefined) {
        params.push(filter.toolId);
        where.push(`tool_id = $${params.length}`);
      }
      if (filter.type !== undefined) {
        params.push(filter.type);
        where.push(`type = $${params.length}`);
      }
      if (filter.before !== undefined) {
        params.push(filter.before);
        where.push(`body ->> 'recordedAt' < $${params.length}`);
      }
      const bound = boundOf(filter);
      let sql: string;
      if (bound === undefined) {
        sql = `SELECT body FROM registry_records WHERE ${where.join(" AND ")} ORDER BY seq ${
          filter.newestFirst === true ? "DESC" : "ASC"
        }`;
      } else {
        params.push(bound);
        const inner = `SELECT body, seq FROM registry_records WHERE ${where.join(
          " AND ",
        )} ORDER BY seq DESC LIMIT $${params.length}`;
        sql =
          filter.newestFirst === true
            ? `SELECT body FROM (${inner}) newest ORDER BY seq DESC`
            : `SELECT body FROM (${inner}) newest ORDER BY seq ASC`;
      }
      const res = await pool.query(sql, params);
      const out: RegistryRecord[] = [];
      for (const row of res.rows as Array<{ body: unknown }>) {
        const parsed = parseRegistryRecord(row.body);
        if (parsed.kind === "record") out.push(parsed.record);
      }
      return out;
    },

    async purgeOrg(orgId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("ALTER TABLE registry_records DISABLE TRIGGER registry_records_append_only");
        const res = await client.query(`DELETE FROM registry_records WHERE org_id = $1`, [orgId]);
        await client.query("ALTER TABLE registry_records ENABLE TRIGGER registry_records_append_only");
        await client.query("COMMIT");
        return res.rowCount ?? 0;
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
  };

  const orgRow = (r: Record<string, unknown>): OrgRow =>
    OrgRow.parse({
      orgId: r.org_id,
      name: r.name,
      handle: r.handle ?? undefined,
      domain: r.domain ?? undefined,
      plan: r.plan ?? undefined,
      userLimit: r.user_limit ?? undefined,
      liveToolLimit: r.live_tool_limit ?? undefined,
      connectionLimit: r.connection_limit ?? undefined,
      capabilities: r.capabilities == null ? undefined : (r.capabilities as string[]),
      joinPolicy: r.join_policy ?? undefined,
      billingStatus: r.billing_status ?? undefined,
      billingStatusAt: r.billing_status_at == null ? undefined : iso(r.billing_status_at),
      trialEndsAt: r.trial_ends_at == null ? undefined : iso(r.trial_ends_at),
      designPartner:
        r.design_partner_until == null
          ? undefined
          : {
              until: r.design_partner_until instanceof Date
                ? isoDay(r.design_partner_until)
                : String(r.design_partner_until).slice(0, 10),
              discountPct: Number(r.design_partner_discount_pct ?? 0),
            },
      stripeCustomerId: r.stripe_customer_id ?? undefined,
      stripeSubscriptionId: r.stripe_subscription_id ?? undefined,
      stripeSubscriptionStatus: r.stripe_subscription_status ?? undefined,
      stripePriceId: r.stripe_price_id ?? undefined,
      stripeCurrentPeriodEnd: r.stripe_current_period_end == null ? undefined : iso(r.stripe_current_period_end),
      stripeCancelAtPeriodEnd: r.stripe_cancel_at_period_end ?? undefined,
      stripeSeats: r.stripe_seats == null ? undefined : Number(r.stripe_seats),
      stripeStateAt: r.stripe_state_at == null ? undefined : iso(r.stripe_state_at),
      stripeMeteredSubscriptionId: r.stripe_metered_subscription_id ?? undefined,
      status: r.status ?? "active",
      admittedAt: r.admitted_at == null ? undefined : iso(r.admitted_at),
      createdAt: iso(r.created_at),
      closedAt: r.closed_at == null ? undefined : iso(r.closed_at),
      closedBy: r.closed_by ?? undefined,
      purgeAfter: r.purge_after == null ? undefined : iso(r.purge_after),
    });

  const tokenRow = (r: Record<string, unknown>): OrgTokenRow =>
    OrgTokenRow.parse({
      tokenId: r.token_id,
      orgId: r.org_id,
      name: r.name,
      tokenHash: r.token_hash,
      createdBy: r.created_by,
      holder: r.holder ?? undefined,
      createdAt: iso(r.created_at),
      revokedAt: r.revoked_at == null ? undefined : iso(r.revoked_at),
      onepasswordItemId: r.onepassword_item_id ?? undefined,
    });

  const orgs: OrgStore & Coordinated = {
    coordinator,
    async getOrg(orgId) {
      const res = await pool.query(`SELECT * FROM orgs WHERE org_id = $1`, [orgId]);
      return res.rows[0] === undefined ? undefined : orgRow(res.rows[0] as Record<string, unknown>);
    },
    async findOrgByDomain(domain) {
      const res = await pool.query(`SELECT * FROM orgs WHERE domain = $1`, [domain]);
      return res.rows[0] === undefined ? undefined : orgRow(res.rows[0] as Record<string, unknown>);
    },
    async findOrgByHandle(handle) {
      const wanted = handle.trim().toLowerCase();
      if (wanted === "") return undefined;
      const res = await pool.query(
        `SELECT o.* , (o.handle = $1) AS live
           FROM orgs o
           LEFT JOIN org_handle_aliases a ON a.org_id = o.org_id
          WHERE o.handle = $1 OR a.handle = $1
          ORDER BY live DESC
          LIMIT 1`,
        [wanted],
      );
      return res.rows[0] === undefined ? undefined : orgRow(res.rows[0] as Record<string, unknown>);
    },
    async listOrgHandleAliases(orgId) {
      const res = await pool.query(
        `SELECT handle, org_id, retired_at FROM org_handle_aliases WHERE org_id = $1 ORDER BY retired_at DESC`,
        [orgId],
      );
      return (res.rows as Record<string, unknown>[]).map((r) =>
        OrgHandleAliasRow.parse({ handle: r.handle, orgId: r.org_id, retiredAt: iso(r.retired_at) }),
      );
    },
    async createOrg(org) {
      const parsed = OrgRow.parse(org);
      if (parsed.handle === undefined) {
        parsed.handle = await deriveOrgHandle(
          parsed.domain ?? parsed.name,
          async (candidate) => {
            const res = await pool.query(
              `SELECT 1 FROM orgs WHERE handle = $1 UNION ALL SELECT 1 FROM org_handle_aliases WHERE handle = $1`,
              [candidate],
            );
            return (res.rowCount ?? 0) > 0;
          },
          parsed.orgId,
        );
      } else if (isReservedOrgHandle(parsed.handle)) {
        throw new VibtraError({ code: "VALIDATION", message: "That handle is reserved", detail: parsed.handle });
      }
      try {
        await pool.query(
          `INSERT INTO orgs (org_id, name, handle, domain, plan, user_limit, live_tool_limit, connection_limit,
                              capabilities, trial_ends_at, created_at, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            parsed.orgId,
            parsed.name,
            parsed.handle,
            parsed.domain ?? null,
            parsed.plan,
            parsed.userLimit ?? null,
            parsed.liveToolLimit ?? null,
            parsed.connectionLimit ?? null,
            parsed.capabilities ?? null,
            parsed.trialEndsAt ?? null,
            parsed.createdAt,
            parsed.status,
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new VibtraError({
            code: "VALIDATION",
            message: "That org id, domain or handle already exists",
            detail: `${parsed.orgId} / ${parsed.domain ?? "(no domain)"} / ${parsed.handle ?? "(no handle)"}`,
          });
        }
        throw e;
      }
      return parsed;
    },
    async setPlan(orgId, plan) {
      if (planFor(plan).id !== plan) {
        throw new VibtraError({
          code: "VALIDATION",
          message: "No such plan",
          detail: `${JSON.stringify(plan)} is not a bucket in REGISTRY_PLANS (apps/registry/src/config.ts)`,
        });
      }
      const res = await pool.query(`UPDATE orgs SET plan = $2 WHERE org_id = $1`, [orgId, plan]);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setBillingStatus(orgId, status, at) {
      const res = await pool.query(
        `UPDATE orgs SET billing_status = $2, billing_status_at = $3 WHERE org_id = $1`,
        [orgId, status, at],
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setOrgStatus(orgId, status, at) {
      const res = await pool.query(
        `UPDATE orgs SET status = $2, admitted_at = CASE WHEN $2 = 'active' THEN $3::timestamptz ELSE admitted_at END WHERE org_id = $1`,
        [orgId, status, at],
      );
      if ((res.rowCount ?? 0) === 0) throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
    },
    async listWaitlistedOrgs() {
      const res = await pool.query(`SELECT * FROM orgs WHERE status = 'waitlisted' ORDER BY created_at`);
      return (res.rows as Record<string, unknown>[]).map(orgRow);
    },
    async setStripeBilling(orgId, patch) {
      const columns: Record<string, string> = {
        stripeCustomerId: "stripe_customer_id",
        stripeSubscriptionId: "stripe_subscription_id",
        stripeSubscriptionStatus: "stripe_subscription_status",
        stripePriceId: "stripe_price_id",
        stripeCurrentPeriodEnd: "stripe_current_period_end",
        stripeCancelAtPeriodEnd: "stripe_cancel_at_period_end",
        stripeSeats: "stripe_seats",
        stripeStateAt: "stripe_state_at",
        stripeMeteredSubscriptionId: "stripe_metered_subscription_id",
      };
      const sets: string[] = [];
      const values: unknown[] = [orgId];
      for (const [key, column] of Object.entries(columns)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        values.push(value);
        sets.push(`${column} = $${values.length}`);
      }
      if (sets.length === 0) {
        const found = await pool.query(`SELECT 1 FROM orgs WHERE org_id = $1`, [orgId]);
        if ((found.rowCount ?? 0) === 0) {
          throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
        }
        return;
      }
      const res = await pool.query(`UPDATE orgs SET ${sets.join(", ")} WHERE org_id = $1`, values);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async appendBillingEvent(row) {
      const parsed = BillingEventRow.parse(row);
      const res = await pool.query(
        `INSERT INTO billing_events (event_id, org_id, type, stripe_created, livemode, outcome, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          parsed.eventId,
          parsed.orgId ?? null,
          parsed.type,
          parsed.stripeCreated,
          parsed.livemode,
          parsed.outcome,
          parsed.receivedAt,
        ],
      );
      return (res.rowCount ?? 0) === 0 ? "duplicate" : "inserted";
    },
    async hasBillingEvent(eventId) {
      const res = await pool.query(`SELECT 1 FROM billing_events WHERE event_id = $1`, [eventId]);
      return (res.rowCount ?? 0) > 0;
    },
    async listBillingEvents(orgId) {
      const res = await pool.query(
        `SELECT * FROM billing_events WHERE org_id = $1 ORDER BY received_at DESC, event_id DESC`,
        [orgId],
      );
      return res.rows.map((r: Record<string, unknown>) =>
        BillingEventRow.parse({
          eventId: r.event_id,
          orgId: r.org_id ?? undefined,
          type: r.type,
          stripeCreated: iso(r.stripe_created),
          livemode: r.livemode,
          outcome: r.outcome,
          receivedAt: iso(r.received_at),
        }),
      );
    },
    async setDesignPartner(orgId, designPartner) {
      const res = await pool.query(
        `UPDATE orgs SET design_partner_until = $2, design_partner_discount_pct = $3 WHERE org_id = $1`,
        [orgId, designPartner?.until ?? null, designPartner?.discountPct ?? null],
      );
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setOrgName(orgId, name) {
      const res = await pool.query(`UPDATE orgs SET name = $2 WHERE org_id = $1`, [orgId, name]);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setUserLimit(orgId, limit) {
      const res = await pool.query(`UPDATE orgs SET user_limit = $2 WHERE org_id = $1`, [orgId, limit ?? null]);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setLiveToolLimit(orgId, limit) {
      const res = await pool.query(`UPDATE orgs SET live_tool_limit = $2 WHERE org_id = $1`, [orgId, limit ?? null]);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async setConnectionLimit(orgId, limit) {
      const res = await pool.query(`UPDATE orgs SET connection_limit = $2 WHERE org_id = $1`, [orgId, limit ?? null]);
      if ((res.rowCount ?? 0) === 0) {
        throw new VibtraError({ code: "VALIDATION", message: "No such org", detail: orgId });
      }
    },
    async createToken(token) {
      const parsed = OrgTokenRow.parse(token);
      try {
        await pool.query(
          `INSERT INTO org_tokens (token_id, org_id, name, token_hash, created_by, holder, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [parsed.tokenId, parsed.orgId, parsed.name, parsed.tokenHash, parsed.createdBy, parsed.holder ?? null, parsed.createdAt],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new VibtraError({ code: "VALIDATION", message: "Token already exists", detail: parsed.tokenId });
        }
        throw e;
      }
    },
    async findTokenByHash(tokenHash) {
      const res = await pool.query(`SELECT * FROM org_tokens WHERE token_hash = $1`, [tokenHash]);
      return res.rows[0] === undefined ? undefined : tokenRow(res.rows[0] as Record<string, unknown>);
    },
    async listTokens(orgId) {
      const res = await pool.query(`SELECT * FROM org_tokens WHERE org_id = $1 ORDER BY created_at`, [orgId]);
      return (res.rows as Array<Record<string, unknown>>).map(tokenRow);
    },
    async revokeToken(orgId, tokenId, at) {
      const res = await pool.query(
        `UPDATE org_tokens SET revoked_at = $3 WHERE org_id = $1 AND token_id = $2 AND revoked_at IS NULL`,
        [orgId, tokenId, at],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listOrgs() {
      const res = await pool.query(`SELECT * FROM orgs ORDER BY created_at`);
      return (res.rows as Array<Record<string, unknown>>).map(orgRow);
    },
  };


  const connectionRow = (r: Record<string, unknown>): OrgConnectionRow =>
    OrgConnectionRow.parse({
      connectionId: r.connection_id,
      orgId: r.org_id,
      provider: r.provider,
      catalogId: r.catalog_id ?? undefined,
      slug: r.slug,
      displayName: r.display_name,
      grantedScopes: r.granted_scopes,
      scopeKind: r.scope_kind,
      scopeSubjects: r.scope_subjects,
      credentialMode: r.credential_mode ?? undefined,
      dynamicConfig: r.dynamic_config ?? undefined,
      credentialRef: r.credential_ref ?? undefined,
      credentialRefs: r.credential_refs ?? undefined,
      expiresAt: r.expires_at === null || r.expires_at === undefined ? undefined : iso(r.expires_at),
      lastProbe: r.last_probe ?? undefined,
      region: r.region ?? undefined,
      baseUrlHost: r.base_url_host ?? undefined,
      sealedCredential: r.sealed_credential,
      keyId: r.key_id,
      createdBy: r.created_by,
      createdAt: iso(r.created_at),
      updatedBy: r.updated_by,
      updatedAt: iso(r.updated_at),
    });

  const auditRow = (r: Record<string, unknown>): VaultAuditRow =>
    VaultAuditRow.parse({
      auditId: r.audit_id,
      orgId: r.org_id,
      at: iso(r.at),
      event: r.event,
      actorKind: r.actor_kind,
      actor: r.actor,
      tokenId: r.token_id ?? undefined,
      tokenName: r.token_name ?? undefined,
      connectionId: r.connection_id ?? undefined,
      provider: r.provider ?? undefined,
      toolId: r.tool_id ?? undefined,
      granted: r.granted ?? undefined,
      withheld: r.withheld ?? undefined,
      outcome: r.outcome,
      detail: r.detail ?? undefined,
      seq: r.seq == null ? undefined : Number(r.seq),
    });

  const vault: VaultStore = {
    async listConnections(orgId) {
      const res = await pool.query(`SELECT * FROM org_connections WHERE org_id = $1 ORDER BY created_at`, [orgId]);
      return (res.rows as Array<Record<string, unknown>>).map(connectionRow);
    },

    async getConnection(orgId, connectionId) {
      const res = await pool.query(`SELECT * FROM org_connections WHERE org_id = $1 AND connection_id = $2`, [orgId, connectionId]);
      return res.rows[0] === undefined ? undefined : connectionRow(res.rows[0] as Record<string, unknown>);
    },

    async countConnections(orgId) {
      const res = await pool.query(`SELECT count(*)::int AS n FROM org_connections WHERE org_id = $1`, [orgId]);
      return (res.rows[0] as { n: number }).n;
    },

    async createConnection(row) {
      const parsed = OrgConnectionRow.parse(row);
      try {
        await pool.query(
          `INSERT INTO org_connections
             (connection_id, org_id, provider, catalog_id, slug, display_name, granted_scopes, scope_kind, scope_subjects,
              credential_mode, dynamic_config, credential_ref, credential_refs, expires_at, last_probe, region,
              sealed_credential, key_id, created_by, created_at, updated_by, updated_at, base_url_host)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10, $11::jsonb, $12, $13::jsonb, $14, $15::jsonb, $16, $17, $18, $19, $20, $21, $22, $23)`,
          [
            parsed.connectionId,
            parsed.orgId,
            parsed.provider,
            parsed.catalogId ?? null,
            parsed.slug,
            parsed.displayName,
            JSON.stringify(parsed.grantedScopes),
            parsed.scopeKind,
            JSON.stringify(parsed.scopeSubjects),
            parsed.credentialMode ?? "static",
            parsed.dynamicConfig === undefined ? null : JSON.stringify(parsed.dynamicConfig),
            parsed.credentialRef ?? null,
            parsed.credentialRefs === undefined ? null : JSON.stringify(parsed.credentialRefs),
            parsed.expiresAt ?? null,
            parsed.lastProbe === undefined ? null : JSON.stringify(parsed.lastProbe),
            parsed.region ?? null,
            parsed.sealedCredential,
            parsed.keyId,
            parsed.createdBy,
            parsed.createdAt,
            parsed.updatedBy,
            parsed.updatedAt,
            parsed.baseUrlHost ?? null,
          ],
        );
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new VibtraError({
            code: "VALIDATION",
            message: "That handle is already used by another connection",
            detail: `org ${parsed.orgId} already has a ${parsed.provider} connection with handle "${parsed.slug}" — handles decide the environment variable names, so they must be unique per provider`,
          });
        }
        throw e;
      }
    },

    async updateScope({ orgId, connectionId, scopeKind, scopeSubjects, updatedBy, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_connections SET scope_kind = $3, scope_subjects = $4::jsonb, updated_by = $5, updated_at = $6
         WHERE org_id = $1 AND connection_id = $2`,
        [orgId, connectionId, scopeKind, JSON.stringify(scopeSubjects), updatedBy, updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setRegion({ orgId, connectionId, region, updatedBy, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_connections SET region = $3, updated_by = $4, updated_at = $5
          WHERE org_id = $1 AND connection_id = $2`,
        [orgId, connectionId, region, updatedBy, updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setBaseUrlHost({ orgId, connectionId, baseUrlHost }) {
      const res = await pool.query(`UPDATE org_connections SET base_url_host = $3 WHERE org_id = $1 AND connection_id = $2`, [orgId, connectionId, baseUrlHost]);
      return (res.rowCount ?? 0) > 0;
    },

    async setDynamicConfig({ orgId, connectionId, dynamicConfig, updatedBy, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_connections SET dynamic_config = $3::jsonb, updated_by = $4, updated_at = $5
          WHERE org_id = $1 AND connection_id = $2`,
        [orgId, connectionId, JSON.stringify(dynamicConfig), updatedBy, updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async replaceCredential({ orgId, connectionId, sealedCredential, keyId, grantedScopes, expiresAt, updatedBy, updatedAt }) {
      const sets = ["sealed_credential = $3", "key_id = $4", "granted_scopes = $5::jsonb", "updated_by = $6", "updated_at = $7"];
      const values: unknown[] = [orgId, connectionId, sealedCredential, keyId, JSON.stringify(grantedScopes), updatedBy, updatedAt];
      if (expiresAt !== undefined) {
        values.push(expiresAt);
        sets.push(`expires_at = $${values.length}`);
      }
      const res = await pool.query(
        `UPDATE org_connections SET ${sets.join(", ")} WHERE org_id = $1 AND connection_id = $2`,
        values,
      );
      return (res.rowCount ?? 0) > 0;
    },

    async recordProbe({ orgId, connectionId, lastProbe }) {
      const res = await pool.query(
        `UPDATE org_connections SET last_probe = $3::jsonb WHERE org_id = $1 AND connection_id = $2`,
        [orgId, connectionId, JSON.stringify(StoredProbe.parse(lastProbe))],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async removeConnection(orgId, connectionId) {
      const res = await pool.query(`DELETE FROM org_connections WHERE org_id = $1 AND connection_id = $2 RETURNING *`, [
        orgId,
        connectionId,
      ]);
      return res.rows[0] === undefined ? undefined : connectionRow(res.rows[0] as Record<string, unknown>);
    },

    async appendAudit(row) {
      const parsed = VaultAuditRow.parse(row);
      await pool.query(
        `INSERT INTO vault_audit
           (audit_id, org_id, at, event, actor_kind, actor, token_id, token_name, connection_id, provider, tool_id,
            granted, withheld, outcome, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         ON CONFLICT (audit_id) DO NOTHING`,
        [
          parsed.auditId,
          parsed.orgId,
          parsed.at,
          parsed.event,
          parsed.actorKind,
          parsed.actor,
          parsed.tokenId ?? null,
          parsed.tokenName ?? null,
          parsed.connectionId ?? null,
          parsed.provider ?? null,
          parsed.toolId ?? null,
          parsed.granted ?? null,
          parsed.withheld ?? null,
          parsed.outcome,
          parsed.detail ?? null,
        ],
      );
    },

    async listAudit(orgId, limit) {
      const res = await pool.query(`SELECT * FROM vault_audit WHERE org_id = $1 ORDER BY seq DESC LIMIT $2`, [orgId, limit]);
      return (res.rows as Array<Record<string, unknown>>).map(auditRow);
    },

    async listAuditPage(orgId, args) {
      const before = args.before === undefined ? null : args.before;
      const res = await pool.query(
        `SELECT * FROM vault_audit
          WHERE org_id = $1 AND ($2::bigint IS NULL OR seq < $2::bigint)
          ORDER BY seq DESC
          LIMIT $3`,
        [orgId, before, args.limit],
      );
      const rows = (res.rows as Array<Record<string, unknown>>).map(auditRow);
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
      if (options?.dryRun === true) {
        const res = await pool.query(`SELECT sealed_credential FROM org_connections`);
        for (const r of res.rows as Array<{ sealed_credential: string }>) {
          await tallySealedRow(counts, sealer, r.sealed_credential);
        }
        return counts;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const res = await client.query(
          `SELECT org_id, connection_id, sealed_credential FROM org_connections ORDER BY created_at FOR UPDATE`,
        );
        for (const r of res.rows as Array<{ org_id: string; connection_id: string; sealed_credential: string }>) {
          if (!(await tallySealedRow(counts, sealer, r.sealed_credential))) continue;
          const resealed = await sealer.reseal(r.sealed_credential, { orgId: r.org_id, connectionId: r.connection_id });
          await client.query(
            `UPDATE org_connections SET sealed_credential = $3, key_id = $4 WHERE org_id = $1 AND connection_id = $2`,
            [r.org_id, r.connection_id, resealed, sealer.keyId],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
      return counts;
    },
  };

  const toolRow = (r: Record<string, unknown>): OrgToolRow =>
    OrgToolRow.parse({
      orgId: r.org_id,
      toolId: r.tool_id,
      name: r.name,
      ownerEmail: r.owner_email,
      audienceKind: r.audience_kind,
      audienceSubjects: r.audience_subjects,
      oauthClientId: r.oauth_client_id,
      oauthClientSecretSealed: r.oauth_client_secret_sealed,
      oauthKeyId: r.oauth_key_id,
      oauthRedirectUris: r.oauth_redirect_uris,
      databaseLeases: r.database_leases ?? undefined,
      vendorDeployment: r.vendor_deployment ?? undefined,
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });

  const tools: ToolStore = {
    async getTool(orgId, toolId) {
      const res = await pool.query(`SELECT * FROM org_tools WHERE org_id = $1 AND tool_id = $2`, [orgId, toolId]);
      return res.rows[0] === undefined ? undefined : toolRow(res.rows[0] as Record<string, unknown>);
    },

    async findByClientId(oauthClientId) {
      const res = await pool.query(`SELECT * FROM org_tools WHERE oauth_client_id = $1`, [oauthClientId]);
      return res.rows[0] === undefined ? undefined : toolRow(res.rows[0] as Record<string, unknown>);
    },

    async upsertTool(row) {
      const parsed = OrgToolRow.parse(row);
      try {
        const res = await pool.query(
          `INSERT INTO org_tools
             (org_id, tool_id, name, owner_email, audience_kind, audience_subjects,
              oauth_client_id, oauth_client_secret_sealed, oauth_key_id, oauth_redirect_uris,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10::jsonb, $11, $12)
           ON CONFLICT (org_id, tool_id) DO UPDATE
             SET name = EXCLUDED.name,
                 audience_kind = EXCLUDED.audience_kind,
                 audience_subjects = EXCLUDED.audience_subjects,
                 updated_at = EXCLUDED.updated_at
           RETURNING *, (xmax = 0) AS inserted`,
          [
            parsed.orgId,
            parsed.toolId,
            parsed.name,
            parsed.ownerEmail,
            parsed.audienceKind,
            JSON.stringify(parsed.audienceSubjects),
            parsed.oauthClientId,
            parsed.oauthClientSecretSealed,
            parsed.oauthKeyId,
            JSON.stringify(parsed.oauthRedirectUris),
            parsed.createdAt,
            parsed.updatedAt,
          ],
        );
        const raw = res.rows[0] as Record<string, unknown>;
        return { row: toolRow(raw), created: raw.inserted === true };
      } catch (e) {
        if (isUniqueViolation(e)) {
          throw new VibtraError({
            code: "INTERNAL",
            message: "That OAuth client id is already taken",
            detail: `client id ${parsed.oauthClientId} is registered to another tool — mint a fresh one`,
          });
        }
        throw e;
      }
    },

    async setAudience({ orgId, toolId, audience, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_tools SET audience_kind = $3, audience_subjects = $4::jsonb, updated_at = $5
         WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, audience.kind, JSON.stringify(audience.subjects), updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setOwner({ orgId, toolId, ownerEmail, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_tools SET owner_email = $3, updated_at = $4
         WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, ownerEmail, updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setRedirectUris({ orgId, toolId, redirectUris, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_tools SET oauth_redirect_uris = $3::jsonb, updated_at = $4
         WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, JSON.stringify([...new Set(redirectUris)]), updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async rotateClientSecret({ orgId, toolId, sealedSecret, keyId, updatedAt }) {
      const res = await pool.query(
        `UPDATE org_tools SET oauth_client_secret_sealed = $3, oauth_key_id = $4, updated_at = $5
         WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, sealedSecret, keyId, updatedAt],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setDatabaseLeases({ orgId, toolId, leases }) {
      const res = await pool.query(
        `UPDATE org_tools SET database_leases = $3::jsonb WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, JSON.stringify(leases)],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async setVendorDeployment({ orgId, toolId, vendorDeployment }) {
      const res = await pool.query(
        `UPDATE org_tools SET vendor_deployment = $3::jsonb WHERE org_id = $1 AND tool_id = $2`,
        [orgId, toolId, JSON.stringify(ToolVendorDeployment.parse(vendorDeployment))],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listToolsWithDatabaseLeases() {
      const res = await pool.query(
        `SELECT * FROM org_tools
          WHERE database_leases IS NOT NULL AND jsonb_array_length(database_leases) > 0
          ORDER BY org_id, tool_id`,
      );
      return (res.rows as Array<Record<string, unknown>>).map(toolRow);
    },

    async listTools(orgId) {
      const res = await pool.query(`SELECT * FROM org_tools WHERE org_id = $1 ORDER BY created_at`, [orgId]);
      return (res.rows as Array<Record<string, unknown>>).map(toolRow);
    },

    async resealAll(sealer, options) {
      const counts = emptyResealCounts();
      if (options?.dryRun === true) {
        const res = await pool.query(`SELECT oauth_client_secret_sealed FROM org_tools`);
        for (const r of res.rows as Array<{ oauth_client_secret_sealed: string }>) {
          await tallySealedRow(counts, sealer, r.oauth_client_secret_sealed);
        }
        return counts;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const res = await client.query(
          `SELECT org_id, tool_id, oauth_client_secret_sealed FROM org_tools ORDER BY created_at FOR UPDATE`,
        );
        for (const r of res.rows as Array<{ org_id: string; tool_id: string; oauth_client_secret_sealed: string }>) {
          if (!(await tallySealedRow(counts, sealer, r.oauth_client_secret_sealed))) continue;
          const resealed = await resealToolSecret(sealer, r.org_id, r.tool_id, r.oauth_client_secret_sealed);
          await client.query(
            `UPDATE org_tools SET oauth_client_secret_sealed = $3, oauth_key_id = $4 WHERE org_id = $1 AND tool_id = $2`,
            [r.org_id, r.tool_id, resealed, sealer.keyId],
          );
        }
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
      return counts;
    },
  };

  const allowlistRow = (r: Record<string, unknown>): AllowlistRow =>
    AllowlistRow.parse({
      id: r.id,
      subject: r.subject,
      kind: r.kind,
      ...(r.note === null || r.note === undefined ? {} : { note: r.note }),
      addedBy: r.added_by,
      addedAt: iso(r.added_at),
    });

  const registrationAllowlist: RegistrationAllowlistStore = {
    async list() {
      const res = await pool.query(`SELECT * FROM registration_allowlist ORDER BY added_at DESC`);
      return (res.rows as Array<Record<string, unknown>>).map(allowlistRow);
    },

    async add({ subject, kind, note, addedBy }) {
      try {
        const res = await pool.query(
          `INSERT INTO registration_allowlist (id, subject, kind, note, added_by, added_at)
           VALUES ($1, $2, $3, $4, $5, now())
           RETURNING *`,
          [mintAllowlistId(), subject, kind, note ?? null, addedBy],
        );
        return allowlistRow(res.rows[0] as Record<string, unknown>);
      } catch (e) {
        if (isUniqueViolation(e)) return undefined;
        throw e;
      }
    },

    async remove(id) {
      const res = await pool.query(`DELETE FROM registration_allowlist WHERE id = $1`, [id]);
      return (res.rowCount ?? 0) > 0;
    },

    async isAllowed(email) {
      const wanted = allowlistSubjectsFor(email);
      if (wanted.length === 0) return false;
      const [address, host] = wanted as [string, string];
      const res = await pool.query(
        `SELECT 1 FROM registration_allowlist
          WHERE (kind = 'email' AND subject = $1) OR (kind = 'domain' AND subject = $2)
          LIMIT 1`,
        [address, host],
      );
      return res.rows.length > 0;
    },
  };

  const usageRow = (r: Record<string, unknown>): UsageSnapshotRow =>
    UsageSnapshotRow.parse({
      orgId: r.org_id,
      day: r.day instanceof Date ? isoDay(r.day) : String(r.day).slice(0, 10),
      seats: r.seats,
      connections: r.connections,
      liveTools: r.live_tools,
      deploys: r.deploys,
    });

  const usage: UsageStore = {
    async putSnapshot(row) {
      const parsed = UsageSnapshotRow.parse(row);
      const res = await pool.query(
        `INSERT INTO usage_snapshots (org_id, day, seats, connections, live_tools, deploys)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, day) DO NOTHING`,
        [parsed.orgId, parsed.day, parsed.seats, parsed.connections, parsed.liveTools, parsed.deploys],
      );
      return (res.rowCount ?? 0) > 0;
    },

    async listSnapshots(orgId, limit) {
      const res = await pool.query(
        `SELECT * FROM usage_snapshots WHERE org_id = $1 ORDER BY day DESC LIMIT $2`,
        [orgId, Math.max(0, limit)],
      );
      return (res.rows as Array<Record<string, unknown>>).map(usageRow);
    },
  };

  const planRequestRow = (r: Record<string, unknown>): PlanChangeRequestRow =>
    PlanChangeRequestRow.parse({
      requestId: r.request_id,
      orgId: r.org_id,
      requesterEmail: r.requester_email,
      currentPlan: r.current_plan,
      wantedPlan: r.wanted_plan,
      status: r.status,
      ...(r.note === null || r.note === undefined ? {} : { note: r.note }),
      ...(r.decided_by === null || r.decided_by === undefined ? {} : { decidedBy: r.decided_by }),
      ...(r.decision_note === null || r.decision_note === undefined ? {} : { decisionNote: r.decision_note }),
      ...(r.decided_at === null || r.decided_at === undefined ? {} : { decidedAt: iso(r.decided_at) }),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
    });

  const planRequests: PlanRequestStore = {
    async latestForOrg(orgId) {
      const res = await pool.query(
        `SELECT * FROM plan_change_requests WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [orgId],
      );
      return res.rows[0] === undefined ? undefined : planRequestRow(res.rows[0] as Record<string, unknown>);
    },

    async createRequest(row) {
      const parsed = PlanChangeRequestRow.parse(row);
      try {
        const res = await pool.query(
          `INSERT INTO plan_change_requests
             (request_id, org_id, requester_email, current_plan, wanted_plan, note, status, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING *`,
          [
            parsed.requestId,
            parsed.orgId,
            parsed.requesterEmail,
            parsed.currentPlan,
            parsed.wantedPlan,
            parsed.note ?? null,
            parsed.status,
            parsed.createdAt,
            parsed.updatedAt,
          ],
        );
        return planRequestRow(res.rows[0] as Record<string, unknown>);
      } catch (e) {
        if (isUniqueViolation(e)) return undefined;
        throw e;
      }
    },

    async listOpen() {
      const res = await pool.query(
        `SELECT * FROM plan_change_requests WHERE status = 'pending' ORDER BY created_at`,
      );
      return (res.rows as Array<Record<string, unknown>>).map(planRequestRow);
    },

    async getRequest(requestId) {
      const res = await pool.query(`SELECT * FROM plan_change_requests WHERE request_id = $1`, [requestId]);
      return res.rows[0] === undefined ? undefined : planRequestRow(res.rows[0] as Record<string, unknown>);
    },

    async decideRequest({ requestId, status, decidedBy, decisionNote, decidedAt }) {
      const res = await pool.query(
        `UPDATE plan_change_requests
            SET status = $2, decided_by = $3, decision_note = $4, decided_at = $5, updated_at = $5
          WHERE request_id = $1 AND status = 'pending'
          RETURNING *`,
        [requestId, status, decidedBy, decisionNote ?? null, decidedAt],
      );
      return res.rows[0] === undefined ? undefined : planRequestRow(res.rows[0] as Record<string, unknown>);
    },
  };

  const migrate = async (): Promise<void> => {
    const client = await pool.connect();
    try {
      await client.query(`SELECT pg_advisory_lock(727274301)`);

      await client.query(
        `CREATE TABLE IF NOT EXISTS registry_migrations (
           name TEXT PRIMARY KEY,
           applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
         )`,
      );

      const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
      const appliedNames = ((await client.query(`SELECT name FROM registry_migrations`)).rows as Array<{
        name: string;
      }>).map((r) => r.name);
      const refusal = orphanMigrationRefusal(appliedNames, files);
      if (refusal !== undefined) throw refusal;

      await ensureCoordinationSchema(client);
      const applied = new Set(appliedNames);
      for (const file of files) {
        if (applied.has(file)) continue;
        const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
        await client.query("BEGIN");
        try {
          await client.query(sql);
          await client.query(`INSERT INTO registry_migrations (name) VALUES ($1)`, [file]);
          await client.query("COMMIT");
        } catch (e) {
          await client.query("ROLLBACK");
          throw new VibtraError({
            code: "INTERNAL",
            message: `Migration ${file} failed — the registry will not start half-migrated`,
            detail: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(727274301)`).catch(() => undefined);
      client.release();
    }
  };

  return {
    records,
    orgs,
    vault,
    tools,
    registrationAllowlist,
    usage,
    planRequests,
    pool,
    coordinator,
    migrate,
    close: async () => {
      await pool.end();
    },
  };
};
