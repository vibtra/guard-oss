import type pg from "pg";
import { type GuardRequestStore, PolicyGrantRow, type PolicyRequestPatch, PolicyRequestRow } from "./store.js";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const opt = <T>(key: string, v: unknown, map: (x: unknown) => T = (x) => x as T): Record<string, T> => (v === null || v === undefined ? {} : { [key]: map(v) });

const requestFromDb = (r: Record<string, unknown>): PolicyRequestRow =>
  PolicyRequestRow.parse({
    id: r.id,
    orgId: r.org_id,
    ...opt("workspaceId", r.workspace_id),
    ...opt("sessionId", r.session_id),
    requesterUserId: r.requester_user_id,
    kind: r.kind,
    subject: r.subject,
    subjectKey: r.subject_key,
    ...opt("why", r.why),
    ...opt("proposedRevision", r.proposed_revision),
    ...opt("baseRevision", r.base_revision),
    status: r.status,
    ...opt("decidedBy", r.decided_by),
    ...opt("decidedAt", r.decided_at, iso),
    ...opt("decisionNote", r.decision_note),
    ...opt("grantId", r.grant_id),
    reminderAt: iso(r.reminder_at),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
  });

const grantFromDb = (r: Record<string, unknown>): PolicyGrantRow =>
  PolicyGrantRow.parse({
    id: r.id,
    orgId: r.org_id,
    scope: r.scope,
    ...opt("userId", r.user_id),
    kind: r.kind,
    subject: r.subject,
    subjectKey: r.subject_key,
    ...opt("expiresAt", r.expires_at, iso),
    requestId: r.request_id,
    approvedBy: r.approved_by,
    createdAt: iso(r.created_at),
    ...opt("revokedAt", r.revoked_at, iso),
    ...opt("revokedBy", r.revoked_by),
  });

const PATCH: Record<keyof PolicyRequestPatch, string> = { status: "status", decidedBy: "decided_by", decidedAt: "decided_at", decisionNote: "decision_note", grantId: "grant_id" };

export const createGuardRequestPostgresStore = (pool: pg.Pool): GuardRequestStore => ({
  async insertRequest(row) {
    const r = PolicyRequestRow.parse(row);
    const res = await pool.query(
      `INSERT INTO policy_requests (id, org_id, workspace_id, session_id, requester_user_id, kind, subject, subject_key, why, proposed_revision, base_revision, status, decided_by, decided_at, decision_note, grant_id, reminder_at, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19) ON CONFLICT DO NOTHING RETURNING *`,
      [
        r.id,
        r.orgId,
        r.workspaceId ?? null,
        r.sessionId ?? null,
        r.requesterUserId,
        r.kind,
        JSON.stringify(r.subject),
        r.subjectKey,
        r.why ?? null,
        r.proposedRevision ?? null,
        r.baseRevision ?? null,
        r.status,
        r.decidedBy ?? null,
        r.decidedAt ?? null,
        r.decisionNote ?? null,
        r.grantId ?? null,
        r.reminderAt,
        r.expiresAt,
        r.createdAt,
      ],
    );
    if (res.rows[0]) return { row: requestFromDb(res.rows[0] as Record<string, unknown>), created: true };
    const open = await pool.query(
      `SELECT * FROM policy_requests WHERE org_id = $1 AND coalesce(workspace_id, '') = $2 AND kind = $3 AND subject_key = $4 AND status = 'pending' LIMIT 1`,
      [r.orgId, r.workspaceId ?? "", r.kind, r.subjectKey],
    );
    return { row: requestFromDb(open.rows[0] as Record<string, unknown>), created: false };
  },
  async getRequest(id) {
    const res = await pool.query(`SELECT * FROM policy_requests WHERE id = $1`, [id]);
    return res.rows[0] ? requestFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async listRequests(orgId, filter) {
    const where = ["org_id = $1"];
    const values: unknown[] = [orgId];
    for (const [key, column] of [
      ["status", "status"],
      ["kind", "kind"],
      ["requesterUserId", "requester_user_id"],
    ] as const) {
      const v = filter[key];
      if (v === undefined) continue;
      values.push(v);
      where.push(`${column} = $${values.length}`);
    }
    const res = await pool.query(`SELECT * FROM policy_requests WHERE ${where.join(" AND ")} ORDER BY created_at DESC`, values);
    return (res.rows as Record<string, unknown>[]).map(requestFromDb);
  },
  async updateRequest(id, expectStatus, patch) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH) as Array<[keyof PolicyRequestPatch, string]>) {
      if (!(key in patch)) continue;
      values.push(patch[key] ?? null);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return this.getRequest(id);
    values.push(id, expectStatus);
    const res = await pool.query(`UPDATE policy_requests SET ${sets.join(", ")} WHERE id = $${values.length - 1} AND status = $${values.length} RETURNING *`, values);
    return res.rows[0] ? requestFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async insertGrant(row) {
    const g = PolicyGrantRow.parse(row);
    await pool.query(
      `INSERT INTO policy_grants (id, org_id, scope, user_id, kind, subject, subject_key, expires_at, request_id, approved_by, created_at, revoked_at, revoked_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [g.id, g.orgId, g.scope, g.userId ?? null, g.kind, JSON.stringify(g.subject), g.subjectKey, g.expiresAt ?? null, g.requestId, g.approvedBy, g.createdAt, g.revokedAt ?? null, g.revokedBy ?? null],
    );
  },
  async getGrant(id) {
    const res = await pool.query(`SELECT * FROM policy_grants WHERE id = $1`, [id]);
    return res.rows[0] ? grantFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async listGrants(orgId, filter) {
    const res = await pool.query(
      `SELECT * FROM policy_grants WHERE org_id = $1 AND ($2::boolean OR revoked_at IS NULL) AND ($3::text IS NULL OR scope = 'org' OR user_id = $3) ORDER BY id`,
      [orgId, filter.includeRevoked === true, filter.userId ?? null],
    );
    return (res.rows as Record<string, unknown>[]).map(grantFromDb);
  },
  async revokeGrant(id, by, at) {
    const res = await pool.query(`UPDATE policy_grants SET revoked_at = $2, revoked_by = $3 WHERE id = $1 AND revoked_at IS NULL RETURNING *`, [id, at, by]);
    return res.rows[0] ? grantFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
});
