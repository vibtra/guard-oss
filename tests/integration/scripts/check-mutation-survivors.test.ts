import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-mutation-survivors.mjs", import.meta.url));
const FILE = "apps/made-up/src/module.ts";
const SOURCE = ['export const greet = (name: string): string => `hello ${name}`;', 'export const bytes = (text: string): Buffer => Buffer.from(text, "utf8");', ""].join("\n");
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const UTF8 = { id: "2", mutatorName: "StringLiteral", replacement: '""', location: { start: { line: 2, column: 66 }, end: { line: 2, column: 72 } } };
const GREETING = { id: "1", mutatorName: "StringLiteral", replacement: "``", location: { start: { line: 1, column: 48 }, end: { line: 1, column: 63 } } };

const RECORDED = {
  file: FILE,
  mutator: "StringLiteral",
  sourceLine: 'export const bytes = (text: string): Buffer => Buffer.from(text, "utf8");',
  original: '"utf8"',
  replacement: '""',
  reason: "Equivalent. Buffer.from(string, \"\") falls back to utf8.",
};

const check = async (mutants: Array<typeof UTF8 & { status?: string }>, survivors: unknown[]) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mutation-survivors-"));
  dirs.push(dir);
  const report = path.join(dir, "mutation.json");
  const record = path.join(dir, "survivors.json");
  await writeFile(report, JSON.stringify({ files: { [FILE]: { source: SOURCE, mutants: mutants.map((mutant) => ({ status: "Killed", ...mutant })) } } }));
  await writeFile(record, JSON.stringify({ survivors }));
  return spawnSync(process.execPath, [SCRIPT, report, record], { encoding: "utf8" });
};

describe("check-mutation-survivors", () => {
  it("passes when every surviving mutant is recorded with a reason", async () => {
    const result = await check([{ ...GREETING }, { ...UTF8, status: "Survived" }], [RECORDED]);
    expect([result.status, result.stderr, result.stdout.trim()]).toEqual([0, "", "mutation-survivors: 1 surviving mutant(s) in 1 file(s), each recorded with a reason"]);
  });

  it("fails on a surviving or uncovered mutant that is not recorded, and names where it is", async () => {
    const result = await check([{ ...GREETING, status: "NoCoverage" }, { ...UTF8, status: "Survived" }], [RECORDED]);
    expect(result.status).toBe(1);
    const lines = result.stderr.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`mutation-survivors: NoCoverage mutant at ${FILE}:1 (StringLiteral): "\`hello \${name}\`" -> "\`\`". Add a test that kills it, or record it in `);
    expect(lines[0]).toMatch(/survivors\.json with the reason no test can\.$/);
  });

  it("fails on a recorded mutant that no longer survives", async () => {
    const result = await check([{ ...UTF8 }], [RECORDED]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`mutation-survivors: ${FILE} StringLiteral ""utf8"" -> """" is recorded but no longer survives.`);
  });

  it("keeps a recorded mutant that timed out, and warns that a timeout is not a kill", async () => {
    const result = await check([{ ...UTF8, status: "Timeout" }], [RECORDED]);
    expect(result.status).toBe(0);
    expect(result.stderr.trim()).toBe(`mutation-survivors: warning: recorded mutant at ${FILE}:2 (StringLiteral) timed out. A timeout does not show that a test kills it, so the record stays.`);
  });

  it("fails on a recorded mutant without a reason", async () => {
    const result = await check([{ ...UTF8, status: "Survived" }], [{ ...RECORDED, reason: "" }]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("has no reason. Say why no test can kill it.");
  });

  it("ignores records for files this report did not mutate", async () => {
    const result = await check([{ ...UTF8, status: "Survived" }], [RECORDED, { ...RECORDED, file: "apps/made-up/src/other.ts" }]);
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });
});

describe("check-mutation-survivors against the review's bypass forms", () => {
  const run = async (options: { mutate: string[]; partial?: boolean; mutants?: Array<typeof UTF8 & { status?: string }>; summary?: boolean }) => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "mutation-survivors-config-"));
    dirs.push(dir);
    const report = path.join(dir, "mutation.json");
    const record = path.join(dir, "survivors.json");
    const config = path.join(dir, "stryker.config.json");
    const summary = path.join(dir, "summary.md");
    await writeFile(report, JSON.stringify({ files: { [FILE]: { source: SOURCE, mutants: (options.mutants ?? [{ ...UTF8, status: "Survived" }]).map((mutant) => ({ status: "Killed", ...mutant })) } } }));
    await writeFile(record, JSON.stringify({ survivors: [RECORDED] }));
    await writeFile(config, JSON.stringify({ mutate: options.mutate }));
    await writeFile(summary, "");
    const args = [SCRIPT, report, record, "--config", config, ...(options.partial ? ["--partial"] : [])];
    const result = spawnSync(process.execPath, args, { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...(options.summary ? { GITHUB_STEP_SUMMARY: summary } : {}) } });
    return { ...result, summary: await readFile(summary, "utf8") };
  };

  it("S8: fails when a mutate path matches nothing, so the file's records cannot drop out silently", async () => {
    const result = await run({ mutate: [FILE, "apps/made-up/src/renamed.ts"] });
    expect(result.status).toBe(1);
    expect(result.stderr.trim()).toMatch(/^mutation-survivors: apps\/made-up\/src\/renamed\.ts is in the mutate list of \S*stryker\.config\.json but is missing from the report, so it was not mutated\. Fix the path in the mutate list\.$/);
  });

  it("S8: refuses a glob in the mutate list, and accepts a line range on a listed file", async () => {
    const glob = await run({ mutate: ["apps/made-up/src/*.ts"] });
    expect(glob.status).toBe(1);
    expect(glob.stderr).toContain('"apps/made-up/src/*.ts" in');
    expect(glob.stderr).toContain("is a glob. List each mutated file by path");
    const ranged = await run({ mutate: [`${FILE}:1-2`] });
    expect([ranged.status, ranged.stderr]).toEqual([0, ""]);
  });

  it("S8: with --partial, a one-module run may leave other listed files out, but not mutate an unlisted one", async () => {
    const partial = await run({ mutate: [FILE, "apps/made-up/src/other.ts"], partial: true });
    expect([partial.status, partial.stderr]).toEqual([0, ""]);
    const unlisted = await run({ mutate: ["apps/made-up/src/other.ts"], partial: true });
    expect(unlisted.status).toBe(1);
    expect(unlisted.stderr).toContain(`the report mutated ${FILE}, which is not in the mutate list`);
  });

  it("N2: lists recorded survivors that timed out in the step summary", async () => {
    const result = await run({ mutate: [FILE], mutants: [{ ...UTF8, status: "Timeout" }], summary: true });
    expect(result.status).toBe(0);
    expect(result.summary).toContain("### Recorded survivors that timed out (1)");
    expect(result.summary).toContain(`| ${FILE} | 2 | StringLiteral | \`"utf8"\` | \`""\` |`);
  });
});
