import type pg from "pg";
import {
  AttachTicketRow,
  DEFAULT_WORKSPACE_POLICY,
  VmIntervalRow,
  WorkspaceAttachmentRow,
  WorkspaceHostRow,
  type WorkspacePatch,
  WorkspacePolicy,
  WorkspaceRow,
  WorkspaceSessionRow,
  type WorkspaceStore,
} from "./store.js";

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v));
const opt = <T>(key: string, v: unknown, map: (x: unknown) => T = (x) => x as T): Record<string, T> => (v === null || v === undefined ? {} : { [key]: map(v) });

export const WORKSPACE_COLUMNS = ["id", "org_id", "user_id", "host_id", "status", "profile", "detach_grace_min", "image_digest", "last_started_at", "last_stopped_at", "created_at", "restart_required"] as const;
export const SESSION_COLUMNS = ["id", "workspace_id", "org_id", "user_id", "agent", "name", "argv_sha256", "opened_at", "closed_at", "close_reason"] as const;
export const ATTACHMENT_COLUMNS = ["id", "session_id", "org_id", "opened_at", "closed_at", "attach_ms", "rtt_p50_ms", "echo_p50_ms", "client_os", "client_version", "client"] as const;
export const ATTACH_TICKET_COLUMNS = ["ticket_sha256", "user_id", "org_id", "session_id", "console_session_id", "origin", "expires_at", "used_at", "created_at"] as const;
export const INTERVAL_COLUMNS = ["workspace_id", "org_id", "started_at", "stopped_at"] as const;
export const WORKSPACE_HOST_COLUMNS = ["workspace_id", "org_id", "user_id", "host_id", "assigned_at", "released_at", "reason", "home_wiped_at"] as const;
const placementFromDb = (r: Record<string, unknown>): WorkspaceHostRow =>
  WorkspaceHostRow.parse({
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    hostId: r.host_id,
    assignedAt: iso(r.assigned_at),
    ...opt("releasedAt", r.released_at, iso),
    ...opt("reason", r.reason),
    ...opt("homeWipedAt", r.home_wiped_at, iso),
  });
export const POLICY_COLUMNS = ["org_id", "claude", "codex", "connector_proxy", "detach_grace_min"] as const;

const workspaceFromDb = (r: Record<string, unknown>): WorkspaceRow =>
  WorkspaceRow.parse({
    id: r.id,
    orgId: r.org_id,
    userId: r.user_id,
    ...opt("hostId", r.host_id),
    status: r.status,
    profile: r.profile,
    detachGraceMin: r.detach_grace_min,
    ...opt("imageDigest", r.image_digest),
    ...opt("lastStartedAt", r.last_started_at, iso),
    ...opt("lastStoppedAt", r.last_stopped_at, iso),
    ...opt("restartRequired", r.restart_required),
    createdAt: iso(r.created_at),
  });

const sessionFromDb = (r: Record<string, unknown>): WorkspaceSessionRow =>
  WorkspaceSessionRow.parse({
    id: r.id,
    workspaceId: r.workspace_id,
    orgId: r.org_id,
    userId: r.user_id,
    agent: r.agent,
    name: r.name,
    argvSha256: r.argv_sha256,
    openedAt: iso(r.opened_at),
    ...opt("closedAt", r.closed_at, iso),
    ...opt("closeReason", r.close_reason),
  });

const attachmentFromDb = (r: Record<string, unknown>): WorkspaceAttachmentRow =>
  WorkspaceAttachmentRow.parse({
    id: r.id,
    sessionId: r.session_id,
    orgId: r.org_id,
    openedAt: iso(r.opened_at),
    ...opt("closedAt", r.closed_at, iso),
    ...opt("attachMs", r.attach_ms, Number),
    ...opt("rttP50Ms", r.rtt_p50_ms, Number),
    ...opt("echoP50Ms", r.echo_p50_ms, Number),
    ...opt("clientOs", r.client_os),
    ...opt("clientVersion", r.client_version),
    ...opt("client", r.client),
  });

