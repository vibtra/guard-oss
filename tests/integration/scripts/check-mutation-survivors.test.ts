import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
