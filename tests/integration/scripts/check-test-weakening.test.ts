import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-test-weakening.mjs", import.meta.url));
const roots: string[] = [];

const EXISTING = [
  'import { expect, it } from "vitest";',
  "",
  'it("adds", () => {',
  "  expect(1 + 1).toBe(2);",
  "  expect(() => JSON.parse(\"{\")).toThrow();",
  "});",
  "",
].join("\n");

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (root: string, ...args: string[]): string =>
  execFileSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });

const write = async (root: string, file: string, text: string): Promise<void> => {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
};

const repo = async (files: Record<string, string> = { "tests/math.test.ts": EXISTING, "src/math.ts": "export const add = (a: number, b: number): number => a + b;\n" }): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-weakening-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  for (const [file, text] of Object.entries(files)) await write(root, file, text);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  git(root, "checkout", "--quiet", "-b", "change");
  return root;
};

const commit = (root: string): void => {
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", "change");
};

const check = async (root: string, body: string, event = "pull_request") => {
  const bodyFile = path.join(root, "..", `${path.basename(root)}-body.md`);
  await writeFile(bodyFile, body);
  roots.push(bodyFile);
  return spawnSync(process.execPath, [SCRIPT, "--repo", root, "--base", "main", "--event", event, "--body-file", bodyFile], { encoding: "utf8", env: { ...process.env, PR_BODY: "" } });
};

const TABLE = ["## Summary", "", "Made-up change.", "", "## Tests changed", "", "| File | Test | Reason |", "| --- | --- | --- |", "| `tests/math.test.ts` | adds | the parser no longer throws on `{`, see the made-up issue |", ""].join("\n");

describe("check-test-weakening", () => {
  it("fails when a pull request weakens an assertion in an existing test, and names the file and line", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", EXISTING.replace('  expect(() => JSON.parse("{")).toThrow();\n', ""));
    commit(root);
    const result = await check(root, "## Summary\n\nMade-up change.\n");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('test-weakening: tests/math.test.ts:5: removed or changed an assertion (NOT DECLARED): expect(() => JSON.parse("{")).toThrow();');
    expect(result.stderr).toContain('The pull request body has no "## Tests changed" section.');
  });

  it("passes the same change when the body has a ## Tests changed table naming the file with a reason", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", EXISTING.replace('  expect(() => JSON.parse("{")).toThrow();\n', ""));
    commit(root);
    const result = await check(root, TABLE);
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("(declared)");
  });

  it("passes a new test file, whatever it contains", async () => {
    const root = await repo();
    await write(root, "tests/other.test.ts", 'import { it } from "vitest";\n\nit.skip("later", () => undefined);\nit.only("now", () => undefined);\n');
    commit(root);
    const result = await check(root, "");
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("passes added assertions and changes outside test files", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", EXISTING.replace("});", "  expect(2 + 2).toBe(4);\n});"));
    await write(root, "src/math.ts", "export const add = (a: number, b: number): number => b + a;\n");
    commit(root);
    const result = await check(root, "");
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails a changed assertion: the old line counts as removed", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", EXISTING.replace("expect(1 + 1).toBe(2);", "expect(1 + 1).toBeGreaterThan(0);"));
    commit(root);
    const result = await check(root, "");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("tests/math.test.ts:4: removed or changed an assertion (NOT DECLARED): expect(1 + 1).toBe(2);");
  });

  it("fails a .skip, .only or .todo added to an existing test file", async () => {
    for (const added of ['it.skip("later", () => undefined);', 'describe.only("focus", () => undefined);', 'it.todo("someday");', 'describe.skipIf(true)("off", () => undefined);']) {
      const root = await repo();
      await write(root, "tests/math.test.ts", `${EXISTING}${added}\n`);
      commit(root);
      const result = await check(root, "");
      expect(result.status, added).toBe(1);
      expect(result.stdout, added).toContain(`tests/math.test.ts:7: added a skip, only or todo (NOT DECLARED): ${added}`);
    }
  });

  it("fails a deleted test file", async () => {
    const root = await repo();
    await unlink(path.join(root, "tests/math.test.ts"));
    commit(root);
    const result = await check(root, "");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("tests/math.test.ts:4: removed or changed an assertion (NOT DECLARED): expect(1 + 1).toBe(2);");
  });

  it("follows a renamed test file and needs the table to name its new path", async () => {
    const root = await repo();
    git(root, "mv", "tests/math.test.ts", "tests/sum.test.ts");
    await write(root, "tests/sum.test.ts", EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    commit(root);
    const named = await check(root, TABLE.replace("tests/math.test.ts", "tests/sum.test.ts"));
    expect([named.status, named.stderr]).toEqual([0, ""]);
    const old = await check(root, TABLE);
    expect(old.status).toBe(1);
    expect(old.stderr).toContain('no row with a reason for: tests/sum.test.ts.');
  });

  it("fails when the table names a different file, or names the file without a reason", async () => {
    const root = await repo({ "tests/math.test.ts": EXISTING, "tests/other.test.ts": EXISTING });
    await write(root, "tests/math.test.ts", EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    await write(root, "tests/other.test.ts", EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    commit(root);
    const partial = await check(root, TABLE);
    expect(partial.status).toBe(1);
    expect(partial.stderr).toContain('no row with a reason for: tests/other.test.ts.');
    const noReason = await check(root, `${TABLE.trimEnd()}\n| tests/other.test.ts | adds |  |\n`);
    expect(noReason.status).toBe(1);
    const both = await check(root, `${TABLE.trimEnd()}\n| tests/other.test.ts | adds | made-up reason for the fixture |\n`);
    expect([both.status, both.stderr]).toEqual([0, ""]);
  });

  it("does not read a table that sits under a later heading", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    commit(root);
    const result = await check(root, "## Tests changed\n\nNone.\n\n## Notes\n\n| File | Test | Reason |\n| --- | --- | --- |\n| tests/math.test.ts | adds | made-up |\n");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no row with a reason for: tests/math.test.ts.");
  });

  it("skips a workflow_dispatch run and says so", async () => {
    const root = await repo();
    await write(root, "tests/math.test.ts", "");
    commit(root);
    const result = await check(root, "", "workflow_dispatch");
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout.trim()).toBe("test-weakening: workflow_dispatch run: there is no pull request body to read, so the test-weakening check is skipped.");
  });
});

