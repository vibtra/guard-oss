import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CLASSIFIER = path.join(ROOT, ".github/gate/classifier");
const CASE = path.join(CLASSIFIER, "eval/cases/seeded-expect-true");
const NO_KEY_ENV = { PATH: process.env.PATH ?? "" };

const node = (script: string, args: string[]) =>
  spawnSync(process.execPath, [path.join(CLASSIFIER, script), ...args], { cwd: ROOT, encoding: "utf8", env: NO_KEY_ENV, timeout: 120_000 });

describe("classifier self-test", () => {
  it("passes every self-test check with no GATE_CLASSIFIER_API_KEY in the environment", () => {
    expect(NO_KEY_ENV).not.toHaveProperty("GATE_CLASSIFIER_API_KEY");
    const run = node("selftest.mjs", []);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const summary = run.stdout.trim().split("\n").at(-1) ?? "";
    const [, passed, total] = summary.match(/^(\d+)\/(\d+) self-test checks passed$/) ?? [];
    expect(Number(total)).toBeGreaterThan(20);
    expect(passed).toBe(total);
    expect(run.stdout).not.toMatch(/^FAIL/m);
  }, 120_000);
});

describe("classify.mjs without a key", () => {
  const diff = path.join(CASE, "pr.diff");

  it("--dry-run builds the request for an eval case and makes no call", () => {
    const model = JSON.parse(readFileSync(path.join(CLASSIFIER, "model.json"), "utf8")) as { provider: string; model: string };
    const run = node("classify.mjs", ["--diff", diff, "--dry-run", "--json"]);
    expect(run.status, run.stderr).toBe(0);
    const result = JSON.parse(run.stdout) as {
      dryRun: boolean;
      model: string;
      wouldCall: boolean;
      reasons: string[];
      estimate: { inputTokens: number; worstInputTokens: number; costUsd: number };
      request: { system: string; user: string };
    };
    expect(result.dryRun).toBe(true);
    expect(result.model).toBe(`${model.provider}/${model.model}`);
    expect(result.wouldCall).toBe(true);
    expect(result.reasons).toEqual([]);
    expect(result.estimate.inputTokens).toBeGreaterThan(0);
    expect(result.estimate.worstInputTokens).toBeGreaterThanOrEqual(result.estimate.inputTokens);
    expect(result.estimate.costUsd).toBeGreaterThan(0);
    expect(result.request.user).toContain('"apps/relay/src/routes/tokens.test.ts" (test file, modified, +2 -3)');
    expect(result.request.user).toContain("-    expect(res.body).toEqual({ error: 'token expired' });");
    const marker = result.request.user.match(/^<<<PR-DATA ([0-9a-f]{32})\n/)?.[1];
    expect(marker).toBeDefined();
    expect(result.request.user.endsWith(`PR-DATA ${marker}>>>`)).toBe(true);
    expect(result.request.system.startsWith("# Easing classifier\n")).toBe(true);
    expect(result.request.system).toContain(`<<<PR-DATA ${marker}`);
  });

  it("--dry-run prints the request as text", () => {
    const run = node("classify.mjs", ["--diff", diff, "--dry-run"]);
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain("No model call made.");
    expect(run.stdout).toContain("Would call the model: yes.");
    expect(run.stdout).toContain("--- system ---");
    expect(run.stdout).toContain("--- user ---");
  });

  it("without --dry-run exits 3 and names the missing key", () => {
    const run = node("classify.mjs", ["--diff", diff]);
    expect(run.status).toBe(3);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("GATE_CLASSIFIER_API_KEY is not set, so the model was not called");
  });
});

describe("the classifier is off until GATE_CLASSIFIER_API_KEY is set", () => {
  const workflow = readFileSync(path.join(ROOT, ".github/workflows/easing-classifier.yml"), "utf8");

  it("easing-classifier.yml runs only on workflow_dispatch and keeps its job", () => {
    expect(workflow.match(/^on:\n((?: {2}.*\n)+)/m)?.[1]).toBe("  workflow_dispatch:\n");
    expect(workflow).not.toMatch(/^\s*pull_request/m);
    expect(workflow).toContain("GATE_CLASSIFIER_API_KEY: ${{ secrets.GATE_CLASSIFIER_API_KEY }}");
    expect(workflow).toContain("node .github/gate/classifier/classify.mjs --diff");
  });

  it("the ruleset does not require classifier, still requires tripwire, and adds no bypass", () => {
    const ruleset = JSON.parse(readFileSync(path.join(ROOT, ".github/rulesets/main.json"), "utf8")) as {
      bypass_actors: unknown[];
      rules: { type: string; parameters?: { required_status_checks?: { context: string }[] } }[];
    };
    const contexts = ruleset.rules.find((rule) => rule.type === "required_status_checks")?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
    expect(contexts).not.toContain("classifier");
    expect(contexts).toEqual(expect.arrayContaining(["gate-files", "tripwire", "probe-replay", "gates"]));
    expect(ruleset.bypass_actors).toEqual([]);
  });
});
