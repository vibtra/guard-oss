import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { COMMENTS_CONFIG, ESLINT_TIMEOUT, lintText, root } from "./cli";

type KeptCase = { name: string; file: string; source: string; kept: string[]; plain: string[] };

const { cases } = JSON.parse(readFileSync(new URL("kept-comment-forms.json", import.meta.url), "utf8")) as { cases: KeptCase[] };

const offsetOf = (source: string, line: number, column: number) => {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  const start = starts[line - 1];
  if (start === undefined) throw new Error(`line ${line} is past the end of the source`);
  return start + column - 1;
};

describe.concurrent("vibtra/no-comments keeps the forms shared with e3's prove", ESLINT_TIMEOUT, () => {
  it("has one text for every copy of the shared module and of the shared cases", () => {
    const groups = [
      ["tools/eslint/rules/kept-comments.mjs", "tools/no-comments/lib/kept-comments.mjs"],
      ["tests/integration/eslint/kept-comment-forms.json", "tests/integration/no-comments/kept-comment-forms.json"],
    ];
    for (const copies of groups) {
      const present = copies.filter((file) => existsSync(path.join(root, file)));
      expect(present).toContain(copies[0]);
      expect(new Set(present.map((file) => readFileSync(path.join(root, file), "utf8"))).size, present.join(" and ")).toBe(1);
    }
  });

  for (const { name, file, source, plain } of cases) {
    it(`${file}: ${name}`, async () => {
      const result = await lintText(source, `tests/integration/eslint/samples/${file}`, { config: COMMENTS_CONFIG });
      expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
      const reported = result.messages
        .filter((message) => message.ruleId === "vibtra/no-comments")
        .map((message) => source.slice(offsetOf(source, message.line, message.column), offsetOf(source, message.endLine ?? message.line, message.endColumn ?? message.column)));
      expect([...reported].sort()).toEqual([...plain].sort());
    });
  }
});
