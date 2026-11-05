import { describe, expect, it } from "vitest";
import { ESLINT_TIMEOUT, lines, lintText } from "./cli";

const PALETTE = "vibtra/no-palette-colour";
const RAW = "vibtra/no-raw-colour";

const at = (code: string, needle: string) => {
  const index = code.indexOf(needle);
  expect(index, needle).not.toBe(-1);
  const before = code.slice(0, index).split("\n");
  return `${before.length}:${(before.at(-1) ?? "").length + 1}`;
};

const fences = async (file: string, code: string) => {
  const result = await lintText(code, file);
  expect(result.messages.filter((message) => message.fatal === true)).toEqual([]);
  return result.messages
    .filter((message) => message.ruleId === PALETTE || message.ruleId === RAW)
    .map((message) => `${message.ruleId} ${message.line}:${message.column}`)
    .sort();
};

describe.concurrent("colour fences", ESLINT_TIMEOUT, () => {
  it("the Guard console names no Tailwind palette colour outside comments", async () => {
    const code = lines(
      "export const Badge = () => <span className=\"bg-red-500 text-white\">x</span>;",
      "export const token = \"bg-[var(--v-surface)] text-foreground ring-ring\";",
      "// bg-blue-500 in a comment is allowed",
      "/* border-gray-200 too */",
      "export const hover = \"hover:border-slate-300/50\";",
    );
    expect(await fences("apps/guard-console/src/fence-sample.tsx", code)).toEqual(
      [`${PALETTE} ${at(code, "bg-red-500")}`, `${PALETTE} ${at(code, "text-white")}`, `${PALETTE} ${at(code, "border-slate-300/50")}`].sort(),
    );
  });

  it("the Guard console writes no raw colour value outside comments", async () => {
    const code = lines(
      "export const a = \"#fff\";",
      "export const b = \"rgb(0 0 0)\";",
      "export const c = `hsla(0, 0%, 0%, .5)`;",
      "export const d = { color: \"oklch(70% 0.1 200)\" };",
      "export const e = \"var(--v-ink)\";",
      "// #000 and rgb( in a comment are allowed",
    );
    expect(await fences("apps/guard-console/src/fence-sample.ts", code)).toEqual(
      [`${RAW} ${at(code, "#fff")}`, `${RAW} ${at(code, "rgb(")}`, `${RAW} ${at(code, "hsla(")}`, `${RAW} ${at(code, "oklch(")}`].sort(),
    );
  });

  it("index.css may give a raw value to a --g- token and nowhere else", async () => {
    const sheet = lines(
      "@import \"@vibtra/ui/theme.css\";",
      ":root {",
      "  --g-muted: #6e6e6e;",
      "  --g-shadow: rgb(0 0 0 / 10%);",
      "  --v-ink: #111111;",
      "}",
      "/* #222222 in a comment is allowed */",
      ".badge {",
      "  color: #333333;",
      "  @apply bg-red-500;",
      "}",
    );
    expect(await fences("apps/guard-console/src/index.css", sheet)).toEqual(
      [`${RAW} ${at(sheet, "#111111")}`, `${RAW} ${at(sheet, "#333333")}`, `${PALETTE} ${at(sheet, "bg-red-500")}`].sort(),
    );
    const other = lines(":root {", "  --g-muted: #6e6e6e;", "}");
    expect(await fences("apps/guard-console/src/other.css", other)).toEqual([`${RAW} ${at(other, "#6e6e6e")}`]);
  });

  it("the fences cover only the Guard console", async () => {
    const code = lines("export const a = <span className=\"bg-red-500\" style={{ color: \"#fff\" }} />;");
    expect(await fences("packages/ui/src/fence-sample.tsx", code)).toEqual([]);
  });
});