const ticketFromDb = (r: Record<string, unknown>): AttachTicketRow =>
  AttachTicketRow.parse({
    ticketSha256: r.ticket_sha256,
    userId: r.user_id,
    orgId: r.org_id,
    sessionId: r.session_id,
    consoleSessionId: r.console_session_id,
    origin: r.origin,
    expiresAt: iso(r.expires_at),
    ...opt("usedAt", r.used_at, iso),
    createdAt: iso(r.created_at),
  });

const intervalFromDb = (r: Record<string, unknown>): VmIntervalRow =>
  VmIntervalRow.parse({ workspaceId: r.workspace_id, orgId: r.org_id, startedAt: iso(r.started_at), ...opt("stoppedAt", r.stopped_at, iso) });

const PATCH_COLUMNS: Record<keyof WorkspacePatch, string> = {
  hostId: "host_id",
  status: "status",
  profile: "profile",
  detachGraceMin: "detach_grace_min",
  imageDigest: "image_digest",
  lastStartedAt: "last_started_at",
  lastStoppedAt: "last_stopped_at",
  restartRequired: "restart_required",
};

export const createWorkspacePostgresStore = (pool: pg.Pool): WorkspaceStore => ({
  async getWorkspace(id) {
    const res = await pool.query(`SELECT * FROM workspaces WHERE id = $1`, [id]);
    return res.rows[0] ? workspaceFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async findWorkspace(orgId, userId) {
    const res = await pool.query(`SELECT * FROM workspaces WHERE org_id = $1 AND user_id = $2`, [orgId, userId]);
    return res.rows[0] ? workspaceFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async insertWorkspace(row) {
    const w = WorkspaceRow.parse(row);
    const res = await pool.query(
      `INSERT INTO workspaces (id, org_id, user_id, host_id, status, profile, detach_grace_min, image_digest, last_started_at, last_stopped_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (org_id, user_id) DO NOTHING RETURNING *`,
      [w.id, w.orgId, w.userId, w.hostId ?? null, w.status, JSON.stringify(w.profile), w.detachGraceMin, w.imageDigest ?? null, w.lastStartedAt ?? null, w.lastStoppedAt ?? null, w.createdAt],
    );
    if (res.rows[0]) return workspaceFromDb(res.rows[0] as Record<string, unknown>);
    const existing = await pool.query(`SELECT * FROM workspaces WHERE org_id = $1 AND user_id = $2`, [w.orgId, w.userId]);
    return workspaceFromDb(existing.rows[0] as Record<string, unknown>);
  },
  async updateWorkspace(id, patch) {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, column] of Object.entries(PATCH_COLUMNS) as Array<[keyof WorkspacePatch, string]>) {
      if (!(key in patch)) continue;
      const value = patch[key];
      values.push(value === undefined ? null : key === "profile" || key === "restartRequired" ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length === 0) return this.getWorkspace(id);
    values.push(id);
    const res = await pool.query(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${values.length} RETURNING *`, values);
    return res.rows[0] ? workspaceFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async listWorkspaces(filter) {
    const where: string[] = [];
    const values: unknown[] = [];
    if (filter.hostId !== undefined) {
      values.push(filter.hostId);
      where.push(`host_id = $${values.length}`);
    }
    if (filter.orgId !== undefined) {
      values.push(filter.orgId);
      where.push(`org_id = $${values.length}`);
    }
    if (filter.statuses !== undefined) {
      values.push([...filter.statuses]);
      where.push(`status = ANY($${values.length})`);
    }
    const res = await pool.query(`SELECT * FROM workspaces ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at`, values);
    return (res.rows as Record<string, unknown>[]).map(workspaceFromDb);
  },
  async insertSession(row) {
    const s = WorkspaceSessionRow.parse(row);
    await pool.query(
      `INSERT INTO workspace_sessions (id, workspace_id, org_id, user_id, agent, name, argv_sha256, opened_at, closed_at, close_reason) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [s.id, s.workspaceId, s.orgId, s.userId, s.agent, s.name, s.argvSha256, s.openedAt, s.closedAt ?? null, s.closeReason ?? null],
    );
  },
  async getSession(id) {
    const res = await pool.query(`SELECT * FROM workspace_sessions WHERE id = $1`, [id]);
    return res.rows[0] ? sessionFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async findOpenSession(workspaceId, name) {
    const res = await pool.query(`SELECT * FROM workspace_sessions WHERE workspace_id = $1 AND name = $2 AND closed_at IS NULL ORDER BY opened_at LIMIT 1`, [workspaceId, name]);
    return res.rows[0] ? sessionFromDb(res.rows[0] as Record<string, unknown>) : undefined;
  },
  async listOpenSessions(workspaceId) {
    const res = await pool.query(`SELECT * FROM workspace_sessions WHERE workspace_id = $1 AND closed_at IS NULL ORDER BY opened_at`, [workspaceId]);
    return (res.rows as Record<string, unknown>[]).map(sessionFromDb);
  },
  async closeSession(id, at, reason) {
    const res = await pool.query(`UPDATE workspace_sessions SET closed_at = $2, close_reason = $3 WHERE id = $1 AND closed_at IS NULL`, [id, at, reason]);
    return (res.rowCount ?? 0) > 0;
  },
  async insertAttachment(row) {
    const a = WorkspaceAttachmentRow.parse(row);
    await pool.query(
      `INSERT INTO workspace_attachments (id, session_id, org_id, opened_at, closed_at, attach_ms, rtt_p50_ms, echo_p50_ms, client_os, client_version, client) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [a.id, a.sessionId, a.orgId, a.openedAt, a.closedAt ?? null, a.attachMs ?? null, a.rttP50Ms ?? null, a.echoP50Ms ?? null, a.clientOs ?? null, a.clientVersion ?? null, a.client ?? null],
    );
  },
  async closeAttachment(id, patch) {
    const current = await pool.query(`SELECT * FROM workspace_attachments WHERE id = $1 AND closed_at IS NULL`, [id]);
    if (!current.rows[0]) return false;
    const next = WorkspaceAttachmentRow.parse({ ...attachmentFromDb(current.rows[0] as Record<string, unknown>), ...patch, id });
    const res = await pool.query(
      `UPDATE workspace_attachments SET closed_at = $2, attach_ms = $3, rtt_p50_ms = $4, echo_p50_ms = $5, client_os = $6, client_version = $7 WHERE id = $1 AND closed_at IS NULL`,
      [id, next.closedAt ?? null, next.attachMs ?? null, next.rttP50Ms ?? null, next.echoP50Ms ?? null, next.clientOs ?? null, next.clientVersion ?? null],
    );
    return (res.rowCount ?? 0) > 0;
  },
  async listAttachments(sessionId) {
    const res = await pool.query(`SELECT * FROM workspace_attachments WHERE session_id = $1 ORDER BY opened_at`, [sessionId]);
    return (res.rows as Record<string, unknown>[]).map(attachmentFromDb);
  },
  async openInterval(row) {
    const i = VmIntervalRow.parse(row);
    await pool.query(`INSERT INTO workspace_vm_intervals (workspace_id, org_id, started_at, stopped_at) VALUES ($1, $2, $3, NULL) ON CONFLICT DO NOTHING`, [i.workspaceId, i.orgId, i.startedAt]);
  },
  async closeOpenInterval(workspaceId, at) {
    const res = await pool.query(`UPDATE workspace_vm_intervals SET stopped_at = $2 WHERE workspace_id = $1 AND stopped_at IS NULL`, [workspaceId, at]);
    return (res.rowCount ?? 0) > 0;
  },
  async listIntervals(workspaceId) {
    const res = await pool.query(`SELECT * FROM workspace_vm_intervals WHERE workspace_id = $1 ORDER BY started_at`, [workspaceId]);
    return (res.rows as Record<string, unknown>[]).map(intervalFromDb);
  },
  async listOrgIntervals(orgId, from, to) {
    const res = await pool.query(
      `SELECT * FROM workspace_vm_intervals WHERE org_id = $1 AND started_at < $3 AND (stopped_at IS NULL OR stopped_at > $2) ORDER BY started_at`,
      [orgId, from, to],
    );
    return (res.rows as Record<string, unknown>[]).map(intervalFromDb);
  },
  async listOrgAttachmentWindows(orgId, from, to) {
    const res = await pool.query(
      `SELECT s.workspace_id, a.opened_at, a.closed_at FROM workspace_attachments a JOIN workspace_sessions s ON s.id = a.session_id
        WHERE a.org_id = $1 AND a.opened_at < $3 AND (a.closed_at IS NULL OR a.closed_at > $2) ORDER BY a.opened_at`,
      [orgId, from, to],
    );
    return (res.rows as Record<string, unknown>[]).map((r) => ({ workspaceId: String(r.workspace_id), openedAt: iso(r.opened_at), ...(r.closed_at ? { closedAt: iso(r.closed_at) } : {}) }));
  },
  async getPolicy(orgId) {
    const res = await pool.query(`SELECT * FROM workspace_policies WHERE org_id = $1`, [orgId]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) return { ...DEFAULT_WORKSPACE_POLICY };
    return WorkspacePolicy.parse({ claude: r.claude, codex: r.codex, connectorProxy: r.connector_proxy, detachGraceMin: r.detach_grace_min });
  },
  async setPolicy(orgId, policy) {
    const p = WorkspacePolicy.parse(policy);
    await pool.query(
      `INSERT INTO workspace_policies (org_id, claude, codex, connector_proxy, detach_grace_min) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id) DO UPDATE SET claude = $2, codex = $3, connector_proxy = $4, detach_grace_min = $5`,
      [orgId, p.claude, p.codex, p.connectorProxy, p.detachGraceMin],
    );
  },
  async assignWorkspaceHost(row) {
    const p = WorkspaceHostRow.parse(row);
    await pool.query(`INSERT INTO workspace_hosts (workspace_id, org_id, user_id, host_id, assigned_at) VALUES ($1, $2, $3, $4, $5)`, [p.workspaceId, p.orgId, p.userId, p.hostId, p.assignedAt]);
  },
  async releaseWorkspaceHost(workspaceId, at, reason) {
    const res = await pool.query(`UPDATE workspace_hosts SET released_at = $2, reason = $3 WHERE workspace_id = $1 AND released_at IS NULL`, [workspaceId, at, reason ?? null]);
    return (res.rowCount ?? 0) > 0;
  },
  async listWorkspaceHostHistory(workspaceId) {
    const res = await pool.query(`SELECT * FROM workspace_hosts WHERE workspace_id = $1 ORDER BY assigned_at`, [workspaceId]);
    return (res.rows as Record<string, unknown>[]).map(placementFromDb);
  },
  async listStaleHomes(hostId) {
    const res = await pool.query(`SELECT * FROM workspace_hosts WHERE host_id = $1 AND released_at IS NOT NULL AND home_wiped_at IS NULL ORDER BY assigned_at`, [hostId]);
    return (res.rows as Record<string, unknown>[]).map(placementFromDb);
  },
  async markHomeWiped(workspaceId, hostId, at) {
    const res = await pool.query(`UPDATE workspace_hosts SET home_wiped_at = $3 WHERE workspace_id = $1 AND host_id = $2 AND released_at IS NOT NULL AND home_wiped_at IS NULL`, [workspaceId, hostId, at]);
    return res.rowCount ?? 0;
  },
  async insertAttachTicket(row) {
    const t = AttachTicketRow.parse(row);
    await pool.query(
      `INSERT INTO attach_tickets (ticket_sha256, user_id, org_id, session_id, console_session_id, origin, expires_at, used_at, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [t.ticketSha256, t.userId, t.orgId, t.sessionId, t.consoleSessionId, t.origin, t.expiresAt, t.usedAt ?? null, t.createdAt],
    );
  },
  async redeemAttachTicket(ticketSha256, at) {
    const res = await pool.query(`UPDATE attach_tickets SET used_at = $2 WHERE ticket_sha256 = $1 AND used_at IS NULL RETURNING *`, [ticketSha256, at]);
    const r = res.rows[0] as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const { usedAt: _used, ...before } = ticketFromDb(r);
    return before;
  },
  async reapAttachTickets(before) {
    const res = await pool.query(`DELETE FROM attach_tickets WHERE expires_at < $1`, [before]);
    return res.rowCount ?? 0;
  },
});
