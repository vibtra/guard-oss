import { describe, expect, it } from "vitest";
import { COMMENTS_CONFIG, ESLINT_TIMEOUT, FENCES_CONFIG, lines, lintText } from "./cli";

const GUARD = "@eslint-community/eslint-comments/no-restricted-disable";

const errors = async (code: string, file: string, config?: string) => {
  const result = await lintText(code, file, { config });
  return result.messages.filter((message) => message.severity === 2).map((message) => `${message.ruleId} ${message.line}`);
};

const plainNote = { file: "packages/demo/src/a.ts", rule: "vibtra/no-comments", line: 2 };
const palette = { file: "apps/guard-console/src/b.tsx", rule: "vibtra/no-palette-colour", line: 2 };
const raw = { file: "apps/guard-console/src/c.tsx", rule: "vibtra/no-raw-colour", line: 2 };

const disables = [
  { ...plainNote, name: "a file-wide disable of no-comments", code: lines("/* eslint-disable vibtra/no-comments -- keep notes */", "// a plain note", "export const a = 1;") },
  {
    ...palette,
    name: "a next-line disable of a colour fence",
    code: lines("// eslint-disable-next-line vibtra/no-palette-colour -- needed here", "export const c = \"bg-red-500\";"),
  },
  {
    ...raw,
    name: "a next-line disable of two colour fences",
    code: lines("// eslint-disable-next-line vibtra/no-raw-colour, vibtra/no-palette-colour -- probe", "export const c = \"#ff0000\";"),
  },
];

const bypasses = [
  { ...plainNote, name: "a blanket disable", code: lines("/* eslint-disable -- all */", "// a plain note", "export const a = 1;") },
  { ...plainNote, name: "an inline rule config", code: lines("/* eslint vibtra/no-comments: \"off\" -- quiet */", "// a plain note", "export const a = 1;") },
  {
    ...plainNote,
    name: "a disable that also names the guard rule",
    code: lines(`/* eslint-disable ${GUARD}, vibtra/no-comments -- quiet */`, "// a plain note", "export const a = 1;"),
  },
];

describe.concurrent("an inline directive cannot turn off a vibtra rule", ESLINT_TIMEOUT, () => {
  for (const { name, code, file, rule, line } of [...disables, ...bypasses]) {
    const config = rule === "vibtra/no-comments" ? COMMENTS_CONFIG : FENCES_CONFIG;
    it(`${name}: ${config} still reports ${rule}`, async () => {
      expect(await errors(code, file, config)).toContain(`${rule} ${line}`);
    });
  }

  for (const { name, code, file } of disables) {
    it(`${name}: the root config reports the directive`, async () => {
      expect((await errors(code, file)).some((entry) => entry.startsWith(`${GUARD} `))).toBe(true);
    });
  }

  it("the root config still allows a directive for a rule outside vibtra", async () => {
    expect(await errors(lines("eval(\"1\");"), "packages/demo/src/d.ts")).toEqual(["no-eval 1"]);
    const code = lines("// eslint-disable-next-line no-eval -- example", "eval(\"1\");");
    expect(await errors(code, "packages/demo/src/d.ts")).toEqual([]);
  });
});