describe("check-test-weakening against the review's bypass forms", () => {
  const MATH = "tests/math.test.ts";
  const fails = async (root: string, kind: string) => {
    commit(root);
    const result = await check(root, "");
    expect(result.status, result.stdout).toBe(1);
    expect(result.stdout).toContain(`(NOT DECLARED)`);
    expect(result.stdout).toContain(kind);
    return result;
  };

  it("S1: fails a test file renamed so the runner no longer collects it, and passes it when the table names the new path", async () => {
    for (const renamed of ["tests/math.test.ts.off", "tests/math.disabled.ts"]) {
      const root = await repo();
      git(root, "mv", MATH, renamed);
      const result = await fails(root, `test-weakening: ${MATH}: renamed a test file (NOT DECLARED): ${MATH} -> ${renamed}`);
      expect(result.stderr).toContain('no "## Tests changed" section');
      const oldName = await check(root, TABLE);
      expect([oldName.status, oldName.stderr.includes(`no row with a reason for: ${renamed}.`)], renamed).toEqual([1, true]);
      const declared = await check(root, TABLE.replace("tests/math.test.ts", renamed));
      expect([declared.status, declared.stderr], renamed).toEqual([0, ""]);
    }
  });

  it("S1: fails a deleted test file even when it held no assertion", async () => {
    const root = await repo({ "tests/helper.ts": "export const made = 1;\n" });
    await unlink(path.join(root, "tests/helper.ts"));
    await fails(root, "test-weakening: tests/helper.ts: deleted a test file (NOT DECLARED): tests/helper.ts");
  });

  it("S2: fails an assertion split across lines whose .toBe(2) becomes .toBeDefined()", async () => {
    const split = EXISTING.replace("  expect(1 + 1).toBe(2);\n", "  expect(\n    1 + 1,\n  ).toBe(2);\n");
    const root = await repo({ [MATH]: split });
    await write(root, MATH, split.replace(").toBe(2);", ").toBeDefined();"));
    await fails(root, "test-weakening: tests/math.test.ts:6: removed or changed an assertion (NOT DECLARED): ).toBe(2);");
  });

  it("S2: fails an early return; added at the top of a test", async () => {
    const root = await repo();
    await write(root, MATH, EXISTING.replace('it("adds", () => {\n', 'it("adds", () => {\n  return;\n'));
    await fails(root, "test-weakening: tests/math.test.ts:4: added a return (NOT DECLARED): return;");
  });

  it("S2: fails it( changed to it.runIf(false)(", async () => {
    const root = await repo();
    await write(root, MATH, EXISTING.replace('it("adds", () => {', 'it.runIf(false)("adds", () => {'));
    await fails(root, 'test-weakening: tests/math.test.ts:3: added a skip, only or todo (NOT DECLARED): it.runIf(false)("adds", () => {');
  });

  it("S2: fails a test body wrapped in try/catch, re-indented or not", async () => {
    const reindented = EXISTING.replace('  expect(1 + 1).toBe(2);\n  expect(() => JSON.parse("{")).toThrow();\n', '  try {\n    expect(1 + 1).toBe(2);\n    expect(() => JSON.parse("{")).toThrow();\n  } catch {}\n');
    const flat = EXISTING.replace('  expect(1 + 1).toBe(2);\n  expect(() => JSON.parse("{")).toThrow();\n', '  try {\n  expect(1 + 1).toBe(2);\n  expect(() => JSON.parse("{")).toThrow();\n  } catch (error) {}\n');
    for (const wrapped of [reindented, flat]) {
      const root = await repo();
      await write(root, MATH, wrapped);
      await fails(root, "added a catch (NOT DECLARED): } catch");
    }
  });

  it("S2: refuses a reason shorter than 20 characters", async () => {
    const root = await repo();
    await write(root, MATH, EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    commit(root);
    const short = await check(root, TABLE.replace("the parser no longer throws on `{`, see the made-up issue", "flaky"));
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("no row with a reason for: tests/math.test.ts. A reason needs at least 20 characters.");
  });

  it("N1: reads a removed line that starts with -- inside a hunk as a removal, not a file header", async () => {
    const sql = "tests/fixtures/made-up.sql";
    const root = await repo({ [sql]: "-- assert the made-up table holds one row\nSELECT 1;\n" });
    await write(root, sql, "SELECT 1;\n");
    await fails(root, `test-weakening: ${sql}:1: removed or changed an assertion (NOT DECLARED): -- assert the made-up table holds one row`);
  });

  it("S3: tells the author that editing the body runs the check again, not to re-run it", async () => {
    const root = await repo();
    await write(root, MATH, EXISTING.replace("  expect(1 + 1).toBe(2);\n", ""));
    commit(root);
    const result = await check(root, "");
    expect(result.stderr).toContain("Editing the body runs this check again on the current body.");
    expect(result.stderr).not.toMatch(/re-run/i);
  });
});
