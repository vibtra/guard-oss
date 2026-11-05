import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export type CliResult = { status: number | null; stdout: string; stderr: string };

export const runScript = (script: string, args: string[], nodeOptions: string[] = []): CliResult => {
  const result = spawnSync(process.execPath, [...nodeOptions, path.join(repoRoot, "scripts", script), ...args], { cwd: repoRoot, encoding: "utf8", timeout: 50_000 });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

export const absentBridge = (): string => {
  const interfaces = os.networkInterfaces();
  let n = 4242;
  while (`bridge${n}` in interfaces) n += 1;
  return `bridge${n}`;
};
