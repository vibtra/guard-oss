import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(ROOT, "scripts/mutation-paths.mjs");
const scratch = mkdtempSync(path.join(os.tmpdir(), "mutation-paths-"));
const repo = path.join(scratch, "repo");
const GIT_ENV = {
  PATH: process.env.PATH ?? "",
  HOME: scratch,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Made-up Author",
  GIT_AUTHOR_EMAIL: "author@example.test",
  GIT_COMMITTER_NAME: "Made-up Author",
  GIT_COMMITTER_EMAIL: "author@example.test",
};
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env: GIT_ENV, encoding: "utf8" }).trim();
const put = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  writeFileSync(path.join(repo, file), text);
};

let base = "";

beforeAll(() => {
  mkdirSync(repo);
  git("init", "-q", "-b", "main");
  put("stryker.config.json", readFileSync(path.join(ROOT, "stryker.config.json"), "utf8"));
  put("tests/vitest.mutation.config.ts", readFileSync(path.join(ROOT, "tests/vitest.mutation.config.ts"), "utf8"));
  put("docs/made-up.md", "made-up\n");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  base = git("rev-parse", "HEAD");
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const decideFor = (file: string) => {
  git("checkout", "-q", "-B", "change", base);
  put(file, `made-up change to ${file}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", `change ${file}`);
  const head = git("rev-parse", "HEAD");
  return spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--event", "push", "--base", base, "--head", head], { encoding: "utf8", env: { PATH: GIT_ENV.PATH } });
};

describe("mutation-paths (S7: the filter covers helpers, shared modules and the lockfile)", () => {
  it.each([
    "tests/integration/registry/server-options.ts",
    "tests/integration/guard-contract/support.ts",
    "packages/guard-contract/src/bundle.ts",
    "apps/registry/src/errors.ts",
    "pnpm-lock.yaml",
    "apps/registry/src/vault/seal.ts",
    "tests/integration/registry/vault-seal.test.ts",
    "tests/contracts/vault-sealer.ts",
    "tests/fixtures/sealer-mutant/sealer-mutant.fixture.ts",
  ])("runs the mutation tests when %s changes", (file) => {
    const result = decideFor(file);
    expect([result.status, result.stdout.trim().split("\n").at(-1)]).toEqual([0, expect.stringMatching(/^run=true: /)]);
    expect(result.stdout).toContain(`Mutation path: ${file}`);
  });

  it.each(["docs/made-up.md", "tests/integration/registry/guard-asks.test.ts", "tests/integration/registry/nested/helper.ts"])("skips them when only %s changes", (file) => {
    const result = decideFor(file);
    expect([result.status, result.stdout.trim()]).toEqual([0, expect.stringMatching(/^run=false: /)]);
  });

  it("skips them on a pull request, even when a mutation-tested module changes", () => {
    git("checkout", "-q", "-B", "change", base);
    put("apps/registry/src/vault/seal.ts", "made-up change\n");
    git("add", "-A");
    git("commit", "-q", "-m", "change seal.ts");
    const head = git("rev-parse", "HEAD");
    const result = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--event", "pull_request", "--base", base, "--head", head], { encoding: "utf8", env: { PATH: GIT_ENV.PATH } });
    expect([result.status, result.stdout.trim()]).toEqual([0, expect.stringMatching(/^run=false: Pull request: /)]);
  });

  it("runs them when the base commit is missing or the event is a manual run", () => {
    const missing = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--event", "push", "--base", "0123456789abcdef0123456789abcdef01234567", "--head", base], { encoding: "utf8" });
    expect(missing.stdout).toMatch(/^run=true: The base commit .* is not in the checkout/);
    const manual = spawnSync(process.execPath, [SCRIPT, "--repo", repo, "--event", "workflow_dispatch"], { encoding: "utf8" });
    expect(manual.stdout.trim()).toBe("run=true: Manual run: the mutation tests always run.");
  });
});

const condition = (): string => {
  const ci = readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8");
  const job = ci.slice(ci.indexOf("\n  mutation:\n"));
  const [, expression] = job.match(/^ {4}if: \$\{\{ (.*) \}\}$/m) ?? [];
  if (expression === undefined) throw new Error("the mutation job has no if:");
  return expression;
};

const evaluate = (expression: string, needs: Record<string, { result: string; outputs?: Record<string, string> }>): boolean => {
  const js = expression
    .replace(/!cancelled\(\)/g, "true")
    .replace(/needs\.([\w-]+)\.outputs\.(\w+)/g, (_, job: string, key: string) => JSON.stringify(needs[job]?.outputs?.[key] ?? ""))
    .replace(/needs\.([\w-]+)\.result/g, (_, job: string) => JSON.stringify(needs[job]?.result ?? ""))
    .replace(/==/g, "===")
    .replace(/!===/g, "!==");
  return new Function(`return (${js});`)() as boolean;
};

describe("the mutation job's condition (S6: a broken path filter runs the job instead of skipping it)", () => {
  it.each([
    ["mutation-paths failed and set no output", { result: "failure" }, true],
    ["mutation-paths was cancelled mid-way", { result: "cancelled" }, true],
    ["the filter said run", { result: "success", outputs: { run: "true" } }, true],
    ["the filter said skip", { result: "success", outputs: { run: "false" } }, false],
  ])("%s", (_, paths, expected) => {
    expect(evaluate(condition(), { gates: { result: "success" }, "mutation-paths": paths })).toBe(expected);
  });

  it("never runs when the gates did not pass", () => {
    expect(evaluate(condition(), { gates: { result: "failure" }, "mutation-paths": { result: "failure" } })).toBe(false);
  });
});
