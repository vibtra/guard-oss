import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const WORKSPACE_STATUSES = ["stopped", "starting", "running", "stopping", "failed"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];
export const SESSION_AGENTS = ["claude", "codex", "cmd"] as const;
export type SessionAgent = (typeof SESSION_AGENTS)[number];
export const CLOSE_REASONS = ["exited", "killed", "workspace_stopped"] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

const ISO = z.string().min(10).max(40);
const ORG_ID = z.string().min(1).max(100);
const USER_ID = z.string().min(1).max(100);
const HOST_ID = z.string().regex(/^host_[0-9a-f]{16}$/);

export const WorkspaceProfile = z
  .object({
    claude: z.enum(["personal", "org-key", "off"]),
    codex: z.enum(["chatgpt", "org-key", "off"]),
    connectorProxy: z.enum(["blocked", "allowed"]),
  })
  .strict();
export type WorkspaceProfile = z.infer<typeof WorkspaceProfile>;

export const WorkspacePolicy = WorkspaceProfile.extend({ detachGraceMin: z.number().int().min(15).max(240) }).strict();
export type WorkspacePolicy = z.infer<typeof WorkspacePolicy>;

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = Object.freeze({ claude: "personal", codex: "chatgpt", connectorProxy: "blocked", detachGraceMin: 60 });

export const WorkspaceRow = z
  .object({
    id: z.string().regex(/^wsp_[0-9a-f]{20}$/),
    orgId: ORG_ID,
    userId: USER_ID,
    hostId: HOST_ID.optional(),
    status: z.enum(WORKSPACE_STATUSES),
    profile: WorkspaceProfile,
    detachGraceMin: z.number().int().min(15).max(240),
    imageDigest: z.string().regex(/^sha256:[0-9a-z]{1,64}$/).optional(),
    lastStartedAt: ISO.optional(),
    lastStoppedAt: ISO.optional(),
    restartRequired: z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/), revision: z.string().max(200).optional(), at: ISO, connections: z.array(z.string().min(1).max(64)).max(10).optional(), refused: z.array(z.object({ name: z.string().min(1).max(64), reason: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/) }).strict()).max(10).optional() }).strict().optional(),
    createdAt: ISO,
  })
  .strict();
export type WorkspaceRow = z.infer<typeof WorkspaceRow>;

export const WorkspaceSessionRow = z
  .object({
    id: z.string().regex(/^wss_[0-9a-f]{20}$/),
    workspaceId: z.string().regex(/^wsp_[0-9a-f]{20}$/),
    orgId: ORG_ID,
    userId: USER_ID,
    agent: z.enum(SESSION_AGENTS),
    name: z.string().regex(/^[a-z0-9-]{1,32}$/),
    argvSha256: z.string().regex(/^[0-9a-f]{64}$/),
    openedAt: ISO,
    closedAt: ISO.optional(),
    closeReason: z.enum(CLOSE_REASONS).optional(),
  })
  .strict();
export type WorkspaceSessionRow = z.infer<typeof WorkspaceSessionRow>;

export const WorkspaceAttachmentRow = z
  .object({
    id: z.string().regex(/^wsa_[0-9a-f]{20}$/),
    sessionId: z.string().regex(/^wss_[0-9a-f]{20}$/),
    orgId: ORG_ID,
    openedAt: ISO,
    closedAt: ISO.optional(),
    attachMs: z.number().int().min(0).max(3_600_000).optional(),
    rttP50Ms: z.number().int().min(0).max(600_000).optional(),
    echoP50Ms: z.number().int().min(0).max(600_000).optional(),
    clientOs: z.enum(["darwin", "linux", "win32", "other"]).optional(),
    clientVersion: z.string().regex(/^[0-9A-Za-z.+-]{1,32}$/).optional(),
    client: z.enum(["cli", "web"]).optional(),
  })
  .strict();
export type WorkspaceAttachmentRow = z.infer<typeof WorkspaceAttachmentRow>;

