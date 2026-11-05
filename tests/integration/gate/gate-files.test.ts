import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(ROOT, ".github/gate/gate-files.mjs");
const PROBES = path.join(ROOT, ".github/gate/probes/gate-files");
const CODEOWNERS = path.join(ROOT, ".github/CODEOWNERS");

const gateFiles = (args: string[]) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });

const probeNames = readdirSync(PROBES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const scratch = mkdtempSync(path.join(os.tmpdir(), "gate-files-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("gate-files self-test", () => {
  it("passes every probe in .github/gate/probes/gate-files", () => {
    const run = gateFiles(["--probes", PROBES]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const lines = run.stdout.trim().split("\n");
    expect(probeNames.length).toBeGreaterThan(10);
    expect(lines).toHaveLength(probeNames.length);
    expect(lines.map((line) => line.split(":")[0])).toEqual(probeNames.map((name) => `pass ${name}`));
    const verdicts = new Set(lines.map((line) => line.slice(line.lastIndexOf(" ") + 1)));
    expect([...verdicts].sort()).toEqual(["clear", "gated"]);
  });

  it("fails the self-test when a probe expects the wrong verdict", () => {
    const wrong = path.join(scratch, "wrong");
    const gatedProbe = probeNames.find((name) => JSON.parse(readFileSync(path.join(PROBES, name, "expect.json"), "utf8")).gateFiles === "gated");
    expect(gatedProbe).toBeDefined();
    cpSync(path.join(PROBES, gatedProbe as string), path.join(wrong, "said-clear"), { recursive: true });
    writeFileSync(path.join(wrong, "said-clear", "expect.json"), JSON.stringify({ gateFiles: "clear" }));
    const run = gateFiles(["--probes", wrong]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("FAIL said-clear: expected clear, got gated");
  });
});

describe("gate-files CODEOWNERS check", () => {
  it("accepts the committed CODEOWNERS, which is exactly what --codeowners generates", () => {
    const run = gateFiles(["--check-codeowners", CODEOWNERS]);
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toContain("matches the gate-file list");
    const generated = gateFiles(["--codeowners"]);
    expect(generated.status).toBe(0);
    expect(generated.stdout).toBe(readFileSync(CODEOWNERS, "utf8"));
  });

  it("refuses a CODEOWNERS with any one line dropped", () => {
    const lines = readFileSync(CODEOWNERS, "utf8").split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(5);
    for (const index of [0, Math.floor(lines.length / 2), lines.length - 1]) {
      const file = path.join(scratch, `CODEOWNERS-without-${index}`);
      writeFileSync(file, lines.filter((_, i) => i !== index).map((line) => `${line}\n`).join(""));
      const run = gateFiles(["--check-codeowners", file]);
      expect(run.status, `dropped line ${index}: ${lines[index]}`).toBe(1);
      expect(run.stdout).toContain("does not match the gate-file list");
    }
  });

  it("refuses a CODEOWNERS that leaves an approver off one line", () => {
    const text = readFileSync(CODEOWNERS, "utf8");
    const [first, ...rest] = text.split("\n");
    const file = path.join(scratch, "CODEOWNERS-one-owner");
    writeFileSync(file, [(first ?? "").split(" ").slice(0, 2).join(" "), ...rest].join("\n"));
    const run = gateFiles(["--check-codeowners", file]);
    expect(run.status).toBe(1);
  });
});
