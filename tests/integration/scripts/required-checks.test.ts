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