export const AttachTicketRow = z
  .object({
    ticketSha256: z.string().regex(/^[0-9a-f]{64}$/),
    userId: z.string().min(1),
    orgId: ORG_ID,
    sessionId: z.string().regex(/^wss_[0-9a-f]{20}$/),
    consoleSessionId: z.string().min(1).max(200),
    origin: z.string().min(1).max(300),
    expiresAt: ISO,
    usedAt: ISO.optional(),
    createdAt: ISO,
  })
  .strict();
export type AttachTicketRow = z.infer<typeof AttachTicketRow>;

export const VmIntervalRow = z
  .object({
    workspaceId: z.string().regex(/^wsp_[0-9a-f]{20}$/),
    orgId: ORG_ID,
    startedAt: ISO,
    stoppedAt: ISO.optional(),
  })
  .strict();
export type VmIntervalRow = z.infer<typeof VmIntervalRow>;

export interface AttachmentWindow {
  workspaceId: string;
  openedAt: string;
  closedAt?: string;
}

const overlaps = (startedAt: string, stoppedAt: string | undefined, from: string, to: string): boolean =>
  Date.parse(startedAt) < Date.parse(to) && (stoppedAt === undefined || Date.parse(stoppedAt) > Date.parse(from));

export const WORKSPACE_HOST_REASONS = ["moved", "drain", "failover", "gone", "tier"] as const;
export const WorkspaceHostRow = z
  .object({
    workspaceId: z.string().regex(/^wsp_[0-9a-f]{20}$/),
    orgId: ORG_ID,
    userId: USER_ID,
    hostId: HOST_ID,
    assignedAt: ISO,
    releasedAt: ISO.optional(),
    reason: z.enum(WORKSPACE_HOST_REASONS).optional(),
    homeWipedAt: ISO.optional(),
  })
  .strict();
export type WorkspaceHostRow = z.infer<typeof WorkspaceHostRow>;

export type WorkspacePatch = Partial<Omit<WorkspaceRow, "id" | "orgId" | "userId" | "createdAt">>;

export interface WorkspaceStore {
  getWorkspace(id: string): Promise<WorkspaceRow | undefined>;
  findWorkspace(orgId: string, userId: string): Promise<WorkspaceRow | undefined>;
  insertWorkspace(row: WorkspaceRow): Promise<WorkspaceRow>;
  updateWorkspace(id: string, patch: WorkspacePatch): Promise<WorkspaceRow | undefined>;
  listWorkspaces(filter: { hostId?: string; orgId?: string; statuses?: readonly WorkspaceStatus[] }): Promise<WorkspaceRow[]>;

  insertSession(row: WorkspaceSessionRow): Promise<void>;
  getSession(id: string): Promise<WorkspaceSessionRow | undefined>;
  findOpenSession(workspaceId: string, name: string): Promise<WorkspaceSessionRow | undefined>;
  listOpenSessions(workspaceId: string): Promise<WorkspaceSessionRow[]>;
  closeSession(id: string, at: string, reason: CloseReason): Promise<boolean>;

  insertAttachment(row: WorkspaceAttachmentRow): Promise<void>;
  closeAttachment(id: string, patch: Pick<WorkspaceAttachmentRow, "closedAt"> & Partial<WorkspaceAttachmentRow>): Promise<boolean>;
  listAttachments(sessionId: string): Promise<WorkspaceAttachmentRow[]>;

  openInterval(row: VmIntervalRow): Promise<void>;
  closeOpenInterval(workspaceId: string, at: string): Promise<boolean>;
  listIntervals(workspaceId: string): Promise<VmIntervalRow[]>;
  listOrgIntervals(orgId: string, from: string, to: string): Promise<VmIntervalRow[]>;
  listOrgAttachmentWindows(orgId: string, from: string, to: string): Promise<AttachmentWindow[]>;

  getPolicy(orgId: string): Promise<WorkspacePolicy>;
  setPolicy(orgId: string, policy: WorkspacePolicy): Promise<void>;

  assignWorkspaceHost(row: WorkspaceHostRow): Promise<void>;
  releaseWorkspaceHost(workspaceId: string, at: string, reason: WorkspaceHostRow["reason"]): Promise<boolean>;
  listWorkspaceHostHistory(workspaceId: string): Promise<WorkspaceHostRow[]>;
  listStaleHomes(hostId: string): Promise<WorkspaceHostRow[]>;
  markHomeWiped(workspaceId: string, hostId: string, at: string): Promise<number>;

