import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    root: { type: "string", default: path.join(path.dirname(fileURLToPath(import.meta.url)), "..") },
    base: { type: "string", default: "ed39aa6" },
    only: { type: "string" },
  },
});
const root = path.resolve(values.root);
const agent = path.join(root, "guard", "agent-go");
const engineDir = path.join(agent, "engine");
const NOT_BUILT = "not built yet";
const MINUTES = 60_000;
const SPREAD_LIMIT = 0.35;
const BENCH_RUNS = 5;
const LIMIT_TEXT = `${Math.round(SPREAD_LIMIT * 100)}%`;
const ALLOWED_TEST_ADDS = [
  /^tests\/integration\/agent-go\/engine\.test\.ts$/,
  /^tests\/integration\/agent-go\/engine-swap\.test\.ts$/,
  /^tests\/fixtures\/engines\//,
  /^tests\/integration\/scripts\/engine-(done|agent-grade)[\w.-]*\.ts$/,
];
const temps = [];

const temp = (label) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `engine-done-${label}-`));
  temps.push(dir);
  return dir;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 10 * MINUTES, ...options, env: { ...process.env, ...options.env } });
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { code: result.error ? null : result.status, out: result.error ? `${result.error.message}\n${out}` : out };
};

const tail = (text, lines = 8) => text.trim().split("\n").slice(-lines).join("\n");

const modulePath = () => {
  const match = /^module\s+(\S+)/m.exec(readFileSync(path.join(agent, "go.mod"), "utf8"));
  if (!match) throw new Error("guard/agent-go/go.mod has no module line");
  return match[1];
};

const goFiles = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go"))
    .map((entry) => path.join(entry.parentPath, entry.name));

const requireBuilt = (...targets) => {
  const missing = targets.filter((target) => !existsSync(path.join(root, target)));
  if (missing.length > 0) throw new Error(`${NOT_BUILT}: missing ${missing.join(", ")}`);
};

const copyTree = (label) => {
  const top = temp(label);
  for (const name of [".golangci.yml", ".golangci.yaml"]) {
    if (existsSync(path.join(root, name))) cpSync(path.join(root, name), path.join(top, name));
  }
  const copy = path.join(top, "guard", "agent-go");
  cpSync(agent, copy, { recursive: true });
  return copy;
};

const packageName = (dir) => {
  for (const file of goFiles(dir).filter((file) => path.dirname(file) === dir)) {
    const match = /^package\s+(\w+)/m.exec(readFileSync(file, "utf8"));
    if (match) return match[1];
  }
  throw new Error(`${path.relative(root, dir)} has no Go package`);
};

const swapEngine = (copy, engine) => {
  const file = path.join(copy, "main.go");
  const module = modulePath();
  const rulesImport = new RegExp(`^(\\s*)(?:[\\w.]+\\s+)?"${module.replaceAll(".", "\\.")}/engine/rules"\\s*$`, "m");
  let source = readFileSync(file, "utf8");
  if (!rulesImport.test(source)) throw new Error("main.go does not import engine/rules");
  if (source.split("rules.New()").length !== 2) throw new Error("main.go does not call rules.New() exactly once");
  packageName(path.join(copy, "engine", engine));
  source = source.replace("rules.New()", "swapped.New()").replace(rulesImport, (line, indent) => `${line}\n${indent}swapped "${module}/engine/${engine}"`);
  if (!/\brules\./.test(source)) source = source.replace(rulesImport, (_line, indent) => `${indent}_ "${module}/engine/rules"`);
  writeFileSync(file, source);
};

const builds = new Map();

const buildEngine = (engine) => {
  if (builds.has(engine)) return builds.get(engine);
  const build = (() => {
    const copy = copyTree(`build-${engine}`);
    if (engine !== "rules") {
      const fixture = path.join(root, "tests", "fixtures", "engines", engine);
      if (!existsSync(path.join(copy, "engine", engine))) {
        if (!existsSync(fixture)) return { error: `${NOT_BUILT}: neither guard/agent-go/engine/${engine} nor tests/fixtures/engines/${engine} exists` };
        cpSync(fixture, path.join(copy, "engine", engine), { recursive: true });
      }
      try {
        swapEngine(copy, engine);
      } catch (error) {
        return { error: `cannot swap in ${engine}: ${error.message}` };
      }
    }
    const bin = path.join(path.dirname(path.dirname(copy)), "vibtra-guard");
    const result = run("go", ["build", "-mod=readonly", "-o", bin, "."], { cwd: copy });
    if (result.code !== 0) return { error: `go build with engine ${engine} failed:\n${tail(result.out)}` };
    return { bin, home: temp(`home-${engine}`) };
  })();
  builds.set(engine, build);
  return build;
};

