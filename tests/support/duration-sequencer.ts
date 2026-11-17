import { readFileSync } from "node:fs";
import path from "node:path";
import { BaseSequencer, type WorkspaceSpec } from "vitest/node";
import { partition } from "./shard-partition.ts";

const DURATIONS_FILE = path.join(import.meta.dirname, "..", "test-durations.json");

const readDurations = (): Record<string, number> => {
  const parsed: unknown = JSON.parse(readFileSync(DURATIONS_FILE, "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`${DURATIONS_FILE} is not a JSON object`);
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
};

export default class DurationSequencer extends BaseSequencer {
  override async shard(files: WorkspaceSpec[]): Promise<WorkspaceSpec[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const root = this.ctx.config.root;
    const key = (spec: WorkspaceSpec) => path.relative(root, spec.moduleId).split(path.sep).join("/");
    const mine = new Set(partition(files.map(key), readDurations(), shard.count)[shard.index - 1]);
    return files.filter((spec) => mine.has(key(spec)));
  }
}
