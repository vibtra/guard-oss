import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const WORKFLOW = path.join(ROOT, ".github/workflows/gate-files.yml");
const GATE_FILES = path.join(ROOT, ".github/gate/gate-files.mjs");
const REPO = "example-org/guard";
const TOKEN = "fake-github-token-workflow-test";

const scratch = mkdtempSync(path.join(os.tmpdir(), "gate-files-workflow-test-"));
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

const commit = (files: Record<string, string>, message: string) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(build, file)), { recursive: true });
    writeFileSync(path.join(build, file), text);
  }
  git(build, "add", "-A");
  git(build, "commit", "-q", "-m", message);
  return git(build, "rev-parse", "HEAD");
};

const LIST_M1 = "made-up/first/**\n";
const LIST_M2 = "made-up/first/**\nmade-up/second/**\n";
const shas = { m1: "", m2: "", r1: "", merged: "", reverted: "", onRelease: "" };

type Pull = { ref: string; sha: string };
type Api = { pull: Pull | null; requests: { url: string; auth: string | undefined }[] };

const api: Api = { pull: null, requests: [] };
const server: Server = createServer((request, response) => {
  api.requests.push({ url: request.url ?? "", auth: request.headers.authorization });
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (request.url === "/repos/example-org/guard/pulls/7" && api.pull !== null) return send(200, { number: 7, base: api.pull });
  const [, base, head] = request.url?.match(/^\/repos\/example-org\/guard\/compare\/([0-9a-f]{40})\.\.\.([0-9a-f]{40})$/) ?? [];
  if (base !== undefined && head !== undefined) {
    const found = spawnSync("git", ["merge-base", base, head], { cwd: origin, env: GIT_ENV, encoding: "utf8" });
    if (found.status === 0) return send(200, { merge_base_commit: { sha: found.stdout.trim() } });
  }
  return send(404, { message: "Not Found" });
});

let apiUrl = "";

beforeAll(async () => {
  mkdirSync(build);
  git(build, "init", "-q", "-b", "main");
  shas.m1 = commit({ ".github/gate-files.txt": LIST_M1, "src/app.txt": "made-up line one\n" }, "M1");
  git(build, "checkout", "-q", "-b", "feature");
  commit({ "src/app.txt": "made-up line one\nmade-up line two\n" }, "feature change");
  git(build, "checkout", "-q", "main");
  shas.m2 = commit({ ".github/gate-files.txt": LIST_M2 }, "M2 adds a gate pattern");
  git(build, "checkout", "-q", "feature");
  git(build, "merge", "-q", "--no-edit", "main");
  shas.merged = git(build, "rev-parse", "HEAD");
  shas.reverted = commit({ ".github/gate-files.txt": LIST_M1 }, "put the list back");
  git(build, "checkout", "-q", "-b", "release", shas.m1);
  shas.r1 = commit({ "docs/release.txt": "made-up release note\n" }, "R1");
  shas.onRelease = commit({ "src/app.txt": "made-up line one\nmade-up release fix\n" }, "release fix");
  git(scratch, "init", "-q", "--bare", "-b", "main", origin);
  git(origin, "fetch", "-q", build, `+${shas.m2}:refs/heads/main`, `+${shas.r1}:refs/heads/release`, `+${shas.reverted}:refs/keep/reverted`, `+${shas.onRelease}:refs/keep/on-release`);
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

const diffStep = (text: string) => {
  const lines = text.split("\n");
  const jobEnv = envBlock(lines.slice(0, lines.indexOf("    steps:")), 4);
  const starts = lines.flatMap((line, index) => (line.startsWith("      - name: ") ? [index] : []));
  const steps = starts.map((start, i) => lines.slice(start, starts[i + 1] ?? lines.length));
  const step = steps.find((body) => body.some((line) => line.includes('> "$RUNNER_TEMP/pr.diff"')));
  if (step === undefined) throw new Error("no step writes $RUNNER_TEMP/pr.diff");
  const run = step.indexOf("        run: |");
  const script = step
    .slice(run + 1)
    .filter((line) => line.startsWith("          ") || line.trim() === "")
    .map((line) => line.slice(10))
    .join("\n");
  return { name: (step[0] ?? "").slice("      - name: ".length), env: { ...jobEnv, ...envBlock(step, 8) }, script };
};

const event = (baseRef: string, baseSha: string, head: string) => ({
  action: "opened",
  number: 7,
  pull_request: { number: 7, head: { sha: head, ref: "feature/made-up" }, base: { ref: baseRef, sha: baseSha } },
  repository: { full_name: REPO, default_branch: "main" },
});

const render = (value: string, contexts: Record<string, unknown>) =>
  value.replace(/\$\{\{\s*([\w.]+)\s*\}\}/g, (_, expression: string) => {
    let current: unknown = contexts;
    for (const key of expression.split(".")) current = current !== null && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined;
    return current === undefined || current === null ? "" : String(current);
  });

type Run = { code: number | null; stdout: string; stderr: string; diff: string | null; checkout: string; diffFile: string };

const runStep = (name: string, payload: ReturnType<typeof event>, pullHead = payload.pull_request.head.sha) => {
  git(origin, "update-ref", "refs/pull/7/head", pullHead);
  const checkout = path.join(scratch, `${name}-checkout`);
  git(scratch, "clone", "-q", "--no-local", "--no-tags", origin, checkout);
  const temp = path.join(scratch, `${name}-runner-temp`);
  mkdirSync(temp);
  const step = diffStep(workflowText);
  const contexts = { github: { event: payload, repository: REPO, token: TOKEN } };
  const env = {
    ...GIT_ENV,
    ...Object.fromEntries(Object.entries(step.env).map(([key, value]) => [key, render(value, contexts)])),
    GITHUB_API_URL: apiUrl,
    RUNNER_TEMP: temp,
    GITHUB_STEP_SUMMARY: path.join(temp, "summary.md"),
  };
  return new Promise<Run>((resolve, reject) => {
    const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", step.script], { env, cwd: checkout });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      const diffFile = path.join(temp, "pr.diff");
      resolve({ code, stdout, stderr, diff: existsSync(diffFile) ? readFileSync(diffFile, "utf8") : null, checkout, diffFile });
    });
  });
};