const agentRun = (build, args) => run(build.bin, args, { env: { VIBTRA_GUARD_DIR: build.home } });

const swiftSide = (file) => file.startsWith("guard/mac/") || file.startsWith("tests/mac/") || /\.swift$/i.test(file) || /(^|\/)[^/]+\.xcodeproj(\/|$)/i.test(file) || path.posix.basename(file) === "project.yml";

const noSwift = () => {
  const mergeBase = run("git", ["-C", root, "merge-base", "origin/main", "HEAD"]);
  if (mergeBase.code !== 0) throw new Error(`git merge-base origin/main HEAD failed. Fetch origin/main with full history:\n${tail(mergeBase.out)}`);
  const from = mergeBase.out.trim();
  const diff = run("git", ["-C", root, "diff", "--no-renames", "--name-only", `${from}..HEAD`]);
  if (diff.code !== 0) throw new Error(`git diff failed:\n${tail(diff.out)}`);
  const names = diff.out.split("\n").filter(Boolean);
  const listing = [`changed since merge-base ${from} (${names.length}):`, ...names.map((name) => `  ${name}`)].join("\n");
  const hits = names.filter(swiftSide);
  if (hits.length > 0) throw new Error(`${hits.length} path(s) under guard/mac/ or tests/mac/, or a .swift, .xcodeproj or project.yml file:\n${hits.map((name) => `  ${name}`).join("\n")}\n${listing}`);
  return `no Swift or Mac path changed\n${listing}`;
};

