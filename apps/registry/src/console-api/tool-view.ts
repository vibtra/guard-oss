import type { RegistryRecord } from "../records/ledger.js";
import type { ConsoleToolDeploy } from "@vibtra/console-api";

export interface LedgerDeploy extends ConsoleToolDeploy {
  connections: string[];
}

export const foldDeploysByTool = (records: readonly RegistryRecord[]): Map<string, LedgerDeploy[]> => {
  const byTool = new Map<string, LedgerDeploy[]>();
  for (const record of records) {
    if (record.type !== "tool.deployed") continue;
    const toolId = record.toolId;
    if (toolId === undefined) continue;
    const list = byTool.get(toolId) ?? [];
    list.push({
      outcome: record.outcome,
      ...(record.url === undefined ? {} : { url: record.url }),
      at: record.recordedAt,
      connections: record.connections ?? [],
      ...(record.target === undefined ? {} : { provider: record.target }),
    });
    byTool.set(toolId, list);
  }
  for (const record of records) {
    if (record.type !== "receipt.recorded") continue;
    const toolId = record.toolId;
    if (toolId === undefined) continue;
    const list = byTool.get(toolId);
    if (list === undefined) continue;
    let best: LedgerDeploy | undefined;
    for (const deploy of list) {
      if (record.recordedAt >= deploy.at && (best === undefined || deploy.at > best.at)) best = deploy;
    }
    if (best !== undefined && best.receiptId === undefined) best.receiptId = record.receiptId;
  }
  for (const [toolId, list] of byTool) {
    byTool.set(
      toolId,
      [...list].sort((a, b) => b.at.localeCompare(a.at)),
    );
  }
  return byTool;
};
