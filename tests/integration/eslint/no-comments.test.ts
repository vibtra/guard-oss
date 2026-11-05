import ts from "typescript";
import { describe, expect, it } from "vitest";
import { COMMENTS_CONFIG, ESLINT_TIMEOUT, ignoredDirective, lines, lintText } from "./cli";

const RULE = "vibtra/no-comments";
const sample = (name: string) => `tests/integration/eslint/samples/${name}`;

const reportedLines = async (name: string, code: string) => {
  const result = await lintText(code, sample(name), { config: COMMENTS_CONFIG });
  expect(result.messages.filter((message) => message.ruleId !== RULE && !ignoredDirective(message)), name).toEqual([]);
  return result.messages.filter((message) => message.ruleId === RULE).map((message) => message.line);
};

const fix = async (name: string, code: string) => {
  const result = await lintText(code, sample(name), { config: COMMENTS_CONFIG, fix: true });
  expect(result.messages.filter((message) => !ignoredDirective(message)), name).toEqual([]);
  return result.output ?? code;
};

const emitted = (name: string, code: string) =>
  ts.transpileModule(code, {
    fileName: name,
    compilerOptions: { removeComments: true, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ESNext },
  }).outputText;

describe.concurrent("vibtra/no-comments", ESLINT_TIMEOUT, () => {
  const kept: Record<string, string> = {
    "spdx.ts": lines("// SPDX-License-Identifier: Apache-2.0", "// Copyright 2026 Example Corp", "export const a = 1;"),
    "apache.ts": lines(
      "// Copyright 2026 Example Corp",
      "//",
      "// Licensed under the Apache License, Version 2.0 (the \"License\");",
      "// you may not use this file except in compliance with the License.",
      "//",
      "// Unless required by applicable law or agreed to in writing, software",
      "// distributed under the License is distributed on an \"AS IS\" BASIS,",
      "// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.",
      "export const a = 1;",
    ),
    "bang.ts": lines("/*! example-widget 1.0.0 | MIT */", "export const a = 1;"),
    "license.ts": lines("/**", " * @license MIT", " * Example Corp", " */", "export const a = 1;"),
    "provenance.ts": lines("// Provenance: adapted from example-widget 1.0.0 (MIT),", "// example.test/widget, parser removed.", "export const a = 1;"),
    "prose-first.ts": lines("// The widget store.", "// SPDX-License-Identifier: MIT", "export const a = 1;"),
    "shebang.mjs": lines("#!/usr/bin/env node", "// SPDX-License-Identifier: MIT", "export const a = 1;"),
    "shebang.ts": lines("#!/usr/bin/env node", "// SPDX-License-Identifier: MIT", "export const a: number = 1;"),
    "directives.ts": lines(
      "/// <reference types=\"node\" />",
      "// @ts-nocheck",
      "/* eslint-disable no-console */",
      "// eslint-disable-next-line no-console -- example",
      "console.log(1);",
      "/* eslint-enable no-console */",
      "// @ts-expect-error the value is a string",
      "const n: number = \"1\";",
      "// prettier-ignore",
      "const m = [1,2];",
      "/* c8 ignore next */",
      "/* v8 ignore start */",
      "/* istanbul ignore else */",
      "export const p = /*#__PURE__*/ make(n, m);",
      "export const q = /* @__PURE__ */ make(n, m);",
      "export const r = import(/* webpackChunkName: \"r\" */ \"./r.js\");",
      "export const s = import(/* webpackPrefetch: true, webpackChunkName: \"s\" */ /* webpackMode: \"lazy\" */ \"./s.js\");",
      "export const t = import(/* @vite-ignore */ String(m));",
      "//# sourceMappingURL=data:application/json;base64,e30=",
    ),
    "types.mjs": lines(
      "/** @import { Widget } from \"./widget.js\" */",
      "/** @typedef {{ id: string }} Row */",
      "/** @type {number} */",
      "export const count = 1;",
      "/**",
      " * @template T",
      " * @param {T} value",
      " * @returns {T}",
      " */",
      "export const same = (value) => value;",
      "export const row = /** @satisfies {Row} */ ({ id: \"a\" });",
    ),
  };
  for (const [name, code] of Object.entries(kept)) {
    it(`keeps every exception kind: ${name}`, async () => {
      expect(await reportedLines(name, code)).toEqual([]);
    });
  }

  it("reports every other comment", async () => {
    const reported = lines(
      "// SPDX-License-Identifier: MIT",
      "// The widget store.",
      "/* It keeps rows in memory. */",
      "import { a } from \"./a.js\";",
      "// a normal line comment",
      "export const b = a; // trailing",
      "/** @param {string} s */",
      "export const c = (s: string) => s;",
      "// @ts-ignore is not a listed directive",
      "/* global window */",
      "// see eslint-disable for details",
      "// SPDX-License-Identifier: MIT",
    );
    expect(await reportedLines("reported.ts", reported)).toEqual([2, 3, 5, 6, 7, 9, 10, 11, 12]);
    expect(await reportedLines("prose.mjs", lines("/**", " * Counts rows.", " */", "export const count = 1;"))).toEqual([1]);
  });

  it("a header ends where licence text ends", async () => {
    const header = lines(
      "// SPDX-License-Identifier: MIT",
      "// Copyright 2026 Example Corp",
      "//",
      "// Licensed under the MIT licence; see LICENSE.",
      "//",
      "// The widget store.",
      "export const a = 1;",
    );
    expect(await reportedLines("header.ts", header)).toEqual([5, 6]);
    expect(await reportedLines("late.ts", lines("// The widget store.", "", "// SPDX-License-Identifier: MIT", "export const a = 1;"))).toEqual([1, 3]);
    expect(await reportedLines("after-code.ts", lines("export const a = 1;", "// SPDX-License-Identifier: MIT"))).toEqual([2]);
  });

  it("the fix removes lines and spaces and keeps the emitted JavaScript", async () => {
    const input = lines(
      "// SPDX-License-Identifier: MIT",
      "import { h } from \"./h.js\";",
      "",
      "// a whole line",
      "/* a whole",
      "   block */",
      "let/*joined*/value = h(1);",
      "export const sum = value +/*plus*/+value;",
      "export function early() {",
      "  return /* a line",
      "  break */ value;",
      "}",
      "export const list = [1, /* inline */ 2,/*tight*/3];   // trailing",
      "export const kind = typeof/*t*/value;",
      "export const re = /a\\/b/ /* after a regex */ .test(\"a/b\");",
      "export const tpl = `${/* in a template */ value}`;",
      "/* leading */ export const lead = 1;",
      "export type Pair</* generic */ T> = [T, T];",
    );
    const output = await fix("fix.ts", input);
    expect(output).toBe(
      lines(
        "// SPDX-License-Identifier: MIT",
        "import { h } from \"./h.js\";",
        "",
        "let value = h(1);",
        "export const sum = value + +value;",
        "export function early() {",
        "  return",
        "  value;",
        "}",
        "export const list = [1, 2,3];",
        "export const kind = typeof value;",
        "export const re = /a\\/b/ .test(\"a/b\");",
        "export const tpl = `${value}`;",
        "export const lead = 1;",
        "export type Pair< T> = [T, T];",
      ),
    );
    expect(emitted("fix.ts", output)).toBe(emitted("fix.ts", input));
  });

  it("the fix leaves no blank line where a comment paragraph was", async () => {
    const input = lines(
      "// a file note",
      "",
      "export const a = 1;",
      "",
      "// a note between blank lines",
      "",
      "export function f() {",
      "  // a note at the block start",
      "",
      "  return a;",
      "",
      "  // a note at the block end",
      "}",
    );
    expect(await fix("blank.ts", input)).toBe(lines("export const a = 1;", "", "export function f() {", "  return a;", "}"));
  });

  it("the fix keeps JSX children and line endings", async () => {
    const input = lines(
      "export const View = () => (",
      "  <div>",
      "    {/* on its own line */}",
      "    <span>Hello</span>",
      "    Hello",
      "    {/* between two text lines */}",
      "    world",
      "    <b>a {/* inline */} b</b>",
      "  </div>",
      ");",
    );
    const output = await fix("view.tsx", input);
    expect(output).toBe(
      lines("export const View = () => (", "  <div>", "    <span>Hello</span>", "    Hello", "    {}", "    world", "    <b>a {} b</b>", "  </div>", ");"),
    );
    expect(emitted("view.tsx", output)).toBe(emitted("view.tsx", input));
    expect(await fix("crlf.ts", "// a\r\nexport const x = 1; // b\r\n")).toBe("export const x = 1;\r\n");
  });

  it("the fix removes a long comment run in one pass", async () => {
    const run = Array.from({ length: 1500 }, (_, index) => `// line ${index}`);
    expect(await fix("run.ts", lines(...run, "export const a = 1;"))).toBe(lines("export const a = 1;"));
  });
});
