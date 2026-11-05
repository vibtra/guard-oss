import type pg from "pg";
import {
  AppBoxIntervalRow,
  AppBoxRow,
  type MeteringStore,
  SpendingCapRow,
  UsageNoticeRow,
  UsagePeriodRow,
  UsageReportRow,
} from "./store.js";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const optIso = (key: string, v: unknown): Record<string, string> => (v === null || v === undefined ? {} : { [key]: iso(v) });

export const PERIOD_COLUMNS = ["org_id", "meter", "period_start", "period_end", "plan", "included_minutes", "used_minutes", "reported_overage_minutes", "state", "updated_at"] as const;
export const REPORT_COLUMNS = ["id", "org_id", "meter", "period_start", "quantity", "stripe_identifier", "status", "attempts", "created_at", "sent_at"] as const;
export const NOTICE_COLUMNS = ["org_id", "period_start", "kind", "at", "stop_at", "done_at"] as const;
export const BOX_COLUMNS = ["id", "org_id", "name", "status", "storage_gb", "created_at", "deleted_at"] as const;
export const BOX_INTERVAL_COLUMNS = ["box_id", "org_id", "awake_from", "awake_to"] as const;
export const CAP_COLUMNS = ["org_id", "cap_cents", "explicit_unlimited", "set_by", "set_at"] as const;

const periodFromDb = (r: Record<string, unknown>): UsagePeriodRow =>
  UsagePeriodRow.parse({
    orgId: r.org_id,
    meter: r.meter,
    periodStart: iso(r.period_start),
    periodEnd: iso(r.period_end),
    plan: r.plan,
    includedMinutes: r.included_minutes === null ? null : Number(r.included_minutes),
    usedMinutes: Number(r.used_minutes),
    reportedOverageMinutes: Number(r.reported_overage_minutes),
    state: r.state,
    updatedAt: iso(r.updated_at),
  });

const reportFromDb = (r: Record<string, unknown>): UsageReportRow =>
  UsageReportRow.parse({
    id: r.id,
    orgId: r.org_id,
    meter: r.meter,
    periodStart: iso(r.period_start),
    quantity: Number(r.quantity),
    stripeIdentifier: r.stripe_identifier,
    status: r.status,
    attempts: Number(r.attempts),
    createdAt: iso(r.created_at),
    ...optIso("sentAt", r.sent_at),
  });

const noticeFromDb = (r: Record<string, unknown>): UsageNoticeRow =>
  UsageNoticeRow.parse({ orgId: r.org_id, periodStart: iso(r.period_start), kind: r.kind, at: iso(r.at), ...optIso("stopAt", r.stop_at), ...optIso("doneAt", r.done_at) });

const boxFromDb = (r: Record<string, unknown>): AppBoxRow =>
  AppBoxRow.parse({ id: r.id, orgId: r.org_id, name: r.name, status: r.status, storageGb: Number(r.storage_gb), createdAt: iso(r.created_at), ...optIso("deletedAt", r.deleted_at) });

const boxIntervalFromDb = (r: Record<string, unknown>): AppBoxIntervalRow =>
  AppBoxIntervalRow.parse({ boxId: r.box_id, orgId: r.org_id, awakeFrom: iso(r.awake_from), ...optIso("awakeTo", r.awake_to) });

const where = (clauses: Array<[string, unknown]>): { sql: string; values: unknown[] } => {
  const values: unknown[] = [];
  const parts: string[] = [];
  for (const [clause, value] of clauses) {
    if (value === undefined) continue;
    values.push(value);
    parts.push(clause.replace("?", `$${values.length}`));
  }
  return { sql: parts.length === 0 ? "" : ` WHERE ${parts.join(" AND ")}`, values };
};

