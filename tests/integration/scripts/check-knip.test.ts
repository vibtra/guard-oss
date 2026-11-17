import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-knip.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "fixture", private: true, type: "module" }),
  "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "tests"\n',
  "knip.json": JSON.stringify({ workspaces: { tests: { entry: ["**/*.test.ts"] } } }),
  "packages/demo/package.json": JSON.stringify({ name: "@fixture/demo", type: "module", main: "src/index.ts", dependencies: { "left-pad": "1.3.0" } }),
  "packages/demo/src/index.ts": 'export { used } from "./util.ts";\nexport const onlyForTests = 2;\n',
  "packages/demo/src/util.ts": "export const used = 1;\nexport const neverImported = 3;\n",
  "packages/demo/src/orphan.ts": "export const lost = 4;\n",
  "apps/web/package.json": JSON.stringify({ name: "@fixture/web", type: "module", main: "src/index.ts" }),
  "apps/web/src/index.ts": 'import { used } from "../../../packages/demo/src/index.ts";\nconsole.log(used);\n',
  "tests/package.json": JSON.stringify({ name: "@fixture/tests", type: "module" }),
  "tests/demo.test.ts": 'import { onlyForTests, used } from "../packages/demo/src/index.ts";\nexport const sum = onlyForTests + used;\n',
};

const tree = async (extra: Record<string, string> = {}) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "check-knip-"));
  roots.push(root);
  for (const [file, text] of Object.entries({ ...FILES, ...extra })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
};

const check = (root?: string, ...flags: string[]) =>
  spawnSync(process.execPath, root === undefined ? [SCRIPT, ...flags] : [SCRIPT, root, ...(flags.length === 0 ? ["--base", "none"] : flags)], { encoding: "utf8" });
