import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const ISO = z.string().min(10).max(40);
const ORG_ID = z.string().min(1).max(100);
const USER_ID = z.string().min(1).max(200);
const REVISION_ID = z.string().regex(/^rev_[a-z2-7]{26}$/);
export const REQUEST_ID = z.string().regex(/^preq_[0-9a-f]{20}$/);
export const GRANT_ID = z.string().regex(/^pgr_[0-9a-f]{20}$/);

export const POLICY_REQUEST_ROW_KINDS = ["package", "egress-host", "connector", "model", "policy-change", "package-registry", "image-change", "spending-cap", "plan", "app-promote", "history-exception", "guard"] as const;
export type PolicyRequestRowKind = (typeof POLICY_REQUEST_ROW_KINDS)[number];
export const POLICY_GRANT_KINDS = ["package", "egress-host", "connector", "model", "package-registry", "guard"] as const;
export type PolicyGrantKind = (typeof POLICY_GRANT_KINDS)[number];
export const POLICY_REQUEST_STATUSES = ["pending", "approved", "declined", "expired", "cancelled", "superseded"] as const;
export type PolicyRequestStatus = (typeof POLICY_REQUEST_STATUSES)[number];

export const PolicyRequestRow = z
  .object({
    id: REQUEST_ID,
    orgId: ORG_ID,
    workspaceId: z.string().regex(/^wsp_[0-9a-f]{20}$/).optional(),
    sessionId: z.string().regex(/^wss_[0-9a-f]{20}$/).optional(),
    requesterUserId: USER_ID,
    kind: z.enum(POLICY_REQUEST_ROW_KINDS),
    subject: z.record(z.unknown()),
    subjectKey: z.string().min(1).max(300),
    why: z.string().min(1).max(280).optional(),
    proposedRevision: REVISION_ID.optional(),
    baseRevision: REVISION_ID.optional(),
    status: z.enum(POLICY_REQUEST_STATUSES),
    decidedBy: USER_ID.optional(),
    decidedAt: ISO.optional(),
    decisionNote: z.string().min(1).max(280).optional(),
    grantId: GRANT_ID.optional(),
    reminderAt: ISO,
    expiresAt: ISO,
    createdAt: ISO,
  })
  .strict();
export type PolicyRequestRow = z.infer<typeof PolicyRequestRow>;

export const PolicyGrantRow = z
  .object({
    id: GRANT_ID,
    orgId: ORG_ID,
    scope: z.enum(["org", "user"]),
    userId: USER_ID.optional(),
    kind: z.enum(POLICY_GRANT_KINDS),
    subject: z.record(z.unknown()),
    subjectKey: z.string().min(1).max(300),
    expiresAt: ISO.optional(),
    requestId: REQUEST_ID,
    approvedBy: USER_ID,
    createdAt: ISO,
    revokedAt: ISO.optional(),
    revokedBy: USER_ID.optional(),
  })
  .strict()
  .refine((g) => (g.scope === "user") === (g.userId !== undefined), { message: "a user grant names its user; an org grant names none" });
export type PolicyGrantRow = z.infer<typeof PolicyGrantRow>;

export type PolicyRequestPatch = Partial<Pick<PolicyRequestRow, "status" | "decidedBy" | "decidedAt" | "decisionNote" | "grantId">>;

export interface GuardRequestStore {
  insertRequest(row: PolicyRequestRow): Promise<{ row: PolicyRequestRow; created: boolean }>;
  getRequest(id: string): Promise<PolicyRequestRow | undefined>;
  listRequests(orgId: string, filter: { status?: PolicyRequestStatus; kind?: PolicyRequestRowKind; requesterUserId?: string }): Promise<PolicyRequestRow[]>;
  updateRequest(id: string, expectStatus: PolicyRequestStatus, patch: PolicyRequestPatch): Promise<PolicyRequestRow | undefined>;

  insertGrant(row: PolicyGrantRow): Promise<void>;
  getGrant(id: string): Promise<PolicyGrantRow | undefined>;
  listGrants(orgId: string, filter: { userId?: string; includeRevoked?: boolean }): Promise<PolicyGrantRow[]>;
  revokeGrant(id: string, by: string, at: string): Promise<PolicyGrantRow | undefined>;
}

interface FileShape {
  requests: PolicyRequestRow[];
  grants: PolicyGrantRow[];
}

const clone = <T>(v: T): T => structuredClone(v);
const openKey = (r: Pick<PolicyRequestRow, "orgId" | "workspaceId" | "kind" | "subjectKey">) => `${r.orgId}|${r.workspaceId ?? ""}|${r.kind}|${r.subjectKey}`;
const newestFirst = (a: PolicyRequestRow, b: PolicyRequestRow) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0);

export const createFileGuardRequestStore = async (file: string): Promise<GuardRequestStore> => {
  let rest: Record<string, unknown> = {};
  const state: FileShape = { requests: [], grants: [] };
  try {
    const { requests, grants, ...others } = JSON.parse(await readFile(file, "utf8")) as Partial<FileShape> & Record<string, unknown>;
    rest = others;
    state.requests = requests ?? [];
    state.grants = grants ?? [];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  let chain: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ ...rest, requests: state.requests, grants: state.grants }, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return chain;
  };
  return {
    async insertRequest(row) {
      const parsed = PolicyRequestRow.parse(row);
      if (parsed.status === "pending") {
        const open = state.requests.find((r) => r.status === "pending" && openKey(r) === openKey(parsed));
        if (open) return { row: clone(open), created: false };
      }
      state.requests.push(parsed);
      await save();
      return { row: clone(parsed), created: true };
    },
    async getRequest(id) {
      const r = state.requests.find((x) => x.id === id);
      return r ? clone(r) : undefined;
    },
    async listRequests(orgId, filter) {
      return state.requests
        .filter(
          (r) =>
            r.orgId === orgId &&
            (filter.status === undefined || r.status === filter.status) &&
            (filter.kind === undefined || r.kind === filter.kind) &&
            (filter.requesterUserId === undefined || r.requesterUserId === filter.requesterUserId),
        )
        .sort(newestFirst)
        .map(clone);
    },
    async updateRequest(id, expectStatus, patch) {
      const i = state.requests.findIndex((r) => r.id === id);
      if (i < 0 || state.requests[i]!.status !== expectStatus) return undefined;
      const next: Record<string, unknown> = { ...state.requests[i]!, ...patch };
      for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
      state.requests[i] = PolicyRequestRow.parse(next);
      await save();
      return clone(state.requests[i]!);
    },
    async insertGrant(row) {
      state.grants.push(PolicyGrantRow.parse(row));
      await save();
    },
    async getGrant(id) {
      const g = state.grants.find((x) => x.id === id);
      return g ? clone(g) : undefined;
    },
    async listGrants(orgId, filter) {
      return state.grants
        .filter((g) => g.orgId === orgId && (filter.includeRevoked === true || g.revokedAt === undefined) && (filter.userId === undefined || g.scope === "org" || g.userId === filter.userId))
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map(clone);
    },
    async revokeGrant(id, by, at) {
      const g = state.grants.find((x) => x.id === id);
      if (!g || g.revokedAt !== undefined) return undefined;
      g.revokedAt = at;
      g.revokedBy = by;
      await save();
      return clone(g);
    },
  };
};
