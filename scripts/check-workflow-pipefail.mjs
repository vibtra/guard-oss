import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const PIPEFAIL_SET = /^set +(?:-[a-zA-Z]+ +)*-[a-zA-Z]*o +pipefail\b/;
const FIX =
  "A pipeline exits with its last command's code, so `a | b` passes when `a` fails unless pipefail is on. GitHub's default shell (bash -e {0}) and `shell: sh` have no pipefail; `shell: bash` runs bash with -eo pipefail. Fix: add `defaults: run: shell: bash` to the workflow or the job, or `shell: bash` to the step, or make `set -euo pipefail` the script's first line. If the step means to ignore a failure left of a pipe, write that out, for example `{ a || true; } | b`.";

const yamlIn = (dir, recursive) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive, withFileTypes: true })
        .filter((entry) => !entry.isDirectory() && /\.ya?ml$/.test(entry.name))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    : [];

const listOf = (value) => (Array.isArray(value) ? value : []);
const shellOf = (owner) => owner?.defaults?.run?.shell;

const runSteps = (file, doc) => {
  if (!file.startsWith(path.join(".github", "workflows") + path.sep)) {
    return listOf(doc?.runs?.steps).map((step, index) => ({ where: `runs.steps[${index}]`, step, shell: step?.shell }));
  }
  return Object.entries(doc?.jobs ?? {}).flatMap(([id, job]) =>
    listOf(job?.steps).map((step, index) => ({ where: `jobs.${id}.steps[${index}]`, step, shell: step?.shell ?? shellOf(job) ?? shellOf(doc) })),
  );
};

const firstPipe = (lines) =>
  lines.find((line) => !line.trimStart().startsWith("#") && line.replace(/\$\{\{.*?\}\}/g, "").replace(/\|\|/g, "").includes("|"));

const findingsIn = (file) => {
  let doc;
  try {
    doc = load(readFileSync(path.join(root, file), "utf8"));
  } catch (error) {
    return [`${file}: cannot be read as YAML, so its run steps cannot be checked: ${error.reason ?? error.message}`];
  }
  return runSteps(file, doc).flatMap(({ where, step, shell }) => {
    if (step?.run === undefined || step.run === null || shell === "bash") return [];
    const lines = String(step.run).split("\n");
    const pipe = firstPipe(lines);
    if (pipe === undefined) return [];
    const first = lines.find((line) => line.trim() !== "" && !line.trimStart().startsWith("#"));
    if (PIPEFAIL_SET.test(first?.trim() ?? "")) return [];
    const name = JSON.stringify(step.name ?? step.id ?? "unnamed");
    return [`${file}: ${where} ${name} pipes under ${shell === undefined ? "GitHub's default shell, bash -e {0}," : `shell: ${shell},`} which has no pipefail: ${pipe.trim()}`];
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
