import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CI = path.join(ROOT, ".github/workflows/ci.yml");
const REPO = "example-org/guard";
const HEAD_SHA = "a".repeat(40);

const FAKE_GH = `#!/bin/bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ "$1 $2 $3" = "api --include --silent" ]; then
  echo "HTTP/2.0 200 OK"
  exit 0
fi
if [ "$1 $2" = "api --paginate" ]; then
  cat "$FAKE_GH_RUNS"
  exit 0
fi
exit 2
`;

const gatesScript = () => {
  const lines = readFileSync(CI, "utf8").split("\n");
  const job = lines.indexOf("  gates:");
  const step = lines.findIndex((line, index) => index > job && line === "      - name: Wait for the gate checks on the pull request head");
  const run = lines.findIndex((line, index) => index > step && line === "        run: |");
  expect(job).toBeGreaterThan(-1);
  expect(step).toBeGreaterThan(job);
  expect(run).toBeGreaterThan(step);
  const body: string[] = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith("          ")) break;
    body.push(line.slice(10));
  }
  return body.join("\n");
};

const scratch = mkdtempSync(path.join(os.tmpdir(), "gates-job-test-"));
const bin = path.join(scratch, "bin");
mkdirSync(bin);
writeFileSync(path.join(bin, "gh"), FAKE_GH);
chmodSync(path.join(bin, "gh"), 0o755);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

type Run = { name: string; conclusion: string };
let counter = 0;

const runGates = (checkRuns: Run[]) => {
  counter += 1;
  const dir = path.join(scratch, `run-${counter}`);
  mkdirSync(dir);
  const runs = path.join(dir, "runs.json");
  writeFileSync(
    runs,
    JSON.stringify({
      total_count: checkRuns.length,
      check_runs: checkRuns.map((run, index) => ({ id: index + 1, name: run.name, status: "completed", conclusion: run.conclusion, app: { slug: "github-actions" } })),
    }),
  );
  const summary = path.join(dir, "summary.md");
  const log = path.join(dir, "gh.log");
  writeFileSync(summary, "");
  writeFileSync(log, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", gatesScript()], {
    cwd: dir,
    encoding: "utf8",
    timeout: 40_000,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      GH_TOKEN: "fake-github-token-gates-test",
      EVENT_NAME: "pull_request",
      HEAD_SHA,
      DEFAULT_BRANCH: "main",
      GITHUB_REPOSITORY: REPO,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: dir,
      FAKE_GH_RUNS: runs,
      FAKE_GH_LOG: log,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, summary: readFileSync(summary, "utf8"), gh: readFileSync(log, "utf8") };
};

const ON = [
  { name: "gate-files", conclusion: "success" },
  { name: "tripwire", conclusion: "success" },
  { name: "probe-replay", conclusion: "success" },
];

describe("ci.yml gates job with the classifier off", () => {
  it("passes when the three gate checks succeed and no classifier check exists", () => {
    const run = runGates(ON);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.summary).toContain("Passed: every expected gate check has finished, and tripwire concluded success where expected.");
    expect(run.summary).toContain("| gate-files | success |");
    expect(run.summary).toContain("| tripwire | success |");
    expect(run.summary).toContain("| probe-replay | success |");
    expect(run.summary).not.toContain("classifier");
    expect(run.gh).not.toContain("easing-classifier.yml");
    expect(run.gh).toContain(`repos/${REPO}/contents/.github/workflows/easing-tripwire.yml?ref=main`);
  });

  it("ignores a failed classifier run, such as a manual dispatch", () => {
    const run = runGates([...ON, { name: "classifier", conclusion: "failure" }]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).not.toContain("classifier");
  });

  it("still fails when tripwire concludes anything but success", () => {
    const run = runGates([ON[0] as Run, { name: "tripwire", conclusion: "failure" }, ON[2] as Run]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`::error::tripwire concluded failure on ${HEAD_SHA}. Only success passes.`);
    expect(run.summary).toContain("Failed: tripwire concluded failure. Only success passes.");
  });
});
