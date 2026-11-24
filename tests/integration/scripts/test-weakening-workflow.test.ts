import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PR_BASE_STEP, render, runBash, runPrBaseAction } from "../gate/pr-base-action.ts";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW = path.join(ROOT, ".github/workflows/test-weakening.yml");
const SCRIPT = path.join(ROOT, "scripts/check-test-weakening.mjs");
const CI = path.join(ROOT, ".github/workflows/ci.yml");
const REPO = "example-org/guard";
const TOKEN = "fake-github-token-workflow-test";
const MATH = "tests/math.test.ts";
const BEFORE = 'import { expect, it } from "vitest";\n\nit("adds", () => {\n  expect(1 + 1).toBe(2);\n  expect(2 + 2).toBe(4);\n});\n';
const AFTER = 'import { expect, it } from "vitest";\n\nit("adds", () => {\n  expect(1 + 1).toBe(2);\n});\n';
const TABLE = "## Tests changed\n\n| File | Test | Reason |\n| --- | --- | --- |\n| `tests/math.test.ts` | adds | the second sum moved to a made-up property test |\n";

const scratch = mkdtempSync(path.join(os.tmpdir(), "test-weakening-workflow-"));
const build = path.join(scratch, "build");
const origin = path.join(scratch, "origin.git");
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
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();

const api = { body: "" as string | null, requests: [] as string[] };
const server: Server = createServer((request, response) => {
  api.requests.push(request.url ?? "");
  response.writeHead(request.url === "/repos/example-org/guard/pulls/7" ? 200 : 404, { "content-type": "application/json" });
  response.end(JSON.stringify(request.url === "/repos/example-org/guard/pulls/7" ? { number: 7, base: { ref: "main" }, body: api.body } : { message: "Not Found" }));
});

let apiUrl = "";
let head = "";

beforeAll(async () => {
  mkdirSync(path.join(build, "scripts"), { recursive: true });
  mkdirSync(path.join(build, "tests"), { recursive: true });
  git(build, "init", "-q", "-b", "main");
  writeFileSync(path.join(build, "scripts/check-test-weakening.mjs"), readFileSync(SCRIPT, "utf8"));
  writeFileSync(path.join(build, MATH), BEFORE);
  git(build, "add", "-A");
  git(build, "commit", "-q", "-m", "base");
  git(build, "checkout", "-q", "-b", "feature");
  writeFileSync(path.join(build, MATH), AFTER);
  git(build, "commit", "-q", "-am", "drop an assertion");
  head = git(build, "rev-parse", "HEAD");
  git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  git(origin, "fetch", "-q", build, "+main:refs/heads/main", `+${head}:refs/pull/7/head`);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(scratch, { recursive: true, force: true });
});

const workflowText = readFileSync(WORKFLOW, "utf8");

const envBlock = (lines: string[], indent: number) => {
  const at = lines.indexOf(`${" ".repeat(indent)}env:`);
  const env: Record<string, string> = {};
  if (at === -1) return env;
  for (const line of lines.slice(at + 1)) {
    const [, key, value] = line.match(new RegExp(`^ {${indent + 2}}([A-Z_]+): (.+)$`)) ?? [];
    if (key === undefined || value === undefined) break;
    env[key] = value;
  }
  return env;
};

const checkStep = () => {
  const lines = workflowText.split("\n");
  const jobEnv = envBlock(lines.slice(0, lines.indexOf("    steps:")), 4);
  const starts = lines.flatMap((line, index) => (line.startsWith("      - name: ") ? [index] : []));
  const step = starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length)).find((body) => body.some((line) => line.includes("scripts/check-test-weakening.mjs")));
  if (step === undefined) throw new Error("no step runs scripts/check-test-weakening.mjs");
  const run = step.indexOf("        run: |");
  const script = step
    .slice(run + 1)
    .filter((line) => line.startsWith("          ") || line.trim() === "")
    .map((line) => line.slice(10))
    .join("\n");
  return { env: { ...jobEnv, ...envBlock(step, 8) }, script };
};

const runStep = async (name: string, eventBody: string) => {
  const checkout = path.join(scratch, `${name}-checkout`);
  git(scratch, "clone", "-q", "--no-local", "--no-tags", origin, checkout);
  const temp = path.join(scratch, `${name}-runner-temp`);
  mkdirSync(temp);
  const payload = { pull_request: { number: 7, body: eventBody, head: { sha: head } }, repository: { default_branch: "main" } };
  const contexts = { github: { event: payload, repository: REPO, token: TOKEN } };
  const runnerEnv = { ...GIT_ENV, GITHUB_API_URL: apiUrl, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: path.join(temp, "summary.md") };
  const base = await runPrBaseAction(contexts, runnerEnv, checkout, temp);
  if (base.code !== 0) throw new Error(`the pr-base action failed: ${base.stdout}${base.stderr}`);
  const step = checkStep();
  const stepContexts = { ...contexts, steps: { base: { outputs: base.outputs } } };
  const stepEnv = Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, render(value, stepContexts)]));
  const result = await runBash(step.script, { ...runnerEnv, ...stepEnv }, checkout);
  return { code: result.code, output: result.stdout + result.stderr, summary: readFileSync(path.join(temp, "summary.md"), "utf8") };
};

describe("test-weakening workflow (S3: an edited body is checked again)", () => {
  it("runs on pull_request_target, including edits, from the default branch, and never reads the body from the event payload", () => {
    expect(workflowText).toMatch(/^on:\n {2}pull_request_target:\n {4}types: \[opened, synchronize, reopened, ready_for_review, edited\]\n/m);
    expect(workflowText).toContain("ref: ${{ github.event.repository.default_branch }}");
    expect(workflowText).not.toMatch(/github\.event\.pull_request\.body/);
    expect(workflowText).toMatch(PR_BASE_STEP);
    expect(readFileSync(CI, "utf8")).not.toMatch(/scripts\/check-test-weakening\.mjs|github\.event\.pull_request\.body/);
  });

  it("passes when the body has the table now, though the event was sent before the edit with no table", async () => {
    api.body = TABLE;
    api.requests = [];
    const run = await runStep("edited", "## Summary\n\nNo table yet.\n");
    expect(run.code, run.output).toBe(0);
    expect(api.requests).toEqual(["/repos/example-org/guard/pulls/7", "/repos/example-org/guard/pulls/7"]);
    expect(run.output).toContain(`Checking ${head} against main with the pull request body as it is now.`);
    expect(run.summary).toContain("(declared)");
  });

  it("fails when the body has no table now, though the event carried one", async () => {
    api.body = null;
    const run = await runStep("cleared", TABLE);
    expect(run.code).toBe(1);
    expect(run.output).toContain("test-weakening: tests/math.test.ts:5: removed or changed an assertion (NOT DECLARED): expect(2 + 2).toBe(4);");
    expect(run.output).toContain("Editing the body runs this check again on the current body.");
  });
});