  insertAttachTicket(row: AttachTicketRow): Promise<void>;
  redeemAttachTicket(ticketSha256: string, at: string): Promise<AttachTicketRow | undefined>;
  reapAttachTickets(before: string): Promise<number>;
}

interface FileShape {
  workspaces: WorkspaceRow[];
  sessions: WorkspaceSessionRow[];
  attachments: WorkspaceAttachmentRow[];
  intervals: VmIntervalRow[];
  policies: Record<string, WorkspacePolicy>;
  placements: WorkspaceHostRow[];
}

const empty = (): FileShape => ({ workspaces: [], sessions: [], attachments: [], intervals: [], policies: {}, placements: [] });

export const createFileWorkspaceStore = async (file: string): Promise<WorkspaceStore> => {
  let state: FileShape;
  try {
    state = { ...empty(), ...(JSON.parse(await readFile(file, "utf8")) as Partial<FileShape>) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = empty();
  }
  let chain: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return chain;
  };
  return createWorkspaceStoreOver(() => state, save);
};

export const createMemoryWorkspaceStore = (): WorkspaceStore => {
  const state = empty();
  return createWorkspaceStoreOver(() => state, async () => undefined);
};

const createWorkspaceStoreOver = (get: () => FileShape, save: () => Promise<void>): WorkspaceStore => {
  const tickets = new Map<string, AttachTicketRow>();
  return {
  async getWorkspace(id) {
    const row = get().workspaces.find((w) => w.id === id);
    return row ? structuredClone(row) : undefined;
  },
  async findWorkspace(orgId, userId) {
    const row = get().workspaces.find((w) => w.orgId === orgId && w.userId === userId);
    return row ? structuredClone(row) : undefined;
  },
  async insertWorkspace(row) {
    const parsed = WorkspaceRow.parse(row);
    const existing = get().workspaces.find((w) => w.orgId === parsed.orgId && w.userId === parsed.userId);
    if (existing) return structuredClone(existing);
    get().workspaces.push(parsed);
    await save();
    return structuredClone(parsed);
  },
  async updateWorkspace(id, patch) {
    const state = get();
    const index = state.workspaces.findIndex((w) => w.id === id);
    if (index < 0) return undefined;
    const next: Record<string, unknown> = { ...state.workspaces[index]!, ...patch };
    for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
    state.workspaces[index] = WorkspaceRow.parse(next);
    await save();
    return structuredClone(state.workspaces[index]!);
  },
  async listWorkspaces(filter) {
    return get()
      .workspaces.filter((w) => (filter.hostId === undefined || w.hostId === filter.hostId) && (filter.orgId === undefined || w.orgId === filter.orgId) && (filter.statuses === undefined || filter.statuses.includes(w.status)))
      .map((w) => structuredClone(w));
  },
  async insertSession(row) {
    get().sessions.push(WorkspaceSessionRow.parse(row));
    await save();
  },
  async getSession(id) {
    const row = get().sessions.find((s) => s.id === id);
    return row ? structuredClone(row) : undefined;
  },
  async findOpenSession(workspaceId, name) {
    const row = get().sessions.find((s) => s.workspaceId === workspaceId && s.name === name && s.closedAt === undefined);
    return row ? structuredClone(row) : undefined;
  },
  async listOpenSessions(workspaceId) {
    return get()
      .sessions.filter((s) => s.workspaceId === workspaceId && s.closedAt === undefined)
      .map((s) => structuredClone(s));
  },
  async closeSession(id, at, reason) {
    const row = get().sessions.find((s) => s.id === id);
    if (!row || row.closedAt !== undefined) return false;
    row.closedAt = at;
    row.closeReason = reason;
    await save();
    return true;
  },
  async insertAttachment(row) {
    get().attachments.push(WorkspaceAttachmentRow.parse(row));
    await save();
  },
  async closeAttachment(id, patch) {
    const state = get();
    const index = state.attachments.findIndex((a) => a.id === id);
    if (index < 0 || state.attachments[index]!.closedAt !== undefined) return false;
    state.attachments[index] = WorkspaceAttachmentRow.parse({ ...state.attachments[index]!, ...patch, id });
    await save();
    return true;
  },
  async listAttachments(sessionId) {
    return get()
      .attachments.filter((a) => a.sessionId === sessionId)
      .map((a) => structuredClone(a));
  },
  async openInterval(row) {
    const parsed = VmIntervalRow.parse(row);
    if (get().intervals.some((i) => i.workspaceId === parsed.workspaceId && i.stoppedAt === undefined)) return;
    get().intervals.push(parsed);
    await save();
  },
  async closeOpenInterval(workspaceId, at) {
    const row = get().intervals.find((i) => i.workspaceId === workspaceId && i.stoppedAt === undefined);
    if (!row) return false;
    row.stoppedAt = at;
    await save();
    return true;
  },
  async listIntervals(workspaceId) {
    return get()
      .intervals.filter((i) => i.workspaceId === workspaceId)
      .map((i) => structuredClone(i));
  },
  async listOrgIntervals(orgId, from, to) {
    return get()
      .intervals.filter((i) => i.orgId === orgId && overlaps(i.startedAt, i.stoppedAt, from, to))
      .map((i) => structuredClone(i));
  },
  async listOrgAttachmentWindows(orgId, from, to) {
    const state = get();
    const workspaceOf = new Map(state.sessions.filter((s) => s.orgId === orgId).map((s) => [s.id, s.workspaceId]));
    return state.attachments
      .filter((a) => a.orgId === orgId && workspaceOf.has(a.sessionId) && overlaps(a.openedAt, a.closedAt, from, to))
      .map((a) => ({ workspaceId: workspaceOf.get(a.sessionId)!, openedAt: a.openedAt, ...(a.closedAt ? { closedAt: a.closedAt } : {}) }));
  },
  async getPolicy(orgId) {
    return structuredClone(get().policies[orgId] ?? DEFAULT_WORKSPACE_POLICY);
  },
  async setPolicy(orgId, policy) {
    get().policies[orgId] = WorkspacePolicy.parse(policy);
    await save();
  },
  async assignWorkspaceHost(row) {
    const parsed = WorkspaceHostRow.parse(row);
    const state = get();
    if (state.placements.some((p) => p.workspaceId === parsed.workspaceId && p.releasedAt === undefined)) throw new Error(`workspace ${parsed.workspaceId} is already placed`);
    state.placements.push(parsed);
    await save();
  },
  async releaseWorkspaceHost(workspaceId, at, reason) {
    const open = get().placements.find((p) => p.workspaceId === workspaceId && p.releasedAt === undefined);
    if (!open) return false;
    open.releasedAt = at;
    if (reason) open.reason = reason;
    await save();
    return true;
  },
  async listWorkspaceHostHistory(workspaceId) {
    return get()
      .placements.filter((p) => p.workspaceId === workspaceId)
      .sort((a, b) => (a.assignedAt < b.assignedAt ? -1 : 1))
      .map((p) => structuredClone(p));
  },
  async listStaleHomes(hostId) {
    return get()
      .placements.filter((p) => p.hostId === hostId && p.releasedAt !== undefined && p.homeWipedAt === undefined)
      .map((p) => structuredClone(p));
  },
  async markHomeWiped(workspaceId, hostId, at) {
    let n = 0;
    for (const p of get().placements) {
      if (p.workspaceId === workspaceId && p.hostId === hostId && p.releasedAt !== undefined && p.homeWipedAt === undefined) {
        p.homeWipedAt = at;
        n += 1;
      }
    }
    if (n > 0) await save();
    return n;
  },
  async insertAttachTicket(row) {
    const parsed = AttachTicketRow.parse(row);
    tickets.set(parsed.ticketSha256, parsed);
  },
  async redeemAttachTicket(ticketSha256, at) {
    const row = tickets.get(ticketSha256);
    if (!row || row.usedAt !== undefined) return undefined;
    tickets.set(ticketSha256, { ...row, usedAt: at });
    return structuredClone(row);
  },
  async reapAttachTickets(before) {
    let n = 0;
    for (const [hash, row] of tickets) {
      if (row.expiresAt < before) {
        tickets.delete(hash);
        n += 1;
      }
    }
    return n;
  },
  };
};
