import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/audit-selection.mjs", import.meta.url));
const ROOT = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const scratch = await mkdtemp(path.join(os.tmpdir(), "audit-selection-"));

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let count = 0;
const audit = async (area: string, opened: readonly string[]) => {
  count += 1;
  const log = path.join(scratch, `opens-${count}.log`);
  await writeFile(log, `${opened.map((file, index) => `node(${1000 + index}): O ${path.join(ROOT, file)}`).join("\n")}\n`);
  return spawnSync(process.execPath, [SCRIPT, "--area", area, "--opens", log], { encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } });
};

describe("audit-selection compares the files an area opened with tests/selection-map.json", () => {
  it("passes when every tracked file the area opened is declared for it or global", async () => {
    const result = await audit("integration/agent-go", ["guard/agent-go/main.go", "tests/support/agent.ts", "tests/integration/agent-go/tls.test.ts", "node_modules/vitest/package.json"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("The map declares every one.");
  });

  it("fails and names the file when an area opened a tracked file its entry does not list", async () => {
    const result = await audit("integration/agent-go", ["guard/agent-go/main.go", "apps/registry/src/main.ts"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("`apps/registry/src/main.ts`");
  });

  it("fails when fatrace recorded no tracked file, because an empty trace proves nothing", async () => {
    const result = await audit("integration/agent-go", ["node_modules/vitest/package.json"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("proves nothing");
  });
});
