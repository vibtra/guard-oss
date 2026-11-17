import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/select-tests.mjs", import.meta.url));
const scratch = await mkdtemp(path.join(os.tmpdir(), "select-tests-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

type Selection = { all: boolean; reasons: string[]; run: string[]; skip: string[] };

const isSelection = (value: unknown): value is Selection =>
  typeof value === "object" && value !== null && "all" in value && "run" in value && "skip" in value && "reasons" in value;

let count = 0;
const selectFor = async (changed: readonly string[]): Promise<Selection> => {
  count += 1;
  const list = path.join(scratch, `changed-${count}.txt`);
  await writeFile(list, `${changed.join("\n")}\n`);
  const result = spawnSync(process.execPath, [SCRIPT, "--changed", list, "--json"], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  const parsed: unknown = JSON.parse(result.stdout);
  if (!isSelection(parsed)) throw new Error(`select-tests printed ${result.stdout}`);
  return parsed;
};

describe("select-tests with tests/selection-map.json", () => {
  it("selects the agent tests, the provider and capture E2E jobs and the Mac jobs for a Go-only change, and skips the registry tests", async () => {
    const selection = await selectFor(["guard/agent-go/proxy.go"]);
    expect(selection.all).toBe(false);
    expect(selection.run).toEqual(expect.arrayContaining(["integration/agent-go", "job:e2e-providers", "job:e2e-capture-matrix", "job:mac"]));
    expect(selection.skip).toEqual(expect.arrayContaining(["integration/registry", "job:e2e-console", "job:rust-agent"]));
  });

  it("runs everything when a changed file matches no area", async () => {
    const selection = await selectFor(["guard/agent-go/proxy.go", "brand-new-folder/thing.ts"]);
    expect(selection.all).toBe(true);
    expect(selection.skip).toEqual([]);
    expect(selection.reasons.join("\n")).toContain("brand-new-folder/thing.ts matches no area");
  });

  it("runs everything when a global input changes", async () => {
    for (const file of ["pnpm-lock.yaml", "packages/guard-contract/src/signing.ts", "tests/support/agent.ts", ".github/workflows/ci.yml", "tests/selection-map.json"]) {
      const selection = await selectFor([file]);
      expect(selection.all, file).toBe(true);
    }
  });

  it("runs no test area for a docs-only change, but runs an area whose tests read the changed doc", async () => {
    expect((await selectFor(["docs/ci.md", "CONTRIBUTING.md"])).run).toEqual([]);
    expect((await selectFor(["docs/self-host.md"])).run).toEqual(["integration/infra"]);
    expect((await selectFor(["guard/agent-go/engine/README.md"])).run).toContain("integration/agent-go");
  });

  it("selects only the Mac jobs for a Swift-only change", async () => {
    const selection = await selectFor(["guard/mac/Shared/AgentLocal.swift"]);
    expect(selection.all).toBe(false);
    expect(selection.run).toEqual(["job:mac"]);
  });

  it("checks the map against the tree: every glob matches a tracked file and every integration test folder is covered", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--check-map"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
  });
});
