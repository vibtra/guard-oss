import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const ZERO = "0000000000000000000000000000000000000000";
const WATCHED = [
  "stryker.config.json",
  "tests/vitest.mutation.config.ts",
  "tests/mutation/survivors.json",
  "scripts/check-mutation-survivors.mjs",
  "scripts/require-mutation-database.mjs",
  "scripts/mutation-paths.mjs",
  "package.json",
  "pnpm-lock.yaml",
  ".github/workflows/ci.yml",
  "packages/guard-contract/src/bundle.ts",
  "apps/registry/src/errors.ts",
];
const WATCHED_PREFIXES = ["tests/contracts/", "tests/fixtures/race-mutant/", "tests/fixtures/sealer-mutant/"];
const HELPER_DIRS = ["tests/integration/registry/", "tests/integration/guard-contract/"];

const { values: options } = parseArgs({ options: { event: { type: "string" }, base: { type: "string" }, head: { type: "string" }, repo: { type: "string" } } });
const repo = path.resolve(options.repo ?? process.cwd());

const decide = (run, why) => {
  console.log(`run=${run}: ${why}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Mutation tests: run=${run}\n\n${why}\n`);
  process.exit(0);
};

const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

const watchedPaths = () => {
  const config = JSON.parse(readFileSync(path.join(repo, "stryker.config.json"), "utf8"));
  const mutated = config.mutate.map((entry) => entry.replace(/:\d+(-\d+)?$/, ""));
  const mutationConfig = readFileSync(path.join(repo, "tests/vitest.mutation.config.ts"), "utf8");
  const tests = [...mutationConfig.matchAll(/"(integration\/[^"]+\.test\.ts)"/g)].map((match) => `tests/${match[1]}`);
  return new Set([...WATCHED, ...mutated, ...tests]);
};

const isMutationPath = (watched, file) =>
  watched.has(file) ||
  WATCHED_PREFIXES.some((prefix) => file.startsWith(prefix)) ||
  HELPER_DIRS.some((dir) => file.startsWith(dir) && !file.slice(dir.length).includes("/") && file.endsWith(".ts") && !file.endsWith(".test.ts"));

const event = options.event ?? process.env.EVENT_NAME ?? "";
let range;
if (event === "schedule") decide(true, "Scheduled run: the mutation tests always run.");
else if (event === "workflow_dispatch") decide(true, "Manual run: the mutation tests always run.");
else if (event === "pull_request") range = [`${options.base}...${options.head}`];
else if (event === "push") {
  if (!options.base || options.base === ZERO) decide(true, "First push of the branch: there is no earlier commit to compare, so the mutation tests run.");
  range = [options.base, options.head];
} else decide(true, `Event ${event || "(none)"}: no filter applies, so the mutation tests run.`);

try {
  git("cat-file", "-e", `${options.base}^{commit}`);
} catch {
  decide(true, `The base commit ${options.base || "(none)"} is not in the checkout, so the mutation tests run.`);
}
let changed;
try {
  changed = git("diff", "--no-renames", "--name-only", "-z", ...range).split("\0").filter((file) => file !== "");
} catch {
  decide(true, `git diff ${range.join(" ")} failed, so the mutation tests run.`);
}
const watched = watchedPaths();
const hits = changed.filter((file) => isMutationPath(watched, file));
if (hits.length === 0) decide(false, `git diff ${range.join(" ")}: none of ${changed.length} changed path(s) is a mutation-tested module, its test, a test helper or a mutation setting. The mutation tests are not needed.`);
for (const hit of hits) console.log(`Mutation path: ${hit}`);
decide(true, `git diff ${range.join(" ")}: ${hits.length} mutation path(s) changed, starting with ${hits[0]}.`);
