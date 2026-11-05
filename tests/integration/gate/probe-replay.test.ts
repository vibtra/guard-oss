import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = path.join(ROOT, ".github/gate/probe-replay.mjs");

describe("probe-replay self-test", () => {
  it("passes every case: loosening flips, stricter, errors, sandbox and timeout", () => {
    const run = spawnSync(process.execPath, [SCRIPT, "--selftest"], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" }, timeout: 120_000 });
    expect(run.status, run.stdout + run.stderr).toBe(0);
    const lines = run.stdout.trim().split("\n");
    const [, passed, total] = lines.at(-1)?.match(/^selftest: (\d+) of (\d+) cases passed$/) ?? [];
    expect(Number(total)).toBeGreaterThanOrEqual(12);
    expect(passed).toBe(total);
    expect(lines.slice(0, -1)).toHaveLength(Number(total));
    expect(lines.slice(0, -1).every((line) => line.startsWith("ok   "))).toBe(true);
    expect(run.stdout).toContain("ok   loosened tripwire (one rule removed): exit 1; flips workflow-or-true tripwire");
    expect(run.stdout).toContain("ok   shortened gate-file list: exit 1; flips agent-build-script gate-files, workflow-or-true gate-files");
  }, 120_000);

  it("exits 2 with usage when given no mode", () => {
    const run = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("usage: node .github/gate/probe-replay.mjs");
  });
});
