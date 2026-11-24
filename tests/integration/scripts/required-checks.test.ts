import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

const requiredContexts = (): string[] => {
  const ruleset = JSON.parse(read(".github/rulesets/main.json")) as { rules: { type: string; parameters?: { required_status_checks?: { context: string; integration_id: number }[] } }[] };
  return ruleset.rules.find((rule) => rule.type === "required_status_checks")?.parameters?.required_status_checks?.map((check) => check.context) ?? [];
};

const jobsOf = (workflow: string): string[] => [...read(workflow).matchAll(/^ {2}([\w-]+):\n/gm)].map((match) => match[1] ?? "");

describe("the main ruleset (B1: the VIB-66 gates are required)", () => {
  it("requires test-weakening and mutation, so a failing run of either blocks the merge", () => {
    expect(requiredContexts()).toEqual(expect.arrayContaining(["test-weakening", "mutation"]));
  });

  it("names jobs that exist: test-weakening in its own workflow, mutation in ci.yml", () => {
    expect(jobsOf(".github/workflows/test-weakening.yml")).toContain("test-weakening");
    expect(jobsOf(".github/workflows/ci.yml")).toContain("mutation");
  });

  it("lets a path-filtered mutation job skip, which GitHub counts as passing, instead of leaving the check pending", () => {
    const ci = read(".github/workflows/ci.yml");
    const job = ci.slice(ci.indexOf("\n  mutation:\n"));
    expect(job).toMatch(/^ {4}if: \$\{\{ .*needs\.mutation-paths\.outputs\.run == 'true'.* \}\}$/m);
  });
});

describe("jobs gated on the changes filter (QA round 1 on #87: a failed changes job skipped the required Mac jobs)", () => {
  it("still run when changes fails, because a skipped job passes its required check", () => {
    const gated = read(".github/workflows/ci.yml")
      .split("\n")
      .filter((line) => /^ {4}if: .*needs\.changes\.outputs\./.test(line));
    expect(gated).toHaveLength(3);
    for (const line of gated) expect(line).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && /);
  });
});

const WORKFLOWS = [".github/workflows/ci.yml", ".github/workflows/gate-files.yml", ".github/workflows/easing-tripwire.yml", ".github/workflows/gate-replay.yml", ".github/workflows/test-weakening.yml"];
const triggersOf = (workflow: string): string[] => [...(read(workflow).match(/^on:\n((?: {2}.*\n)+)/m)?.[1] ?? "").matchAll(/^ {2}([\w-]+):/gm)].map((match) => match[1] ?? "");

describe("the merge queue (a required check that never reports on the queue commit holds every merge)", () => {
  it("is on in the main ruleset, and the branch no longer has to be up to date before it joins", () => {
    const ruleset = JSON.parse(read(".github/rulesets/main.json")) as { rules: { type: string; parameters?: { strict_required_status_checks_policy?: boolean } }[] };
    expect(ruleset.rules.map((rule) => rule.type)).toContain("merge_queue");
    expect(ruleset.rules.find((rule) => rule.type === "required_status_checks")?.parameters?.strict_required_status_checks_policy).toBe(false);
  });

  it.each(requiredContexts().map((context) => [context, context.replace(/ \(.*\)$/, "")]))("%s comes from a workflow that starts on merge_group", (_, job) => {
    const workflow = WORKFLOWS.find((file) => jobsOf(file).includes(job));
    expect(workflow, `no workflow in ${WORKFLOWS.join(", ")} has a job named ${job}`).toBeDefined();
    expect(triggersOf(workflow ?? "")).toContain("merge_group");
  });
});
