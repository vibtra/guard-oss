import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const PLAN_REQUEST_STATUSES = ["pending", "approved", "declined"] as const;

export const PlanChangeRequestRow = z.object({
  requestId: z.string().min(1),
  orgId: z.string().min(1),
  requesterEmail: z.string().min(1),
  currentPlan: z.string().min(1),
  wantedPlan: z.string().min(1),
  status: z.enum(PLAN_REQUEST_STATUSES),
  note: z.string().max(280).optional(),
  decidedBy: z.string().min(1).optional(),
  decisionNote: z.string().max(280).optional(),
  decidedAt: z.string().min(1).optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type PlanChangeRequestRow = z.infer<typeof PlanChangeRequestRow>;

export interface PlanChangeDecision {
  requestId: string;
  status: "approved" | "declined";
  decidedBy: string;
  decisionNote?: string | undefined;
  decidedAt: string;
}

export interface PlanRequestStore {
  latestForOrg(orgId: string): Promise<PlanChangeRequestRow | undefined>;
  createRequest(row: PlanChangeRequestRow): Promise<PlanChangeRequestRow | undefined>;

  listOpen(): Promise<PlanChangeRequestRow[]>;
  getRequest(requestId: string): Promise<PlanChangeRequestRow | undefined>;
  decideRequest(decision: PlanChangeDecision): Promise<PlanChangeRequestRow | undefined>;
}

const PlanRequestsFile = z.object({ planRequests: z.array(PlanChangeRequestRow).default([]) });

export const createFilePlanRequestStore = async (file: string): Promise<PlanRequestStore> => {
  let rows: PlanChangeRequestRow[] = [];
  try {
    rows = PlanRequestsFile.parse(JSON.parse(await readFile(file, "utf8"))).planRequests;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ planRequests: rows }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  return {
    async latestForOrg(orgId) {
      const found = rows
        .filter((r) => r.orgId === orgId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return found === undefined ? undefined : { ...found };
    },
    async createRequest(row) {
      const parsed = PlanChangeRequestRow.parse(row);
      if (rows.some((r) => r.orgId === parsed.orgId && r.status === "pending")) return undefined;
      rows.push(parsed);
      await persist();
      return { ...parsed };
    },
    async listOpen() {
      return rows
        .filter((r) => r.status === "pending")
        .map((r) => ({ ...r }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async getRequest(requestId) {
      const found = rows.find((r) => r.requestId === requestId);
      return found === undefined ? undefined : { ...found };
    },
    async decideRequest({ requestId, status, decidedBy, decisionNote, decidedAt }) {
      const row = rows.find((r) => r.requestId === requestId);
      if (row === undefined || row.status !== "pending") return undefined;
      row.status = status;
      row.decidedBy = decidedBy;
      if (decisionNote !== undefined && decisionNote !== "") row.decisionNote = decisionNote;
      row.decidedAt = decidedAt;
      row.updatedAt = decidedAt;
      await persist();
      return { ...row };
    },
  };
};