const noBehaviourChange = () => {
  if (run("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${values.base}^{commit}`]).code !== 0) {
    throw new Error(`base commit ${values.base} is not in this clone. Fetch the full history (actions/checkout fetch-depth: 0)`);
  }
  const diff = run("git", ["-C", root, "diff", "--no-renames", "--name-status", `${values.base}..HEAD`, "--", "tests/"]);
  if (diff.code !== 0) throw new Error(`git diff failed:\n${tail(diff.out)}`);
  const bad = diff.out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"))
    .filter(([status, file]) => status !== "A" || !ALLOWED_TEST_ADDS.some((pattern) => pattern.test(file)))
    .map(([status, file]) => `${status} ${file}`);
  if (bad.length > 0) throw new Error(`test files changed since ${values.base} (only the engine tests and tests/fixtures/engines/** may be added):\n${bad.join("\n")}`);
  return `no test file modified or deleted since ${values.base}`;
};

const boundaryGrep = () => {
  requireBuilt("guard/agent-go/engine/rules");
  const target = `${modulePath()}/engine/rules`;
  const importsRules = new RegExp(`"${target.replaceAll(".", "\\.")}(/[^"]*)?"`);
  const offenders = goFiles(agent)
    .filter((file) => importsRules.test(readFileSync(file, "utf8")))
    .map((file) => path.relative(agent, file).split(path.sep).join("/"))
    .filter((file) => file !== "main.go" && !file.startsWith("engine/"))
    .sort();
  if (offenders.length > 0) throw new Error(`only main.go and files under engine/ may import ${target}:\n${offenders.join("\n")}`);
  return `only main.go and engine/** import ${target}`;
};

const plantedViolation = () => {
  requireBuilt("guard/agent-go/engine/rules");
  if (run("golangci-lint", ["--version"]).code !== 0) throw new Error("golangci-lint is not on PATH");
  const copy = copyTree("lint");
  writeFileSync(path.join(copy, "proxy_violation.go"), `package main\n\nimport _ "${modulePath()}/engine/rules"\n`);
  const lint = run("golangci-lint", ["run", "./..."], { cwd: copy });
  if (lint.code === 0) throw new Error("golangci-lint passed a proxy file that imports engine/rules");
  const flagged = lint.out.split("\n").filter((line) => line.includes("proxy_violation.go") && line.includes("depguard"));
  if (flagged.length === 0) throw new Error(`golangci-lint failed, but not with a depguard finding on proxy_violation.go:\n${tail(lint.out)}`);
  return `lint rejects the planted import: ${flagged[0].trim()}`;
};

const conformance = () => {
  requireBuilt("guard/agent-go/engine/rules");
  const cases = [
    { engine: "rules", args: ["engine", "check", "--parity"], expected: 0 },
    { engine: "example", args: ["engine", "check"], expected: 0 },
    { engine: "blocks-in-monitor", args: ["engine", "check"], expected: 1 },
    { engine: "body-in-event", args: ["engine", "check"], expected: 1 },
  ];
  const failures = [];
  for (const { engine, args, expected } of cases) {
    const build = buildEngine(engine);
    if (build.error) {
      failures.push(`${engine}: ${build.error}`);
      continue;
    }
    const result = agentRun(build, args);
    if (result.code !== expected) failures.push(`${engine}: \`${args.join(" ")}\` exited ${result.code}, expected ${expected}\n${tail(result.out)}`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return "rules --parity and example pass; blocks-in-monitor and body-in-event are rejected";
};

const median = (numbers) => {
  const sorted = [...numbers].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const benchSets = (out) => {
  const sets = new Map();
  for (const line of out.split("\n")) {
    const match = /^\s*(\S+)\s.*?([\d.]+)\s*ns\/op/.exec(line);
    if (match) sets.set(match[1], Number(match[2]));
  }
  return sets;
};

const benchSpread = () => {
  requireBuilt("guard/agent-go/engine/rules");
  const build = buildEngine("rules");
  if (build.error) throw new Error(build.error);
  const runs = [];
  for (let i = 0; i < BENCH_RUNS; i++) {
    const result = agentRun(build, ["engine", "bench"]);
    if (result.code !== 0) throw new Error(`\`engine bench\` exited ${result.code}:\n${tail(result.out)}`);
    const sets = benchSets(result.out);
    if (sets.size === 0) throw new Error(`\`engine bench\` printed no ns/op lines:\n${tail(result.out)}`);
    runs.push(sets);
  }
  const names = [...runs[0].keys()];
  const report = [];
  const failures = [];
  for (const name of names) {
    const samples = runs.map((sets) => sets.get(name));
    if (samples.some((value) => value === undefined)) {
      failures.push(`${name}: missing from some runs`);
      continue;
    }
    const spread = (median(samples) - Math.min(...samples)) / Math.min(...samples);
    report.push(`${name} ${(spread * 100).toFixed(1)}%`);
    if (!(spread <= SPREAD_LIMIT)) failures.push(`${name}: (median - min) / min is ${(spread * 100).toFixed(1)}%, over ${LIMIT_TEXT} (${samples.join(", ")} ns/op)`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return report.join(", ");
};

const engineName = () => {
  requireBuilt("guard/agent-go/engine/rules", "guard/agent-go/engine/example");
  const failures = [];
  for (const [engine, other] of [
    ["example", "rules"],
    ["rules", "example"],
  ]) {
    const build = buildEngine(engine);
    if (build.error) {
      failures.push(build.error);
      continue;
    }
    for (const args of [["status", "--local", "127.0.0.1:9"], ["--version"]]) {
      const result = agentRun(build, args);
      const says = (name) => new RegExp(`engine"?\\s*:\\s*"?${name}\\b`).test(result.out);
      if (result.code !== 0 || !says(engine) || says(other)) failures.push(`\`${args[0]}\` with engine ${engine} (exit ${result.code}) does not print "engine: ${engine}":\n${tail(result.out)}`);
    }
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return "status and --version print engine: example, then engine: rules";
};

const COMMAND_TAGS = new Set(["", "bash", "shell", "zsh", "console", "shell-session"]);

const fences = (markdown) => {
  const blocks = [];
  let open;
  for (const line of markdown.split("\n").map((raw) => raw.replace(/^(?:[ \t]*>[ \t]?)+/, ""))) {
    if (open === undefined) {
      const start = /^([ \t]*)(`{3,}|~{3,})(.*)$/.exec(line);
      if (start && !(start[2][0] === "`" && start[3].includes("`"))) open = { indent: start[1].length, fence: start[2], tag: start[3].trim().split(/\s+/)[0], body: [] };
      continue;
    }
    const close = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
    if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) {
      blocks.push({ tag: open.tag, body: open.body.join("\n") + "\n" });
      open = undefined;
      continue;
    }
    open.body.push(line.slice(Math.min(open.indent, /^[ \t]*/.exec(line)[0].length)));
  }
  if (open !== undefined) blocks.push({ tag: open.tag, body: open.body.join("\n") + "\n" });
  return blocks;
};

const contributingSection = (markdown) => {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => /^#{1,6}\s.*\bengines?\b/i.test(line));
  if (start === -1) return undefined;
  const level = /^#+/.exec(lines[start])[0].length;
  const end = lines.findIndex((line, index) => index > start && /^#+\s/.test(line) && /^#+/.exec(line)[0].length <= level);
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
};

const docs = () => {
  const sources = [
    ["guard/agent-go/engine/README.md", (text) => text],
    ["CONTRIBUTING.md (engine section)", contributingSection, "CONTRIBUTING.md"],
    ["AGENTS.md", (text) => text],
  ];
  const blocks = [];
  const failures = [];
  for (const [label, pick, file = label] of sources) {
    const full = path.join(root, file);
    if (!existsSync(full)) {
      failures.push(`${file}: ${NOT_BUILT}, the file does not exist`);
      continue;
    }
    const text = pick(readFileSync(full, "utf8"));
    if (text === undefined) {
      failures.push(`${label}: ${NOT_BUILT}, no heading that names the engine`);
      continue;
    }
    const found = fences(text);
    const untagged = found.filter((block) => COMMAND_TAGS.has(block.tag));
    if (untagged.length > 0) failures.push(`${label}: ${untagged.length} code block(s) tagged "${untagged[0].tag}". Use sh for commands and text for everything else`);
    const commands = found.filter((block) => block.tag === "sh");
    if (commands.length === 0) failures.push(`${label}: no sh code block`);
    blocks.push(...commands.map((block) => ({ label, body: block.body })));
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  const clone = path.join(temp("docs"), "repo");
  const cloned = run("git", ["clone", "--quiet", "--local", root, clone]);
  if (cloned.code !== 0) throw new Error(`git clone failed:\n${tail(cloned.out)}`);
  for (const { label, body } of blocks) {
    const result = run("sh", ["-e", "-c", body], { cwd: clone });
    if (result.code !== 0) failures.push(`${label}: this sh block exited ${result.code} when run from the clone root:\n${body.trim()}\n${tail(result.out)}`);
  }
  if (failures.length > 0) throw new Error(failures.join("\n"));
  return `${blocks.length} sh block(s) ran in a temp clone`;
};

const steps = [
  ["no-swift", "no Swift or Mac file changed since the merge-base with origin/main", noSwift],
  ["1", "no behaviour change (suites green via needs; no test file modified or deleted)", noBehaviourChange],
  ["2a", "boundary grep: only main.go and engine/** import engine/rules", boundaryGrep],
  ["2b", "planted violation: golangci-lint must fail with depguard (expected failure)", plantedViolation],
  ["3", "engine check on rules, example and the two bad fixture engines", conformance],
  ["4", `engine bench on rules: (median - min) / min within ${LIMIT_TEXT} over ${BENCH_RUNS} runs`, benchSpread],
  ["5", "status and --version name the engine", engineName],
  ["7", "every sh block in the engine docs runs", docs],
];

const selected = values.only === undefined ? steps : steps.filter(([id]) => id === values.only);
if (selected.length === 0) {
  console.error(`engine-done: unknown step "${values.only}". Steps: ${steps.map(([id]) => id).join(", ")}`);
  process.exit(2);
}
let failed = 0;
try {
  for (const [id, name, step] of selected) {
    try {
      console.log(`PASS ${id} ${name}: ${step()}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${id} ${name}: ${error.message}`);
    }
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "engine-done: every step passed" : `engine-done: ${failed} of ${selected.length} steps failed`);
process.exit(failed === 0 ? 0 : 1);
