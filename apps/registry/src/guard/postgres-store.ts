import type pg from "pg";
import {
  type GuardDevicePatch,
  GuardDeviceRecord,
  GuardEnrolLinkRecord,
  GuardEventRecord,
  type GuardEventQuery,
  GuardOverridesRecord,
  GuardRulesRecord,
  GuardSettingsRecord,
  GuardSigningKeyRow,
  type GuardStore,
} from "./store.js";

export const SIGNING_KEY_COLUMNS = ["slot", "key_id", "public_key_pem", "sealed_private_key", "created_at"] as const;
export const ENROL_LINK_COLUMNS = ["token_sha256", "token_prefix", "org_id", "person_user_id", "person_email", "note", "created_by", "created_at", "expires_at", "used_at", "used_by_device"] as const;
export const DEVICE_COLUMNS = [
  "device_id",
  "org_id",
  "person_user_id",
  "person_email",
  "token_sha256",
  "facts",
  "ca",
  "health",
  "status",
  "client_mode",
  "enrolled_at",
  "last_seen_at",
  "last_postflight_at",
  "bundle_version",
  "bundle_digest",
  "catalogue_version",
  "revoked_at",
  "revoked_by",
] as const;
export const RULES_COLUMNS = ["org_id", "version", "document", "updated_at", "updated_by"] as const;
export const SETTINGS_COLUMNS = ["org_id", "settings", "updated_at", "updated_by"] as const;
export const OVERRIDES_COLUMNS = ["org_id", "overrides", "version", "updated_at", "updated_by"] as const;
export const EVENT_COLUMNS = [
  "org_id",
  "event_id",
  "device_id",
  "person_user_id",
  "person_email",
  "person_name",
  "hostname",
  "occurred_at",
  "received_at",
  "kind",
  "action",
  "service_id",
  "service_name",
  "host",
  "port",
  "method",
  "path_hint",
  "app",
  "rule_id",
  "rule_name",
  "rule_kind",
  "match_type",
  "match_count",
  "snippet",
  "bytes",
  "request_id",
  "bundle_version",
  "reason",
  "would_action",
] as const;

type Row = Record<string, unknown>;
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const opt = <K extends string>(key: K, v: unknown, map: (x: unknown) => unknown = (x) => x): Partial<Record<K, unknown>> =>
  v === null || v === undefined ? {} : ({ [key]: map(v) } as Record<K, unknown>);
const num = (v: unknown): number => Number(v);

const keyFromDb = (r: Row): GuardSigningKeyRow =>
  GuardSigningKeyRow.parse({ keyId: r.key_id, publicKeyPem: r.public_key_pem, sealedPrivateKey: r.sealed_private_key, createdAt: iso(r.created_at) });

const linkFromDb = (r: Row): GuardEnrolLinkRecord =>
  GuardEnrolLinkRecord.parse({
    tokenSha256: r.token_sha256,
    tokenPrefix: r.token_prefix,
    orgId: r.org_id,
    personUserId: r.person_user_id,
    personEmail: r.person_email,
    ...opt("note", r.note),
    createdBy: r.created_by,
    createdAt: iso(r.created_at),
    expiresAt: iso(r.expires_at),
    ...opt("usedAt", r.used_at, iso),
    ...opt("usedByDevice", r.used_by_device),
  });

const deviceFromDb = (r: Row): GuardDeviceRecord =>
  GuardDeviceRecord.parse({
    deviceId: r.device_id,
    orgId: r.org_id,
    personUserId: r.person_user_id,
    personEmail: r.person_email,
    tokenSha256: r.token_sha256,
    facts: r.facts,
    ...opt("ca", r.ca),
    ...opt("health", r.health),
    status: r.status,
    clientMode: r.client_mode,
    enrolledAt: iso(r.enrolled_at),
    ...opt("lastSeenAt", r.last_seen_at, iso),
    ...opt("lastPostflightAt", r.last_postflight_at, iso),
    ...opt("bundleVersion", r.bundle_version, num),
    ...opt("bundleDigest", r.bundle_digest),
    ...opt("catalogueVersion", r.catalogue_version),
    ...opt("revokedAt", r.revoked_at, iso),
    ...opt("revokedBy", r.revoked_by),
  });

