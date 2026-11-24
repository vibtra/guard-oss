import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const ACTION = path.join(ROOT, ".github/actions/pr-base/action.yml");

export const PR_BASE_STEP = /^ {6}- name: .+\n {8}id: base\n {8}uses: \.\/\.github\/actions\/pr-base\n/m;

export const render = (value: string, contexts: Record<string, unknown>) =>
  value.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, expression: string) => {
    let current: unknown = contexts;
    for (const key of expression.split(".")) current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    return current === undefined || current === null ? "" : String(current);
  });

const section = (lines: string[], header: string) => {
  const at = lines.indexOf(header);
  if (at === -1) return [];
  const indent = header.length - header.trimStart().length;
  const end = lines.findIndex((line, index) => index > at && line.trim() !== "" && line.length - line.trimStart().length <= indent);
  return lines.slice(at + 1, end === -1 ? lines.length : end);
};

const entries = (lines: string[], indent: number) => {
  const pattern = new RegExp(`^ {${indent}}([\\w-]+): (.+)$`);
  const found: Record<string, string> = {};
  for (const line of lines) {
    const [, key, value] = line.match(pattern) ?? [];
    if (key !== undefined && value !== undefined) found[key] = value;
  }
  return found;
};

const fields = (lines: string[], key: string) => {
  const names = lines.flatMap((line) => line.match(/^ {2}([\w-]+):$/)?.slice(1) ?? []);
  return Object.fromEntries(names.map((name) => [name, entries(section(lines, `  ${name}:`), 4)[key] ?? ""]));
};

const action = () => {
  const lines = readFileSync(ACTION, "utf8").split("\n");
  const step = section(lines, "  steps:");
  if (step.filter((line) => line.startsWith("    - name: ")).length !== 1) throw new Error("the pr-base action must have exactly one step");
  const run = step.indexOf("      run: |");
  return {
    inputs: fields(section(lines, "inputs:"), "default"),
    outputs: fields(section(lines, "outputs:"), "value"),
    id: entries(step, 6).id ?? "",
    workingDirectory: entries(step, 6)["working-directory"] ?? ".",
    env: entries(section(step, "      env:"), 8),
    script: step
      .slice(run + 1)
      .filter((line) => line.startsWith("        ") || line.trim() === "")
      .map((line) => line.slice(8))
      .join("\n"),
  };
};

export type ActionRun = { code: number | null; stdout: string; stderr: string; outputs: Record<string, string> };

export const runBash = (script: string, env: Record<string, string>, cwd: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

export const runPrBaseAction = async (contexts: Record<string, unknown>, env: Record<string, string>, cwd: string, temp: string): Promise<ActionRun> => {
  const parsed = action();
  const scope = { ...contexts, inputs: parsed.inputs };
  const outputFile = path.join(temp, "pr-base-output");
  writeFileSync(outputFile, "");
  const stepEnv = Object.fromEntries(Object.entries(parsed.env).map(([key, value]) => [key, render(value, scope)]));
  const result = await runBash(parsed.script, { ...env, ...stepEnv, GITHUB_OUTPUT: outputFile }, path.join(cwd, render(parsed.workingDirectory, scope)));
  const written = Object.fromEntries(
    readFileSync(outputFile, "utf8")
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  const outputs = Object.fromEntries(Object.entries(parsed.outputs).map(([name, value]) => [name, render(value, { steps: { [parsed.id]: { outputs: written } } })]));
  return { ...result, outputs };
};
