import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const check = (root?: string) => spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], { encoding: "utf8" });
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
      "check-knip: packages/demo/src/index.ts exports onlyForTests through a package's main entry, and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.",
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
      "check-knip: packages/demo/src/events.ts exports zzStarTestOnly through a package's main entry, and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.",
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
      "check-knip: packages/demo/src/index.ts exports nobodyImports through a package's main entry, but nothing imports it. Drop it from the entry's exports, or delete it if nothing uses it.",
    ]);
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