const eventFromDb = (r: Row): GuardEventRecord =>
  GuardEventRecord.parse({
    orgId: r.org_id,
    eventId: r.event_id,
    deviceId: r.device_id,
    personUserId: r.person_user_id,
    personEmail: r.person_email,
    ...opt("personName", r.person_name),
    ...opt("hostname", r.hostname),
    occurredAt: iso(r.occurred_at),
    receivedAt: iso(r.received_at),
    kind: r.kind,
    action: r.action,
    ...opt("serviceId", r.service_id),
    ...opt("serviceName", r.service_name),
    ...opt("host", r.host),
    ...opt("port", r.port, num),
    ...opt("method", r.method),
    ...opt("pathHint", r.path_hint),
    ...opt("app", r.app),
    ...opt("ruleId", r.rule_id),
    ...opt("ruleName", r.rule_name),
    ...opt("ruleKind", r.rule_kind),
    ...opt("matchType", r.match_type),
    ...opt("matchCount", r.match_count, num),
    ...opt("snippet", r.snippet),
    ...opt("bytes", r.bytes, num),
    ...opt("requestId", r.request_id),
    ...opt("bundleVersion", r.bundle_version, num),
    ...opt("reason", r.reason),
    ...opt("wouldAction", r.would_action),
  });

const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));
const nul = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export const createGuardPostgresStore = (pool: pg.Pool): GuardStore => ({
  async getSigningKey() {
    const res = await pool.query(`SELECT * FROM guard_signing_keys WHERE slot = 'current'`);
    const r = res.rows[0] as Row | undefined;
    return r ? keyFromDb(r) : undefined;
  },
  async putSigningKeyIfAbsent(row) {
    const parsed = GuardSigningKeyRow.parse(row);
    await pool.query(
      `INSERT INTO guard_signing_keys (slot, key_id, public_key_pem, sealed_private_key, created_at) VALUES ('current', $1, $2, $3, $4) ON CONFLICT (slot) DO NOTHING`,
      [parsed.keyId, parsed.publicKeyPem, parsed.sealedPrivateKey, parsed.createdAt],
    );
    const res = await pool.query(`SELECT * FROM guard_signing_keys WHERE slot = 'current'`);
    return keyFromDb(res.rows[0] as Row);
  },
  async insertEnrolLink(row) {
    const p = GuardEnrolLinkRecord.parse(row);
    await pool.query(
      `INSERT INTO guard_enrol_links (token_sha256, token_prefix, org_id, person_user_id, person_email, note, created_by, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [p.tokenSha256, p.tokenPrefix, p.orgId, p.personUserId, p.personEmail, nul(p.note), p.createdBy, p.createdAt, p.expiresAt],
    );
  },
  async consumeEnrolLink(tokenSha256, now, deviceId) {
    const res = await pool.query(
      `UPDATE guard_enrol_links SET used_at = $2, used_by_device = $3 WHERE token_sha256 = $1 AND used_at IS NULL AND expires_at > $2 RETURNING *`,
      [tokenSha256, now, deviceId],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? linkFromDb(r) : undefined;
  },
  async listEnrolLinks(orgId) {
    const res = await pool.query(`SELECT * FROM guard_enrol_links WHERE org_id = $1 ORDER BY created_at DESC`, [orgId]);
    return (res.rows as Row[]).map(linkFromDb);
  },
  async insertDevice(row) {
    const p = GuardDeviceRecord.parse(row);
    await pool.query(
      `INSERT INTO guard_devices (device_id, org_id, person_user_id, person_email, token_sha256, facts, ca, health, status, client_mode, enrolled_at, last_seen_at,
         last_postflight_at, bundle_version, bundle_digest, catalogue_version, revoked_at, revoked_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        p.deviceId,
        p.orgId,
        p.personUserId,
        p.personEmail,
        p.tokenSha256,
        JSON.stringify(p.facts),
        json(p.ca),
        json(p.health),
        p.status,
        p.clientMode,
        p.enrolledAt,
        nul(p.lastSeenAt),
        nul(p.lastPostflightAt),
        nul(p.bundleVersion),
        nul(p.bundleDigest),
        nul(p.catalogueVersion),
        nul(p.revokedAt),
        nul(p.revokedBy),
      ],
    );
  },
  async getDeviceForSync(deviceId) {
    const res = await pool.query(`SELECT * FROM guard_devices WHERE device_id = $1`, [deviceId]);
    const r = res.rows[0] as Row | undefined;
    return r ? deviceFromDb(r) : undefined;
  },
  async getDevice(orgId, deviceId) {
    const res = await pool.query(`SELECT * FROM guard_devices WHERE org_id = $1 AND device_id = $2`, [orgId, deviceId]);
    const r = res.rows[0] as Row | undefined;
    return r ? deviceFromDb(r) : undefined;
  },
  async listDevices(orgId) {
    const res = await pool.query(`SELECT * FROM guard_devices WHERE org_id = $1 ORDER BY enrolled_at, device_id`, [orgId]);
    return (res.rows as Row[]).map(deviceFromDb);
  },
  async updateDevice(orgId, deviceId, patch: GuardDevicePatch) {
    const sets: string[] = [];
    const values: unknown[] = [orgId, deviceId];
    const put = (column: string, value: unknown, cast = "") => {
      values.push(value);
      sets.push(`${column} = $${values.length}${cast}`);
    };
    if (patch.facts !== undefined) put("facts", JSON.stringify(patch.facts), "::jsonb");
    if (patch.ca !== undefined) put("ca", JSON.stringify(patch.ca), "::jsonb");
    if (patch.health !== undefined) put("health", JSON.stringify(patch.health), "::jsonb");
    if (patch.clientMode !== undefined) put("client_mode", patch.clientMode);
    if (patch.lastSeenAt !== undefined) put("last_seen_at", patch.lastSeenAt);
    if (patch.lastPostflightAt !== undefined) put("last_postflight_at", patch.lastPostflightAt);
    if (patch.bundleVersion !== undefined) put("bundle_version", patch.bundleVersion);
    if (patch.bundleDigest !== undefined) put("bundle_digest", patch.bundleDigest);
    if (patch.catalogueVersion !== undefined) put("catalogue_version", patch.catalogueVersion);
    if (sets.length === 0) {
      const found = await pool.query(`SELECT * FROM guard_devices WHERE org_id = $1 AND device_id = $2`, [orgId, deviceId]);
      const f = found.rows[0] as Row | undefined;
      return f ? deviceFromDb(f) : undefined;
    }
    const res = await pool.query(`UPDATE guard_devices SET ${sets.join(", ")} WHERE org_id = $1 AND device_id = $2 RETURNING *`, values);
    const r = res.rows[0] as Row | undefined;
    return r ? deviceFromDb(r) : undefined;
  },
  async revokeDevice(orgId, deviceId, by, at) {
    const res = await pool.query(
      `UPDATE guard_devices SET status = 'revoked', revoked_at = $3, revoked_by = $4 WHERE org_id = $1 AND device_id = $2 AND status = 'active' RETURNING *`,
      [orgId, deviceId, at, by],
    );
    const r = res.rows[0] as Row | undefined;
    return r ? deviceFromDb(r) : undefined;
  },
  async getRules(orgId) {
    const res = await pool.query(`SELECT * FROM guard_rules WHERE org_id = $1`, [orgId]);
    const r = res.rows[0] as Row | undefined;
    return r ? GuardRulesRecord.parse({ orgId: r.org_id, version: Number(r.version), document: r.document, updatedAt: iso(r.updated_at), updatedBy: r.updated_by }) : undefined;
  },
  async casRules(row, baseVersion) {
    const p = GuardRulesRecord.parse(row);
    const res =
      baseVersion === undefined
        ? await pool.query(`INSERT INTO guard_rules (org_id, version, document, updated_at, updated_by) VALUES ($1, $2, $3::jsonb, $4, $5) ON CONFLICT (org_id) DO NOTHING`, [
            p.orgId,
            p.version,
            JSON.stringify(p.document),
            p.updatedAt,
            p.updatedBy,
          ])
        : await pool.query(`UPDATE guard_rules SET version = $2, document = $3::jsonb, updated_at = $4, updated_by = $5 WHERE org_id = $1 AND version = $6`, [
            p.orgId,
            p.version,
            JSON.stringify(p.document),
            p.updatedAt,
            p.updatedBy,
            baseVersion,
          ]);
    return (res.rowCount ?? 0) === 1;
  },
  async getSettings(orgId) {
    const res = await pool.query(`SELECT * FROM guard_settings WHERE org_id = $1`, [orgId]);
    const r = res.rows[0] as Row | undefined;
    return r ? GuardSettingsRecord.parse({ orgId: r.org_id, settings: r.settings, updatedAt: iso(r.updated_at), updatedBy: r.updated_by }) : undefined;
  },
  async putSettings(row) {
    const p = GuardSettingsRecord.parse(row);
    await pool.query(
      `INSERT INTO guard_settings (org_id, settings, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (org_id) DO UPDATE SET settings = EXCLUDED.settings, updated_at = EXCLUDED.updated_at, updated_by = EXCLUDED.updated_by`,
      [p.orgId, JSON.stringify(p.settings), p.updatedAt, p.updatedBy],
    );
  },
  async getOverrides(orgId) {
    const res = await pool.query(`SELECT * FROM guard_catalogue_overrides WHERE org_id = $1`, [orgId]);
    const r = res.rows[0] as Row | undefined;
    return r ? GuardOverridesRecord.parse({ orgId: r.org_id, overrides: r.overrides, version: Number(r.version), updatedAt: iso(r.updated_at), updatedBy: r.updated_by }) : undefined;
  },
  async casOverrides(row, baseVersion) {
    const p = GuardOverridesRecord.parse(row);
    const res =
      baseVersion === undefined
        ? await pool.query(
            `INSERT INTO guard_catalogue_overrides (org_id, overrides, version, updated_at, updated_by) VALUES ($1, $2::jsonb, $3, $4, $5) ON CONFLICT (org_id) DO NOTHING`,
            [p.orgId, JSON.stringify(p.overrides), p.version, p.updatedAt, p.updatedBy],
          )
        : await pool.query(`UPDATE guard_catalogue_overrides SET overrides = $2::jsonb, version = $3, updated_at = $4, updated_by = $5 WHERE org_id = $1 AND version = $6`, [
            p.orgId,
            JSON.stringify(p.overrides),
            p.version,
            p.updatedAt,
            p.updatedBy,
            baseVersion,
          ]);
    return (res.rowCount ?? 0) === 1;
  },
  async insertEvents(rows) {
    let added = 0;
    const parsed = rows.map((raw) => GuardEventRecord.parse(raw));
    for (let i = 0; i < parsed.length; i += 100) {
      const chunk = parsed.slice(i, i + 100);
      const values: unknown[] = [];
      const tuples = chunk.map((p) => {
        const row = [
          p.orgId,
          p.eventId,
          p.deviceId,
          p.personUserId,
          p.personEmail,
          nul(p.personName),
          nul(p.hostname),
          p.occurredAt,
          p.receivedAt,
          p.kind,
          p.action,
          nul(p.serviceId),
          nul(p.serviceName),
          nul(p.host),
          nul(p.port),
          nul(p.method),
          nul(p.pathHint),
          json(p.app),
          nul(p.ruleId),
          nul(p.ruleName),
          nul(p.ruleKind),
          nul(p.matchType),
          nul(p.matchCount),
          nul(p.snippet),
          nul(p.bytes),
          nul(p.requestId),
          nul(p.bundleVersion),
          nul(p.reason),
          nul(p.wouldAction),
        ];
        const at = values.length;
        values.push(...row);
        return `(${EVENT_COLUMNS.map((c, j) => `$${at + j + 1}${c === "app" ? "::jsonb" : ""}`).join(", ")})`;
      });
      const res = await pool.query(`INSERT INTO guard_events (${EVENT_COLUMNS.join(", ")}) VALUES ${tuples.join(", ")} ON CONFLICT (org_id, event_id) DO NOTHING`, values);
      added += res.rowCount ?? 0;
    }
    return added;
  },
  async listEvents(orgId, q: GuardEventQuery) {
    const where: string[] = ["org_id = $1"];
    const values: unknown[] = [orgId];
    const add = (sql: (n: number) => string, value: unknown) => {
      values.push(value);
      where.push(sql(values.length));
    };
    if (q.since !== undefined) add((n) => `occurred_at >= $${n}`, q.since);
    if (q.before !== undefined) {
      values.push(q.before.occurredAt, q.before.eventId);
      where.push(`(occurred_at, event_id) < ($${values.length - 1}::timestamptz, $${values.length})`);
    }
    if (q.serviceId !== undefined) add((n) => `service_id = $${n}`, q.serviceId);
    if (q.action !== undefined) add((n) => `action = $${n}`, q.action);
    if (q.deviceId !== undefined) add((n) => `device_id = $${n}`, q.deviceId);
    if (q.personUserId !== undefined) add((n) => `person_user_id = $${n}`, q.personUserId);
    if (q.q !== undefined && q.q !== "") {
      add(
        (n) =>
          `(strpos(lower(coalesce(host, '')), $${n}) > 0 OR strpos(lower(coalesce(app->>'name', '')), $${n}) > 0 OR strpos(lower(coalesce(service_name, '')), $${n}) > 0 OR strpos(lower(coalesce(rule_name, '')), $${n}) > 0 OR strpos(lower(person_email), $${n}) > 0)`,
        q.q.toLowerCase(),
      );
    }
    values.push(q.limit);
    const res = await pool.query(`SELECT * FROM guard_events WHERE ${where.join(" AND ")} ORDER BY occurred_at DESC, event_id DESC LIMIT $${values.length}`, values);
    return (res.rows as Row[]).map(eventFromDb);
  },
});
