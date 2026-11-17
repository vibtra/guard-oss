import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-migrations.mjs", import.meta.url));
const DIR = "apps/registry/migrations";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (root: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });

const ALLOW = { duplicates: { "0002": { files: ["0002_a.sql", "0002_b.sql"], reason: "fixture: shipped together before the check existed" } } };

const repo = async (files: Record<string, string>) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-migrations-"));
  roots.push(root);
  await mkdir(path.join(root, DIR), { recursive: true });
  await writeFile(path.join(root, "allow.json"), JSON.stringify(ALLOW));
  for (const [file, text] of Object.entries(files)) await writeFile(path.join(root, DIR, file), text);
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "main");
  git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
  return root;
};

const MAIN = { "0001_init.sql": "create table a ();\n", "0002_a.sql": "select 1;\n", "0002_b.sql": "select 2;\n", "0003_more.sql": "select 3;\n" };

const check = (root: string, ...extra: string[]) => spawnSync(process.execPath, [SCRIPT, root, "--allow", path.join(root, "allow.json"), ...extra], { encoding: "utf8" });
const errors = (result: ReturnType<typeof check>) => result.stderr.trim().split("\n");

describe("check-migrations", () => {
  it("passes this repository, with 0051 grandfathered", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--base", "HEAD"], { encoding: "utf8" });
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("numbers unique");
  });

  it("passes a branch that adds the next number", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "0004_next.sql"), "select 4;\n");
    expect([check(root).status, check(root).stderr]).toEqual([0, ""]);
  });

  it("fails a duplicate number that is not grandfathered, and says to renumber", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "0004_one.sql"), "select 4;\n");
    await writeFile(path.join(root, DIR, "0004_two.sql"), "select 5;\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      `check-migrations: ${DIR}/0004_one.sql and ${DIR}/0004_two.sql share the number 0004. Renumber the new one to the next free number above the highest on origin/main.`,
    ]);
  });

  it("fails a third file on a grandfathered number", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "0002_c.sql"), "select 6;\n");
    expect(errors(check(root))).toEqual([
      `check-migrations: ${DIR}/0002_a.sql and ${DIR}/0002_b.sql and ${DIR}/0002_c.sql share the number 0002. Renumber the new one to the next free number above the highest on origin/main.`,
      `check-migrations: ${DIR}/0002_c.sql is new but its number 0002 is not above 0003, the highest on origin/main. Another branch took that number first: renumber it above 0003.`,
    ]);
  });

  it("fails a new migration numbered at or below the highest on origin/main (two branches took the same number)", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "0003_clash.sql"), "select 7;\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(errors(result)).toContain(
      `check-migrations: ${DIR}/0003_clash.sql is new but its number 0003 is not above 0003, the highest on origin/main. Another branch took that number first: renumber it above 0003.`,
    );
  });

  it("fails an edit, a rename or a delete of a migration that is on origin/main", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "0001_init.sql"), "create table b ();\n");
    await unlink(path.join(root, DIR, "0003_more.sql"));
    await writeFile(path.join(root, DIR, "0004_more.sql"), "select 3;\n");
    const result = check(root);
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      `check-migrations: ${DIR}/0001_init.sql differs from origin/main. A shipped migration has already run on real databases; revert the edit and put the change in a new migration numbered above 0003.`,
      `check-migrations: ${DIR}/0003_more.sql is on origin/main but is gone here (deleted or renamed). A shipped migration has already run on real databases; restore it and add a new migration instead.`,
    ]);
  });

  it("fails a badly named file and a grandfathered entry with no reason", async () => {
    const root = await repo(MAIN);
    await writeFile(path.join(root, DIR, "4_Bad.sql"), "select 8;\n");
    await writeFile(path.join(root, "allow.json"), JSON.stringify({ duplicates: { "0002": { files: ["0002_a.sql", "0002_b.sql"], reason: "" } } }));
    expect(errors(check(root))).toEqual([
      "check-migrations: allow.json grandfathers 0002 with no reason. Write why the duplicate is safe to keep.",
      `check-migrations: ${DIR}/4_Bad.sql is not named NNNN_snake_case.sql. Rename it to the next free four-digit number and a lowercase name.`,
    ]);
  });

  it("fails when the base ref is missing, and says to fetch it", async () => {
    const root = await repo(MAIN);
    expect(errors(check(root, "--base", "origin/nope"))).toEqual(["check-migrations: cannot read origin/nope. Fetch it first (git fetch origin main), or pass --base <ref>."]);
  });
});
