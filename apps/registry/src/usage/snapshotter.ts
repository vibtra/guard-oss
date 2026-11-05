import { foldDeploysByTool } from "../console-api/tool-view.js";
import type { RegistryService } from "../service.js";
import type { UsageSnapshotRow } from "./store.js";

export const USAGE_SNAPSHOT_INTERVAL_MS = 60 * 60_000;

export const USAGE_HISTORY_DAYS = 30;

export interface UsageSnapshotCounts {
  written: number;
  alreadyToday: number;
  failed: number;
}

export interface UsageSnapshotterOptions {
  service: RegistryService;
  intervalMs?: number | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface UsageSnapshotter {
  tick(): Promise<UsageSnapshotCounts>;
  stop(): void;
}

export const utcDayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

export const usageOf = async (
  service: RegistryService,
  orgId: string,
): Promise<Omit<UsageSnapshotRow, "orgId" | "day">> => {
  const tenancy = service.tenancy;
  const vault = service.vault;
  const tools = service.tools;
  const records = await service.records.list({ orgId });
  const deployed = foldDeploysByTool(records);
  const toolRows = tools === undefined ? [] : await tools.listTools(orgId);
  return {
    seats: tenancy === undefined ? 0 : await tenancy.countUsers(orgId),
    connections: vault === undefined ? 0 : await vault.countConnections(orgId),
    liveTools: toolRows.filter((row) => deployed.get(row.toolId)?.[0]?.outcome === "LIVE").length,
    deploys: records.filter((record) => record.type === "tool.deployed").length,
  };
};

export const createUsageSnapshotter = (options: UsageSnapshotterOptions): UsageSnapshotter => {
  const now = options.now ?? (() => Date.now());

  const tick = async (): Promise<UsageSnapshotCounts> => {
    const counts: UsageSnapshotCounts = { written: 0, alreadyToday: 0, failed: 0 };
    const store = options.service.usage;
    const tenancy = options.service.tenancy;
    if (store === undefined || tenancy === undefined) return counts;

    const day = utcDayOf(now());
    for (const org of await tenancy.listOrgs()) {
      try {
        const written = await store.putSnapshot({ orgId: org.orgId, day, ...(await usageOf(options.service, org.orgId)) });
        if (written) counts.written += 1;
        else counts.alreadyToday += 1;
      } catch {
        counts.failed += 1;
      }
    }
    return counts;
  };

  return {
    async tick() {
      return tick();
    },
    stop() {
    },
  };
};

export const startUsageSnapshotter = (
  options: UsageSnapshotterOptions,
): { stop: () => void } | undefined => {
  if (options.service.usage === undefined || options.service.tenancy === undefined) return undefined;
  const snapshotter = createUsageSnapshotter(options);
  const intervalMs = options.intervalMs ?? USAGE_SNAPSHOT_INTERVAL_MS;
  const timer = setInterval(() => {
    void snapshotter.tick().then(
      (counts) => {
        if (counts.written + counts.failed === 0) return;
        options.log?.(
          `[usage] daily snapshot: ${counts.written} written, ${counts.alreadyToday} already had today's row, ` +
            `${counts.failed} deferred`,
        );
      },
      (err: unknown) => {
        options.log?.(`[usage] the daily snapshot could not run: ${err instanceof Error ? err.name : "failed"}`);
      },
    );
  }, intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      snapshotter.stop();
    },
  };
};
