import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const KEY = /^( *)(- +)?([\w-]+):(?: +(.*?))? *$/;
const BLOCK = /^[|>][-+0-9]*(?: +#.*)?$/;
const PIPEFAIL_SET = /^set +(?:-[a-zA-Z]+ +)*-[a-zA-Z]*o +pipefail\b/;
const FIX =
  "A pipeline exits with its last command's code, so `a | b` passes when `a` fails unless pipefail is on. GitHub's default shell (bash -e {0}) and `shell: sh` have no pipefail; `shell: bash` runs bash with -eo pipefail. Fix: add `defaults: run: shell: bash` to the workflow or the job, or `shell: bash` to the step, or make `set -euo pipefail` the script's first line. If the step means to ignore a failure left of a pipe, write that out, for example `{ a || true; } | b`.";

const yamlIn = (dir, recursive) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive, withFileTypes: true })
        .filter((entry) => !entry.isDirectory() && /\.ya?ml$/.test(entry.name))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    : [];

const parse = (text) => {
  const lines = text.split("\n").map((raw) => {
    const indent = raw.length - raw.trimStart().length;
    const skip = raw.trim() === "" || raw.trimStart().startsWith("#");
    const [, spaces = "", dash = "", key, value = ""] = (skip ? null : raw.match(KEY)) ?? [];
    return { raw, indent, skip, key, value, dash: dash !== "", col: key === undefined ? indent : spaces.length + dash.length };
  });
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.key === undefined || !BLOCK.test(line.value)) continue;
    line.body = [];
    for (let j = i + 1; j < lines.length && (lines[j].raw.trim() === "" || lines[j].indent > line.col); j++) {
      Object.assign(lines[j], { skip: true, key: undefined });
      line.body.push(lines[j].raw);
    }
  }
  return lines;
};

const childrenEnd = (lines, at) => {
  let end = at + 1;
  while (end < lines.length && (lines[end].skip || lines[end].indent > lines[at].col)) end++;
  return end;
};

const child = (lines, at, key) => {
  const end = childrenEnd(lines, at);
  const first = lines.slice(at + 1, end).find((line) => !line.skip);
  const found = lines.findIndex((line, index) => index > at && index < end && line.key === key && line.col === first?.col);
  return found === -1 ? undefined : found;
};

const scalar = (value) => value.replace(/ +#.*$/, "").replace(/^(['"])(.*)\1$/, "$2");

const defaultShell = (lines, start, end, col) => {
  const defaults = lines.findIndex((line, index) => index >= start && index < end && line.key === "defaults" && line.col === col && !line.dash);
  if (defaults === -1) return undefined;
  const run = child(lines, defaults, "run");
  const shell = run === undefined ? undefined : child(lines, run, "shell");
  return shell === undefined ? undefined : scalar(lines[shell].value);
};

const mappingAround = (lines, at) => {
  const { col } = lines[at];
  let start = at;
  while (start > 0 && !lines[start].dash) {
    const above = lines[start - 1];
    if (!above.skip && above.indent <= col && above.col !== col) break;
    start--;
  }
  let end = at + 1;
  while (end < lines.length && (lines[end].skip || lines[end].indent > col || (lines[end].indent === col && !lines[end].dash))) end++;
  return { start, end };
};

const firstPipe = (script) =>
  script.split("\n").findIndex((line) => !line.trimStart().startsWith("#") && line.replace(/\$\{\{.*?\}\}/g, "").replace(/\|\|/g, "").includes("|"));

const findingsIn = (file) => {
  const lines = parse(readFileSync(path.join(root, file), "utf8"));
  const isWorkflow = file.startsWith(path.join(".github", "workflows") + path.sep);
  const workflowShell = isWorkflow ? defaultShell(lines, 0, lines.length, 0) : undefined;
  return lines.flatMap((line, at) => {
    if (line.key !== "run" || line.value === "") return [];
    const script = line.body === undefined ? scalar(line.value) : line.body.join("\n");
    const pipe = firstPipe(script);
    if (pipe === -1) return [];
    const scriptLines = script.split("\n").filter((text) => text.trim() !== "" && !text.trimStart().startsWith("#"));
    if (PIPEFAIL_SET.test(scriptLines[0]?.trim() ?? "")) return [];
    const step = mappingAround(lines, at);
    const keyIn = (key) => lines.findIndex((other, index) => index >= step.start && index < step.end && other.key === key && other.col === line.col);
    const stepShell = keyIn("shell") === -1 ? undefined : scalar(lines[keyIn("shell")].value);
    const stepsKey = lines.findLastIndex((other, index) => index < step.start && !other.skip && other.col < line.col);
    const job = isWorkflow && lines[stepsKey]?.key === "steps" ? mappingAround(lines, stepsKey) : undefined;
    const jobShell = job === undefined ? undefined : defaultShell(lines, job.start, job.end, lines[stepsKey].col);
    const shell = stepShell ?? jobShell ?? workflowShell;
    if (shell === "bash") return [];
    const name = keyIn("name") === -1 ? "unnamed" : JSON.stringify(scalar(lines[keyIn("name")].value));
    return [`${file}:${at + 1 + (line.body === undefined ? 0 : pipe + 1)}: step ${name} pipes under ${shell === undefined ? "GitHub's default shell, bash -e {0}," : `shell: ${shell},`} which has no pipefail: ${script.split("\n")[pipe].trim()}`];
  });
};

const files = [...yamlIn(path.join(root, ".github", "workflows"), false), ...yamlIn(path.join(root, ".github", "actions"), true)].sort();
const findings = files.flatMap(findingsIn);
for (const finding of findings) console.error(`workflow-pipefail: ${finding}`);
if (findings.length > 0) {
  console.error(`  ${FIX}`);
  process.exit(1);
}
console.log(`workflow-pipefail: every run step that pipes in the ${files.length} workflow and action files runs with pipefail`);
