import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(ROOT, ".github/gate/tripwire.mjs");
const PROBES = path.join(ROOT, ".github/gate/probes/tripwire");
const RULES = [
  "gate-line-removed",
  "or-true",
  "continue-on-error",
  "if-false",
  "skip-marker",
  "widened-pattern",
  "raised-threshold",
  "assertion-removed",
  "test-noop",
  "lint-suppression",
];

type Expect = { tripwire: "flag" | "clean"; rules?: string[] };
type Finding = { rule: string; file: string; line: number; text: string };

const tripwire = (args: string[], options: { cwd?: string; nodeArgs?: string[] } = {}) =>
  spawnSync(process.execPath, [...(options.nodeArgs ?? []), SCRIPT, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

const probes = RULES.flatMap((rule) =>
  readdirSync(path.join(PROBES, rule), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(PROBES, rule, entry.name);
      return { rule, name: `${rule}/${entry.name}`, dir, expect: JSON.parse(readFileSync(path.join(dir, "expect.json"), "utf8")) as Expect };
    }),
);

const scratch = mkdtempSync(path.join(os.tmpdir(), "tripwire-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("tripwire probes", () => {
  it("has a flagged probe and a clean probe for every rule", () => {
    for (const rule of RULES) {
      const own = probes.filter((probe) => probe.rule === rule);
      expect(own.some((p) => p.name.startsWith(`${rule}/flag-`) && p.expect.tripwire === "flag" && p.expect.rules?.includes(rule)), rule).toBe(true);
      expect(own.some((p) => p.name.startsWith(`${rule}/clean-`) && p.expect.tripwire === "clean"), rule).toBe(true);
    }
    expect(readdirSync(PROBES).sort()).toEqual([...RULES].sort());
  });

  it("passes its own probe self-test", () => {
    const run = tripwire(["--probes", PROBES]);
    const lines = run.stdout.trim().split("\n");
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(lines).toHaveLength(probes.length);
    expect(lines.every((line) => line.startsWith("pass "))).toBe(true);
  });

  it.each(probes.map((probe) => [probe.name, probe] as const))("%s: --json matches expect.json and the exit code", (_name, probe) => {
    const run = tripwire(["--diff", path.join(probe.dir, "pr.diff"), "--json"]);
    const result = JSON.parse(run.stdout) as { flagged: boolean; findings: Finding[] };
    const rules = [...new Set(result.findings.map((finding) => finding.rule))].sort();
    expect(run.status).toBe(probe.expect.tripwire === "flag" ? 1 : 0);
    expect(result.flagged).toBe(probe.expect.tripwire === "flag");
    expect(result.flagged).toBe(result.findings.length > 0);
    expect(rules).toEqual([...(probe.expect.rules ?? [])].sort());
    for (const finding of result.findings) {
      expect(RULES).toContain(finding.rule);
      expect(Number.isInteger(finding.line)).toBe(true);
      expect(typeof finding.file).toBe("string");
      expect(typeof finding.text).toBe("string");
    }
  });
});

describe("tripwire CLI", () => {
  it("fails the self-test when a probe expects the wrong result", () => {
    const dir = path.join(scratch, "wrong", "or-true-said-clean");
    cpSync(path.join(PROBES, "or-true/flag-test-step"), dir, { recursive: true });
    writeFileSync(path.join(dir, "expect.json"), JSON.stringify({ tripwire: "clean" }));
    const run = tripwire(["--probes", path.join(scratch, "wrong")]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL or-true-said-clean: expected clean, got flag (or-true)");
  });

  it("reads its default lists next to the script under a read-only Node permission sandbox", () => {
    const diff = path.join(PROBES, "skip-marker/flag-it-skip/pr.diff");
    const run = tripwire(["--diff", diff, "--json"], {
      cwd: scratch,
      nodeArgs: ["--permission", `--allow-fs-read=${path.join(ROOT, ".github")}`, `--allow-fs-read=${diff}`],
    });
    expect(run.status, run.stderr).toBe(1);
    expect(JSON.parse(run.stdout).findings.map((f: Finding) => f.rule)).toEqual(["skip-marker"]);
  });

  it("exits 2 on usage and input errors", () => {
    const noHeader = path.join(scratch, "no-header.diff");
    writeFileSync(noHeader, "+added line without a diff header\n");
    expect(tripwire([]).status).toBe(2);
    expect(tripwire(["--diff", noHeader, "--probes", PROBES]).status).toBe(2);
    expect(tripwire(["--diff", path.join(scratch, "missing.diff")]).status).toBe(2);
    const bad = tripwire(["--diff", noHeader]);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('no "diff --git" header');
  });
});
