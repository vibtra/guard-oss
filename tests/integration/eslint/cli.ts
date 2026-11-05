import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const COMMENTS_CONFIG = "tools/eslint/comments.config.mjs";
export const FENCES_CONFIG = "tools/eslint/fences.config.mjs";
export const ESLINT_TIMEOUT = { timeout: 300_000 };
const bin = path.join(root, "tools/eslint/node_modules/eslint/bin/eslint.js");
const NO_INLINE_CONFIG = /^'.*' has no effect because you have 'noInlineConfig' setting in your config\.$/s;

export type Message = { ruleId: string | null; severity: number; message: string; line: number; column: number; endLine?: number; endColumn?: number; fatal?: boolean };
export type Result = { filePath: string; messages: Message[]; output?: string };

export const lines = (...rows: string[]) => `${rows.join("\n")}\n`;

export const run = (args: string[], input = "") =>
  new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { cwd: root });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 || code === 1 ? resolve(stdout) : reject(new Error(`eslint ${args.join(" ")} exited ${code}: ${stderr}`))));
    child.stdin.end(input);
  });

export const lintFiles = async (args: string[]) => JSON.parse(await run(["--format", "json", ...args])) as Result[];

export const lintText = async (code: string, file: string, { config, fix = false }: { config?: string; fix?: boolean } = {}) => {
  const args = [...(config === undefined ? [] : ["--config", config]), ...(fix ? ["--fix-dry-run"] : []), "--format", "json", "--stdin", "--stdin-filename", file];
  const [result] = JSON.parse(await run(args, code)) as Result[];
  if (result === undefined) throw new Error(`eslint gave no result for ${file}`);
  return result;
};

export const ignoredDirective = (message: Message) => message.ruleId === null && message.severity === 1 && NO_INLINE_CONFIG.test(message.message);
