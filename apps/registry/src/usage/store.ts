import { readFile, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const UsageSnapshotRow = z.object({
  orgId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a snapshot's day is an ISO date, UTC"),
  seats: z.number().int().min(0),
  connections: z.number().int().min(0),
  liveTools: z.number().int().min(0),
  deploys: z.number().int().min(0),
});
export type UsageSnapshotRow = z.infer<typeof UsageSnapshotRow>;

export interface UsageStore {
  putSnapshot(row: UsageSnapshotRow): Promise<boolean>;
  listSnapshots(orgId: string, limit: number): Promise<UsageSnapshotRow[]>;
}

const UsageFile = z.object({ snapshots: z.array(UsageSnapshotRow).default([]) });

export const createFileUsageStore = async (file: string): Promise<UsageStore> => {
  let snapshots: UsageSnapshotRow[] = [];
  try {
    snapshots = UsageFile.parse(JSON.parse(await readFile(file, "utf8"))).snapshots;
  } catch {
  }

  let writeChain: Promise<void> = Promise.resolve();
  const persist = (): Promise<void> => {
    writeChain = writeChain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ snapshots }, null, 2)}\n`, "utf8");
      await rename(tmp, file);
    });
    return writeChain;
  };

  return {
    async putSnapshot(row) {
      const parsed = UsageSnapshotRow.parse(row);
      if (snapshots.some((s) => s.orgId === parsed.orgId && s.day === parsed.day)) return false;
      snapshots.push(parsed);
      await persist();
      return true;
    },
    async listSnapshots(orgId, limit) {
      return snapshots
        .filter((s) => s.orgId === orgId)
        .sort((a, b) => b.day.localeCompare(a.day))
        .slice(0, Math.max(0, limit))
        .map((s) => ({ ...s }));
    },
  };
};