const git = (root: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
const errors = (result: ReturnType<typeof check>) => result.stderr.trim().split("\n").filter(Boolean).sort();

const REASON = "fixture: accepted for this test only";
const FULL_BASELINE = {
  entries: [
    { kind: "files", file: "packages/demo/src/orphan.ts", reason: REASON },
    { kind: "dependencies", file: "packages/demo/package.json", names: ["left-pad"], reason: REASON },
    { kind: "exports", file: "packages/demo/src/util.ts", names: ["neverImported"], reason: REASON },
    { kind: "testOnly", file: "packages/demo/src/index.ts", names: ["onlyForTests"], reason: REASON },
  ],
};

describe("check-knip", () => {
  it("passes this repository against knip-baseline.json", { timeout: 300_000 }, () => {
    const result = check();
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails an unused file, an unused dependency, an unused export and a test-only main-entry export, and says what to do", { timeout: 120_000 }, async () => {
    const result = check(await tree());
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      "check-knip: packages/demo/package.json lists left-pad in dependencies but nothing imports it. Remove it from package.json.",
      "check-knip: packages/demo/src/index.ts exports onlyForTests through a package entry (an exports key in package.json), and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.",
      "check-knip: packages/demo/src/orphan.ts is not imported from any entry. Delete it, or import it where it is needed.",
      "check-knip: packages/demo/src/util.ts exports neverImported but nothing imports it. Drop the export keyword, or delete it if nothing uses it.",
    ]);
  });

  it("B1: fails an export that reaches a main entry through export * and only tests import", { timeout: 120_000 }, async () => {
    const result = check(
      await tree({
        "packages/demo/src/index.ts": 'export { used } from "./util.ts";\nexport * from "./events.ts";\nexport const onlyForTests = 2;\n',
        "packages/demo/src/events.ts": "export const zzStarTestOnly = 5;\nexport const eventUsed = 6;\n",
        "apps/web/src/index.ts": 'import { eventUsed, used } from "../../../packages/demo/src/index.ts";\nconsole.log(used + eventUsed);\n',
        "tests/demo.test.ts": 'import { onlyForTests, used, zzStarTestOnly } from "../packages/demo/src/index.ts";\nexport const sum = onlyForTests + used + zzStarTestOnly;\n',
        "knip-baseline.json": JSON.stringify(FULL_BASELINE),
      }),
    );
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      "check-knip: packages/demo/src/events.ts exports zzStarTestOnly through a package entry (an exports key in package.json), and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.",
    ]);
  });

  it("S2: fails an unused export in a package's main entry", { timeout: 120_000 }, async () => {
    const result = check(
      await tree({
        "packages/demo/src/index.ts": 'export { used } from "./util.ts";\nexport const onlyForTests = 2;\nexport const nobodyImports = 7;\n',
        "knip-baseline.json": JSON.stringify(FULL_BASELINE),
      }),
    );
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      "check-knip: packages/demo/src/index.ts exports nobodyImports through a package entry (an exports key in package.json), but nothing imports it. Drop it from the entry's exports, or delete it if nothing uses it.",
    ]);
  });

  it("R5: checks every exports key except ./testing and ./package.json, not only the main entry", { timeout: 120_000 }, async () => {
    const result = check(
      await tree({
        "packages/demo/package.json": JSON.stringify({
          name: "@fixture/demo",
          type: "module",
          exports: { ".": "./src/index.ts", "./signing": { types: "./src/signing.ts", default: "./src/signing.ts" }, "./testing": "./src/testing.ts", "./package.json": "./package.json" },
          dependencies: { "left-pad": "1.3.0" },
        }),
        "packages/demo/src/signing.ts": "export const signUsed = 8;\nexport const signTestOnly = 9;\nexport const signUnused = 10;\n",
        "packages/demo/src/testing.ts": "export const fixtureHelper = 11;\n",
        "apps/web/src/index.ts": 'import { used } from "../../../packages/demo/src/index.ts";\nimport { signUsed } from "../../../packages/demo/src/signing.ts";\nconsole.log(used + signUsed);\n',
        "tests/demo.test.ts":
          'import { onlyForTests, used } from "../packages/demo/src/index.ts";\nimport { signTestOnly } from "../packages/demo/src/signing.ts";\nimport { fixtureHelper } from "../packages/demo/src/testing.ts";\nexport const sum = onlyForTests + used + signTestOnly + fixtureHelper;\n',
        "knip-baseline.json": JSON.stringify(FULL_BASELINE),
      }),
    );
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual([
      "check-knip: packages/demo/src/signing.ts exports signTestOnly through a package entry (an exports key in package.json), and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.",
      "check-knip: packages/demo/src/signing.ts exports signUnused through a package entry (an exports key in package.json), but nothing imports it. Drop it from the entry's exports, or delete it if nothing uses it.",
    ]);
  });

  it("R4: --write-baseline removes fixed findings and never adds a new one", { timeout: 120_000 }, async () => {
    const root = await tree({
      "knip-baseline.json": JSON.stringify({
        about: "fixture",
        entries: [
          ...FULL_BASELINE.entries.filter((entry) => entry.kind !== "dependencies"),
          { kind: "exports", file: "packages/demo/src/util.ts", names: ["fixedSinceThen"], reason: "fixture: fixed since the baseline was written" },
        ],
      }),
    });
    const result = check(root, "--write-baseline");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("removed 1 fixed findings from knip-baseline.json; --write-baseline never adds one");
    expect(errors(result)).toEqual([
      "check-knip: not in the baseline, so fix it or add a new entry with its own reason by hand: packages/demo/package.json lists left-pad in dependencies but nothing imports it. Remove it from package.json.",
    ]);
    const written = JSON.parse(await readFile(path.join(root, "knip-baseline.json"), "utf8")) as { entries: Array<{ kind: string; names?: string[] }> };
    expect(written.entries.flatMap((entry) => entry.names ?? [entry.kind])).toEqual(["files", "neverImported", "onlyForTests"]);
  });

  it("R4: a name added to an entry origin/main has fails, as does a new entry that copies a reason from origin/main; a new entry with its own reason passes", { timeout: 300_000 }, async () => {
    const util = "export const used = 1;\nexport const neverImported = 3;\nexport const alsoUnused = 12;\n";
    const root = await tree({ "packages/demo/src/util.ts": util, "knip-baseline.json": JSON.stringify(FULL_BASELINE) });
    git(root, "init", "--quiet", "--initial-branch=main");
    git(root, "add", "-A");
    git(root, "commit", "--quiet", "-m", "base");
    const withEntries = async (entries: Array<Record<string, unknown>>) => {
      await writeFile(path.join(root, "knip-baseline.json"), JSON.stringify({ entries: [...FULL_BASELINE.entries.filter((entry) => entry.kind !== "exports"), ...entries] }));
      return check(root, "--base", "main");
    };
    expect(errors(await withEntries([{ kind: "exports", file: "packages/demo/src/util.ts", names: ["neverImported", "alsoUnused"], reason: REASON }]))).toEqual([
      "knip-baseline.json: the exports entry for packages/demo/src/util.ts gained alsoUnused, which main's baseline does not list under that reason. Fix the finding, or put it in a new entry with a reason of its own (at least 20 characters), so the addition is reviewed.",
    ]);
    const copied = [
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["neverImported"], reason: REASON },
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["alsoUnused"], reason: REASON },
    ];
    expect(errors(await withEntries(copied))).toEqual([
      "knip-baseline.json: the exports entry for packages/demo/src/util.ts gained alsoUnused, which main's baseline does not list under that reason. Fix the finding, or put it in a new entry with a reason of its own (at least 20 characters), so the addition is reviewed.",
    ]);
    const own = [
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["neverImported"], reason: REASON },
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["alsoUnused"], reason: "fixture: accepted for this test only, honestly" },
      { kind: "files", file: "packages/demo/src/orphan.ts", reason: "fixture: a reason of its own for the orphan" },
    ];
    expect((await withEntries(own)).status).toBe(0);
    const reused = [
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["neverImported"], reason: REASON },
      { kind: "exports", file: "packages/demo/src/util.ts", names: ["alsoUnused"], reason: "fixture: accepted for this test only, honestly" },
      { kind: "testOnly", file: "packages/demo/src/elsewhere.ts", names: [], reason: REASON },
    ];
    expect(errors(await withEntries(reused))).toEqual([
      "knip-baseline.json: the new testOnly entry for packages/demo/src/elsewhere.ts reuses a reason from main's baseline. Write a reason of its own (at least 20 characters) that says why these findings stay, so the addition is reviewed.",
    ]);
  });

  it("R4: fails when the base ref cannot be read, instead of skipping the check", { timeout: 120_000 }, async () => {
    const result = check(await tree({ "knip-baseline.json": JSON.stringify(FULL_BASELINE) }), "--base", "origin/main");
    expect(result.status).toBe(1);
    expect(errors(result)).toEqual(["check-knip: cannot read origin/main, which new baseline names are checked against. Fetch it first (git fetch origin main), or pass --base <ref>."]);
  });

  it("passes when every finding is in the baseline with a reason", { timeout: 120_000 }, async () => {
    const result = check(await tree({ "knip-baseline.json": JSON.stringify(FULL_BASELINE) }));
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails a baseline entry with no reason, and a stale entry knip no longer finds", { timeout: 120_000 }, async () => {
    const baseline = {
      entries: [
        ...FULL_BASELINE.entries.slice(1),
        { kind: "files", file: "packages/demo/src/orphan.ts", reason: "" },
        { kind: "exports", file: "packages/demo/src/util.ts", names: ["removedLongAgo"], reason: REASON },
      ],
    };
    expect(errors(check(await tree({ "knip-baseline.json": JSON.stringify(baseline) })))).toEqual([
      'check-knip: knip-baseline.json still lists "exports packages/demo/src/util.ts removedLongAgo", which knip no longer finds. Remove it from the baseline.',
      "knip-baseline.json: the files entry for packages/demo/src/orphan.ts has no reason. Write why it stays, or fix the finding.",
    ]);
  });
});