const diffFrom = (base: string, head: string) => `${git(build, "diff", "--no-color", "--no-ext-diff", "-M", base, head)}\n`;
const fetched = (checkout: string, ref: string) => spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd: checkout, env: GIT_ENV }).status === 0;
const gateFiles = (diffFile: string) => {
  const result = spawnSync(process.execPath, [GATE_FILES, "--diff", diffFile, "--json"], { encoding: "utf8" });
  return { code: result.status, json: JSON.parse(result.stdout) as { gated: boolean; files: { path: string }[] } };
};

describe("gate-files workflow: the diff base", () => {
  it("never reads the base from the event payload", () => {
    expect(workflowText).not.toMatch(/github\.event\.pull_request\.base\b/);
    expect(diffStep(workflowText).name).toMatch(/current base branch from the GitHub API, fetch its tip/);
  });

  it("a re-run of a run from before a base change diffs against the PR's current base branch, not the event's", async () => {
    api.pull = { ref: "release", sha: shas.r1 };
    api.requests = [];
    const run = await runStep("rerun-after-retarget", event("main", shas.m1, shas.onRelease));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.diff).toBe(diffFrom(shas.r1, shas.onRelease));
    expect(api.requests.map((request) => request.url)).toEqual(["/repos/example-org/guard/pulls/7"]);
    expect(api.requests.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(git(run.checkout, "rev-parse", "refs/remotes/pr/base")).toBe(shas.r1);
    expect(run.stdout).toContain(`The PR's current base is release. Merge base of its tip and ${shas.onRelease}: ${shas.r1}.`);
  });

  it("follows the API when the base did not change", async () => {
    api.pull = { ref: "main", sha: shas.m2 };
    const run = await runStep("same-base", event("main", shas.m2, shas.merged));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.diff).toBe(diffFrom(shas.m2, shas.merged));
  });

  it("flags a PR that merges main and reverts a gate change main got after the API's base.sha", async () => {
    api.pull = { ref: "main", sha: shas.m1 };
    const run = await runStep("hidden-revert", event("main", shas.m1, shas.reverted));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const gate = gateFiles(run.diffFile);
    expect(gate.code).toBe(1);
    expect(gate.json.gated).toBe(true);
    expect(gate.json.files.map((file) => file.path)).toEqual([".github/gate-files.txt"]);
    expect(run.diff).toBe(diffFrom(shas.m2, shas.reverted));
  });

  it("does not gate a PR that only merges main for main's own gate change after the API's base.sha", async () => {
    api.pull = { ref: "main", sha: shas.m1 };
    const run = await runStep("merge-only", event("main", shas.m1, shas.merged));
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const gate = gateFiles(run.diffFile);
    expect(gate.code).toBe(0);
    expect(gate.json.gated).toBe(false);
    expect(run.diff).toBe(diffFrom(shas.m2, shas.merged));
  });

  it("fails closed when the GitHub API does not answer", async () => {
    api.pull = null;
    const run = await runStep("api-down", event("main", shas.m2, shas.merged));
    expect(run.code).not.toBe(0);
    expect(run.diff).toBeNull();
    expect(fetched(run.checkout, "refs/remotes/pr/head")).toBe(false);
  });

  it("fails closed when the API's base branch name is not a valid branch name", async () => {
    api.pull = { ref: "main..made-up", sha: shas.m2 };
    const run = await runStep("bad-ref", event("main", shas.m2, shas.merged));
    expect(run.code).not.toBe(0);
    expect(run.diff).toBeNull();
    expect(fetched(run.checkout, "refs/remotes/pr/head")).toBe(false);
    expect(run.stdout).toContain("The base branch name from the GitHub API is not a valid branch name.");
  });

  it("fails when the PR head moved past the event's head SHA", async () => {
    api.pull = { ref: "main", sha: shas.m2 };
    const run = await runStep("head-moved", event("main", shas.m2, shas.merged), shas.onRelease);
    expect(run.code).not.toBe(0);
    expect(run.diff).toBeNull();
    expect(run.stdout).toContain(`The PR head moved past ${shas.merged}.`);
  });
});