export const createMeteringPostgresStore = (pool: pg.Pool): MeteringStore => ({
  async getPeriod(orgId, meter, periodStart) {
    const res = await pool.query(`SELECT * FROM usage_periods WHERE org_id = $1 AND meter = $2 AND period_start = $3`, [orgId, meter, periodStart]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? periodFromDb(r) : undefined;
  },
  async upsertPeriod(row) {
    const p = UsagePeriodRow.parse(row);
    const res = await pool.query(
      `INSERT INTO usage_periods (org_id, meter, period_start, period_end, plan, included_minutes, used_minutes, reported_overage_minutes, state, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (org_id, meter, period_start) DO UPDATE SET
         period_end = EXCLUDED.period_end, included_minutes = EXCLUDED.included_minutes,
         used_minutes = EXCLUDED.used_minutes,
         reported_overage_minutes = GREATEST(usage_periods.reported_overage_minutes, EXCLUDED.reported_overage_minutes),
         state = EXCLUDED.state, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [p.orgId, p.meter, p.periodStart, p.periodEnd, p.plan, p.includedMinutes, p.usedMinutes, p.reportedOverageMinutes, p.state, p.updatedAt],
    );
    return periodFromDb(res.rows[0] as Record<string, unknown>);
  },
  async listPeriods(filter) {
    const w = where([
      ["org_id = ?", filter.orgId],
      ["meter = ?", filter.meter],
      ["plan = ?", filter.plan],
      ["period_start = ?", filter.periodStart],
      ["period_start >= ?", filter.periodStartFrom],
      ["period_start < ?", filter.periodStartBefore],
      ["state = ?", filter.state],
    ]);
    const res = await pool.query(`SELECT * FROM usage_periods${w.sql} ORDER BY period_start, org_id`, w.values);
    return (res.rows as Record<string, unknown>[]).map(periodFromDb);
  },
  async insertReport(row) {
    const r = UsageReportRow.parse(row);
    const res = await pool.query(
      `INSERT INTO usage_reports (id, org_id, meter, period_start, quantity, stripe_identifier, status, attempts, created_at, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (stripe_identifier) DO NOTHING`,
      [r.id, r.orgId, r.meter, r.periodStart, r.quantity, r.stripeIdentifier, r.status, r.attempts, r.createdAt, r.sentAt ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  },
  async updateReport(id, patch) {
    await pool.query(`UPDATE usage_reports SET status = $2, attempts = $3, sent_at = COALESCE($4, sent_at) WHERE id = $1`, [id, patch.status, patch.attempts, patch.sentAt ?? null]);
  },
  async listReports(filter) {
    const w = where([
      ["org_id = ?", filter.orgId],
      ["meter = ?", filter.meter],
      ["period_start = ?", filter.periodStart],
      ["status = ?", filter.status],
    ]);
    const res = await pool.query(`SELECT * FROM usage_reports${w.sql} ORDER BY created_at, id`, w.values);
    return (res.rows as Record<string, unknown>[]).map(reportFromDb);
  },
  async getNotice(orgId, periodStart, kind) {
    const res = await pool.query(`SELECT * FROM usage_notices WHERE org_id = $1 AND period_start = $2 AND kind = $3`, [orgId, periodStart, kind]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? noticeFromDb(r) : undefined;
  },
  async insertNotice(row) {
    const n = UsageNoticeRow.parse(row);
    const res = await pool.query(
      `INSERT INTO usage_notices (org_id, period_start, kind, at, stop_at, done_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [n.orgId, n.periodStart, n.kind, n.at, n.stopAt ?? null, n.doneAt ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  },
  async updateNotice(orgId, periodStart, kind, patch) {
    await pool.query(`UPDATE usage_notices SET done_at = COALESCE($4, done_at), stop_at = COALESCE($5, stop_at) WHERE org_id = $1 AND period_start = $2 AND kind = $3`, [
      orgId,
      periodStart,
      kind,
      patch.doneAt ?? null,
      patch.stopAt ?? null,
    ]);
  },
  async deleteNotice(orgId, periodStart, kind) {
    await pool.query(`DELETE FROM usage_notices WHERE org_id = $1 AND period_start = $2 AND kind = $3`, [orgId, periodStart, kind]);
  },
  async listNotices(filter) {
    const w = where([
      ["org_id = ?", filter.orgId],
      ["kind = ?", filter.kind],
    ]);
    const open = filter.open === undefined ? "" : `${w.sql === "" ? " WHERE" : " AND"} done_at IS ${filter.open ? "" : "NOT "}NULL`;
    const res = await pool.query(`SELECT * FROM usage_notices${w.sql}${open} ORDER BY at`, w.values);
    return (res.rows as Record<string, unknown>[]).map(noticeFromDb);
  },
  async insertBox(row) {
    const b = AppBoxRow.parse(row);
    await pool.query(
      `INSERT INTO app_boxes (id, org_id, name, status, storage_gb, created_at, deleted_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [b.id, b.orgId, b.name, b.status, b.storageGb, b.createdAt, b.deletedAt ?? null],
    );
  },
  async getBox(id) {
    const res = await pool.query(`SELECT * FROM app_boxes WHERE id = $1`, [id]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? boxFromDb(r) : undefined;
  },
  async updateBox(id, patch) {
    const sets: string[] = [];
    const values: unknown[] = [id];
    const columns: Record<string, string> = { status: "status", deletedAt: "deleted_at", storageGb: "storage_gb", name: "name" };
    for (const [key, column] of Object.entries(columns)) {
      const value = (patch as Record<string, unknown>)[key];
      if (value === undefined) continue;
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length > 0) await pool.query(`UPDATE app_boxes SET ${sets.join(", ")} WHERE id = $1`, values);
    const res = await pool.query(`SELECT * FROM app_boxes WHERE id = $1`, [id]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r ? boxFromDb(r) : undefined;
  },
  async listBoxes(orgId, options = {}) {
    const res = await pool.query(`SELECT * FROM app_boxes WHERE org_id = $1${options.includeDeleted === true ? "" : ` AND status <> 'deleted'`} ORDER BY created_at, id`, [orgId]);
    return (res.rows as Record<string, unknown>[]).map(boxFromDb);
  },
  async openBoxInterval(row) {
    const i = AppBoxIntervalRow.parse(row);
    await pool.query(`INSERT INTO app_box_intervals (box_id, org_id, awake_from, awake_to) VALUES ($1, $2, $3, NULL) ON CONFLICT DO NOTHING`, [i.boxId, i.orgId, i.awakeFrom]);
  },
  async closeBoxInterval(boxId, at) {
    const res = await pool.query(`UPDATE app_box_intervals SET awake_to = $2 WHERE box_id = $1 AND awake_to IS NULL`, [boxId, at]);
    return (res.rowCount ?? 0) > 0;
  },
  async listBoxIntervals(orgId, from, to) {
    const res = await pool.query(`SELECT * FROM app_box_intervals WHERE org_id = $1 AND awake_from < $3 AND (awake_to IS NULL OR awake_to > $2) ORDER BY awake_from`, [orgId, from, to]);
    return (res.rows as Record<string, unknown>[]).map(boxIntervalFromDb);
  },
  async getCap(orgId) {
    const res = await pool.query(`SELECT * FROM spending_caps WHERE org_id = $1`, [orgId]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    return r
      ? SpendingCapRow.parse({ orgId: r.org_id, capCents: r.cap_cents === null ? null : Number(r.cap_cents), explicitUnlimited: Boolean(r.explicit_unlimited), setBy: r.set_by, setAt: iso(r.set_at) })
      : undefined;
  },
  async setCap(row) {
    const c = SpendingCapRow.parse(row);
    await pool.query(
      `INSERT INTO spending_caps (org_id, cap_cents, explicit_unlimited, set_by, set_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET cap_cents = EXCLUDED.cap_cents, explicit_unlimited = EXCLUDED.explicit_unlimited, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at`,
      [c.orgId, c.capCents, c.explicitUnlimited, c.setBy, c.setAt],
    );
  },
});
