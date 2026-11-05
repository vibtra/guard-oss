import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-test-locations.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tree = async (files: readonly string[]): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-locations-"));
  roots.push(root);
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "package fixture\n");
  }
  return root;
};

const check = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });

describe("check-test-locations", () => {
  it("passes a tree whose agent-go tests live in tests/integration/agent-go", async () => {
    const result = check(await tree(["guard/agent-go/main.go", "guard/agent-go/testdata/fixture.go", "tests/integration/agent-go/relay.test.ts"]));
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails on every *_test.go under guard/agent-go and names each file and tests/integration/agent-go/", async () => {
    const result = check(await tree(["guard/agent-go/main.go", "guard/agent-go/made_up_test.go", "guard/agent-go/internal/fixture/other_test.go"]));
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n")).toEqual([
      "test-locations: guard/agent-go/internal/fixture/other_test.go is a Go test file under guard/agent-go. Put agent-go tests in tests/integration/agent-go/ as vitest tests that drive the real agent binary.",
      "test-locations: guard/agent-go/made_up_test.go is a Go test file under guard/agent-go. Put agent-go tests in tests/integration/agent-go/ as vitest tests that drive the real agent binary.",
    ]);
  });

  it("fails on a symlink named *_test.go under guard/agent-go", async () => {
    const root = await tree(["guard/agent-go/main.go", "elsewhere/sneaky.go.txt"]);
    await symlink("../../elsewhere/sneaky.go.txt", path.join(root, "guard/agent-go/sneaky_test.go"));
    const result = check(root);
    expect([result.status, result.stderr.trim()]).toEqual([
      1,
      "test-locations: guard/agent-go/sneaky_test.go is a Go test file under guard/agent-go. Put agent-go tests in tests/integration/agent-go/ as vitest tests that drive the real agent binary.",
    ]);
  });
});
