import { execFile, execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, describe, expect, it } from "vitest";

const tool = fileURLToPath(new URL("../../../tools/no-comments/", import.meta.url));
const lines = (...rows: string[]) => `${rows.join("\n")}\n`;
const CLI_TIMEOUT = { timeout: 300_000 };
const scratch: string[] = [];
const home = mkdtempSync(join(tmpdir(), "no-comments-home-"));
scratch.push(home);
writeFileSync(join(home, "gitconfig"), "");
const env = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Example Tester",
  GIT_AUTHOR_EMAIL: "tester@example.com",
  GIT_COMMITTER_NAME: "Example Tester",
  GIT_COMMITTER_EMAIL: "tester@example.com",
};

afterAll(() => scratch.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

const git = (dir: string, ...args: string[]) => execFileSync("git", args, { cwd: dir, env, encoding: "utf8" });

function write(dir: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
}

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "no-comments-"));
  scratch.push(dir);
  git(dir, "init", "-q", "-b", "main");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

const read = (dir: string, name: string) => readFileSync(join(dir, name), "utf8");

type Run = { status: number; stdout: string; stderr: string };

async function run(dir: string, script: string, ...args: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [join(tool, script), ...args], { cwd: dir, env });
    return { status: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout: string; stderr: string };
    if (typeof failed.code !== "number") throw error;
    return { status: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

const cli = (dir: string, ...args: string[]) => run(dir, "cli.mjs", ...args);
const rowFor = (output: string, file: string) => output.split("\n").find((row) => row.endsWith(` ${file}`) || row.includes(` ${file}  `));

type Language = { language: string; file: string; source: string; found: string[]; fixed: string; seeded: [string, string] };

const languages: Language[] = [
  {
    language: "go",
    file: "main.go",
    source: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "",
      "//go:build linux",
      "",
      "package main",
      "",
      "/*",
      "#include <stdio.h>",
      "*/",
      'import "C"',
      "",
      'import "embed"',
      "",
      "//go:embed data.txt",
      "var data embed.FS",
      "",
      "// limit is the retry ceiling.",
      "const limit = 42 // seconds",
      "",
      "//nolint:unused",
      "func helper() int { return limit /* inline */ + 1 }",
    ),
    found: ["main.go:18: // limit is the retry ceiling.", "main.go:19: // seconds", "main.go:22: /* inline */"],
    fixed: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "",
      "//go:build linux",
      "",
      "package main",
      "",
      "/*",
      "#include <stdio.h>",
      "*/",
      'import "C"',
      "",
      'import "embed"',
      "",
      "//go:embed data.txt",
      "var data embed.FS",
      "",
      "const limit = 42",
      "",
      "//nolint:unused",
      "func helper() int { return limit + 1 }",
    ),
    seeded: ["const limit = 42", "const limit = 43"],
  },
  {
    language: "rust",
    file: "src/lib.rs",
    source: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "//! Crate notes that are prose.",
      "",
      "/// Adds the offset.",
      "pub fn add(value: u32) -> u32 {",
      "    // whole line",
      "    value + 7 // trailing",
      "}",
      "",
      'pub const NAME: &str = /* inline */ "sample";',
    ),
    found: [
      "src/lib.rs:3: //! Crate notes that are prose.",
      "src/lib.rs:5: /// Adds the offset.",
      "src/lib.rs:7: // whole line",
      "src/lib.rs:8: // trailing",
      "src/lib.rs:11: /* inline */",
    ],
    fixed: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "",
      "pub fn add(value: u32) -> u32 {",
      "    value + 7",
      "}",
      "",
      'pub const NAME: &str = "sample";',
    ),
    seeded: ['"sample"', '"example"'],
  },
  {
    language: "swift",
    file: "App.swift",
    source: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "//",
      "// Prose about the app.",
      "",
      "import Foundation",
      "",
      "// swiftlint:disable:next identifier_name",
      "let id = 5 // trailing",
      "",
      "/// Doc comment.",
      "func greet() -> String {",
      '    return /* inline */ "hello"',
      "}",
    ),
    found: [
      "App.swift:3: //",
      "App.swift:4: // Prose about the app.",
      "App.swift:9: // trailing",
      "App.swift:11: /// Doc comment.",
      "App.swift:13: /* inline */",
    ],
    fixed: lines(
      "// SPDX-License-Identifier: Apache-2.0",
      "// Copyright 2026 Example Authors",
      "",
      "import Foundation",
      "",
      "// swiftlint:disable:next identifier_name",
      "let id = 5",
      "",
      "func greet() -> String {",
      '    return "hello"',
      "}",
    ),
    seeded: ["let id = 5", "let id = 6"],
  },
  {
    language: "python",
    file: "tool.py",
    source: lines(
      "#!/usr/bin/env python3",
      "# -*- coding: utf-8 -*-",
      "# SPDX-License-Identifier: Apache-2.0",
      "# Copyright 2026 Example Authors",
      "",
      "import os  # noqa: F401",
      "",
      "# A normal comment.",
      "VALUE = 3  # trailing note",
      "",
      "",
      "def size(items):  # type: (list) -> int",
      "    return len(items)  # pragma: no cover",
      "",
      "",
      "# fmt: off",
      "MATRIX = [1,0,",
      "          0,1]",
      "# fmt: on",
    ),
    found: ["tool.py:8: # A normal comment.", "tool.py:9: # trailing note"],
    fixed: lines(
      "#!/usr/bin/env python3",
      "# -*- coding: utf-8 -*-",
      "# SPDX-License-Identifier: Apache-2.0",
      "# Copyright 2026 Example Authors",
      "",
      "import os  # noqa: F401",
      "",
      "VALUE = 3",
      "",
      "",
      "def size(items):  # type: (list) -> int",
      "    return len(items)  # pragma: no cover",
      "",
      "",
      "# fmt: off",
      "MATRIX = [1,0,",
      "          0,1]",
      "# fmt: on",
    ),
    seeded: ["VALUE = 3", "VALUE = 4"],
  },
  {
    language: "shell",
    file: "run.sh",
    source: lines(
      "#!/bin/sh",
      "# SPDX-License-Identifier: Apache-2.0",
      "# Copyright 2026 Example Authors",
      "#",
      "# Prose about the script.",
      "",
      "# shellcheck disable=SC2034",
      "unused=1",
      "",
      "# Say hello.",
      'echo "hello #not-a-comment" # trailing',
      "echo ${HOME#/}",
    ),
    found: ["run.sh:4: #", "run.sh:5: # Prose about the script.", "run.sh:10: # Say hello.", "run.sh:11: # trailing"],
    fixed: lines(
      "#!/bin/sh",
      "# SPDX-License-Identifier: Apache-2.0",
      "# Copyright 2026 Example Authors",
      "",
      "# shellcheck disable=SC2034",
      "unused=1",
      "",
      'echo "hello #not-a-comment"',
      "echo ${HOME#/}",
    ),
    seeded: ["unused=1", "unused=2"],
  },
  {
    language: "css",
    file: "site.css",
    source: lines(
      "/*! Example Theme | SPDX-License-Identifier: MIT */",
      "",
      "/* stylelint-disable selector-class-pattern */",
      ".Card { color: red; }",
      "",
      "/* A normal comment. */",
      ".box {",
      "  margin: 4px; /* trailing */",
      "  padding: /* inline */ 2px;",
      "}",
      "",
      "/* prettier-ignore */",
      '.grid { grid-template-areas: "a b"',
      '                             "c d"; }',
      "/*# sourceMappingURL=site.css.map */",
    ),
    found: ["site.css:6: /* A normal comment. */", "site.css:8: /* trailing */", "site.css:9: /* inline */"],
    fixed: lines(
      "/*! Example Theme | SPDX-License-Identifier: MIT */",
      "",
      "/* stylelint-disable selector-class-pattern */",
      ".Card { color: red; }",
      "",
      ".box {",
      "  margin: 4px;",
      "  padding: 2px;",
      "}",
      "",
      "/* prettier-ignore */",
      '.grid { grid-template-areas: "a b"',
      '                             "c d"; }',
      "/*# sourceMappingURL=site.css.map */",
    ),
    seeded: ["margin: 4px", "margin: 5px"],
  },
  {
    language: "sql",
    file: "migrations/0001_items.sql",
    source: lines(
      "-- SPDX-License-Identifier: Apache-2.0",
      "-- Copyright 2026 Example Authors",
      "",
      "-- A normal comment.",
      "CREATE TABLE item (",
      "  id integer PRIMARY KEY, -- trailing",
      "  label text DEFAULT '-- not a comment' /* inline */ NOT NULL",
      ");",
    ),
    found: [
      "migrations/0001_items.sql:4: -- A normal comment.",
      "migrations/0001_items.sql:6: -- trailing",
      "migrations/0001_items.sql:7: /* inline */",
    ],
    fixed: lines(
      "-- SPDX-License-Identifier: Apache-2.0",
      "-- Copyright 2026 Example Authors",
      "",
      "CREATE TABLE item (",
      "  id integer PRIMARY KEY,",
      "  label text DEFAULT '-- not a comment' NOT NULL",
      ");",
    ),
    seeded: ["'-- not a comment'", "'-- changed'"],
  },
];

for (const { language, file, source, found, fixed, seeded } of languages) {
  describe.concurrent(`${language}: ${file}`, CLI_TIMEOUT, () => {
    it("check reports every normal comment and keeps the licence header, shebang and directives", async () => {
      const dir = repo({ [file]: source });
      const result = await cli(dir, "check");
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout.trimEnd().split("\n")).toEqual(found);
    });

    it("fix removes those comments and keeps the exceptions", async () => {
      const dir = repo({ [file]: source });
      const result = await cli(dir, "fix");
      expect(result.status, result.stderr).toBe(0);
      expect(read(dir, file)).toBe(fixed);
      expect((await cli(dir, "check")).status).toBe(0);
    });

    it("prove passes after fix", async () => {
      const dir = repo({ [file]: source });
      await cli(dir, "fix");
      const result = await cli(dir, "prove", "--base", "HEAD");
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(rowFor(result.stdout, file)).toMatch(new RegExp(`^ok +${language} +[0-9a-f]{12} ${file}$`));
    });

    it(`prove fails when ${seeded[0]} becomes ${seeded[1]} next to removed comments`, async () => {
      expect(fixed.includes(seeded[0])).toBe(true);
      const dir = repo({ [file]: source });
      write(dir, { [file]: fixed.replace(seeded[0], seeded[1]) });
      const result = await cli(dir, "prove", "--base", "HEAD");
      const row = rowFor(result.stdout, file);
      expect(result.status).toBe(1);
      expect(row).toMatch(new RegExp(`^FAIL ${language} +[0-9a-f]{12} ${file}  code changed \\(base [0-9a-f]{12}\\)$`));
    });
  });
}

describe.concurrent("go: fix and gofmt", CLI_TIMEOUT, () => {
  it("keeps a gofmt-clean file gofmt-clean when a removed line changes the alignment", async () => {
    const head = ["package main", "", "type envelope struct {", "\tSubject  string", "\tDecision string", "}", "", "var env = envelope{"];
    const dir = repo({ "env.go": lines(...head, '\tSubject: "example",', "\t// A note between the fields.", '\tDecision: "deny",', "}") });
    const result = await cli(dir, "fix");
    expect(result.status, result.stderr).toBe(0);
    expect(read(dir, "env.go")).toBe(lines(...head, '\tSubject:  "example",', '\tDecision: "deny",', "}"));
    expect((await cli(dir, "prove", "--base", "HEAD")).status).toBe(0);
  });

  it("does not reformat a file that was not gofmt-clean", async () => {
    const dir = repo({ "loose.go": lines("package main", "", "func f() int {", "  x:=1 // one", "  return x", "}") });
    expect((await cli(dir, "fix")).status).toBe(0);
    expect(read(dir, "loose.go")).toBe(lines("package main", "", "func f() int {", "  x:=1", "  return x", "}"));
  });
});

describe.concurrent("kept comments are part of the proof", CLI_TIMEOUT, () => {
  it("prove fails when a directive is removed, although only a comment changed", async () => {
    const go = languages[0] as Language;
    const dir = repo({ [go.file]: go.source });
    write(dir, { [go.file]: go.fixed.replace("//go:embed data.txt\n", "") });
    const result = await cli(dir, "prove", "--base", "HEAD");
    const row = rowFor(result.stdout, go.file);
    expect(result.status).toBe(1);
    expect(row).toMatch(/kept comment removed: directive \/\/go:embed data\.txt$/);
  });

  it("prove fails when a licence header line is removed", async () => {
    const sql = languages.at(-1) as Language;
    const dir = repo({ [sql.file]: sql.source });
    write(dir, { [sql.file]: sql.fixed.replace("-- Copyright 2026 Example Authors\n", "") });
    const result = await cli(dir, "prove", "--base", "HEAD");
    expect(result.status).toBe(1);
    expect(rowFor(result.stdout, sql.file)).toMatch(/kept comment removed: licence -- Copyright 2026 Example Authors$/);
  });

  it("prove names the first changed line of a changed kept comment", async () => {
    const block = lines("/*", " * Copyright 2026 Example Authors", " * Licensed under the MIT License.", " */", "module.exports = 1;");
    const dir = repo({ "block.cjs": block, "first.go": lines("// Copyright 2026 Example Authors", "package first") });
    write(dir, {
      "block.cjs": block.replace(" * Licensed under the MIT License.\n", ""),
      "first.go": lines("// Copyright 2025 Example Authors", "package first"),
    });
    const result = await cli(dir, "prove", "--base", "HEAD");
    const detail = (file: string) => rowFor(result.stdout, file)?.split(` ${file}  `)[1];
    expect(result.status).toBe(1);
    expect(detail("block.cjs")).toBe("kept comment changed: line 3 of licence /*: * Licensed under the MIT License. -> */");
    expect(detail("first.go")).toBe("kept comment changed: licence // Copyright 2026 Example Authors -> licence // Copyright 2025 Example Authors");
  });

  it("prose that shares a paragraph with the licence tags is reported, licence text is kept", async () => {
    const dir = repo({
      "header.go": lines(
        "// SPDX-License-Identifier: Apache-2.0",
        "// Copyright 2026 Example Authors",
        "// This file parses example input.",
        "package header",
      ),
      "apache.go": lines(
        "// Copyright 2026 Example Authors",
        "//",
        '// Licensed under the Apache License, Version 2.0 (the "License");',
        "// you may not use this file except in compliance with the License.",
        "//",
        "// Prose after the header.",
        "package apache",
      ),
    });
    const result = await cli(dir, "check");
    expect(result.status).toBe(1);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["apache.go:5: //", "apache.go:6: // Prose after the header.", "header.go:3: // This file parses example input."]);
  });
});

describe.concurrent("shell variants and partial parses", CLI_TIMEOUT, () => {
  it("check reads .zsh and .bash files as shell", async () => {
    const dir = repo({ "a.zsh": lines("#!/bin/zsh", "print one # zsh note"), "b.bash": lines("#!/bin/bash", "# bash note", "echo two") });
    const result = await cli(dir, "check");
    expect(result.status).toBe(1);
    expect(result.stdout.trimEnd().split("\n")).toEqual(["a.zsh:2: # zsh note", "b.bash:2: # bash note"]);
  });

  it("fix leaves comments inside code the grammar cannot parse, and prove requires them unchanged", async () => {
    const source = lines("#!/bin/zsh", "if [[ -n $HOME ]] {", "  # inside unparsed code", "  print -r -- $HOME", "}");
    const dir = repo({ "brace.zsh": source });
    const fix = await cli(dir, "fix");
    expect(fix.status).toBe(1);
    expect(fix.stderr).toMatch(/brace\.zsh:\d+: partial parse, 1 comments inside unparsed code, left in place/);
    expect(read(dir, "brace.zsh")).toBe(source);
    write(dir, { "brace.zsh": source.replace("  # inside unparsed code\n", "") });
    const result = await cli(dir, "prove", "--base", "HEAD");
    const row = rowFor(result.stdout, "brace.zsh");
    expect(result.status).toBe(1);
    expect(row).toMatch(/kept comment removed: unparsed # inside unparsed code$/);
  });

  it("prove compares a partial parse token by token when error recovery moves", async () => {
    const source = lines('@source "./ui";', "", "/* between the at-rules */", "@custom-variant dark (&:is(.dark *));", ".card { color: red; }");
    const dir = repo({ "theme.css": source });
    const fix = await cli(dir, "fix");
    expect(fix.status, fix.stderr).toBe(0);
    const result = await cli(dir, "prove", "--base", "HEAD");
    expect(result.status, result.stdout).toBe(0);
    expect(rowFor(result.stdout, "theme.css")).toMatch(/^ok +css +[0-9a-f]{12} theme\.css  partial parse at line \d+/);
    write(dir, { "theme.css": read(dir, "theme.css").replace("color: red", "color: blue") });
    expect((await cli(dir, "prove", "--base", "HEAD")).status).toBe(1);
  });
});

describe.concurrent("prove: TypeScript and JavaScript", CLI_TIMEOUT, () => {
  const ts = lines(
    "// SPDX-License-Identifier: Apache-2.0",
    "/** Adds two numbers. */",
    "export function add(a: number, b: number): number {",
    "  return a + b; // trailing",
    "}",
  );
  const tsFixed = lines("// SPDX-License-Identifier: Apache-2.0", "export function add(a: number, b: number): number {", "  return a + b;", "}");
  const tsx = lines(
    "export function View() {",
    "  return (",
    "    <div>",
    "      {/* a note */}",
    "      <span>hi</span>",
    "    </div>",
    "  );",
    "}",
  );
  const tsxFixed = tsx.replace("      {/* a note */}\n", "");
  const mjs = lines("const count = 1; // one", "export default count;");
  const mjsFixed = lines("const count = 1;", "export default count;");

  it("passes when only comments were removed, including a whole JSX comment line", async () => {
    const dir = repo({ "util.ts": ts, "view.tsx": tsx, "run.mjs": mjs });
    write(dir, { "util.ts": tsFixed, "view.tsx": tsxFixed, "run.mjs": mjsFixed });
    const result = await cli(dir, "prove", "--base", "HEAD");
    expect(result.status, result.stdout).toBe(0);
    expect(rowFor(result.stdout, "util.ts")).toMatch(/^ok +ts +[0-9a-f]{12} util\.ts$/);
    expect(rowFor(result.stdout, "view.tsx")).toMatch(/^ok +ts +[0-9a-f]{12} view\.tsx$/);
    expect(rowFor(result.stdout, "run.mjs")).toMatch(/^ok +js +[0-9a-f]{12} run\.mjs$/);
  });

  const changes: [string, string, string, string, string][] = [
    ["util.ts", ts, tsFixed, "a + b", "a - b"],
    ["util.ts", ts, tsFixed, "b: number", "b: string"],
    ["view.tsx", tsx, tsxFixed, "<span>hi</span>", "<span>ho</span>"],
    ["run.mjs", mjs, mjsFixed, "count = 1", "count = 2"],
  ];
  for (const [file, base, head, from, to] of changes) {
    it(`fails when ${from} becomes ${to} in ${file}`, async () => {
      const dir = repo({ [file]: base });
      write(dir, { [file]: head.replace(from, to) });
      const result = await cli(dir, "prove", "--base", "HEAD");
      const row = rowFor(result.stdout, file);
      expect(result.status).toBe(1);
      expect(row).toMatch(/code changed/);
    });
  }
});

describe.concurrent("prove: TypeScript and JavaScript directives are kept comments", CLI_TIMEOUT, () => {
  const directives = lines(
    "// Prose that names eslint-disable and /// <reference is a plain comment.",
    "// eslint-disable-next-line no-console",
    "console.log(1);",
    "export const made = /*#__PURE__*/ Object.freeze({}); // a note",
    "// @ts-expect-error made-up mismatch",
    "export const n: number = \"1\";",
    "export const lazy = () => import(/* @vite-ignore */ \"./x.js\");",
  );
  const typeBlock = lines("/** @param {number} a */", "export function twice(a) {", "  return a * 2; // double", "}");

  it("passes when only the plain comments are removed, including prose that names a directive", async () => {
    const dir = repo({ "kept.ts": directives, "typed.js": typeBlock });
    write(dir, { "kept.ts": directives.replace(" // a note", "").replace("// Prose that names eslint-disable and /// <reference is a plain comment.\n", ""), "typed.js": typeBlock.replace(" // double", "") });
    const result = await cli(dir, "prove", "--base", "HEAD");
    expect(result.status, result.stdout).toBe(0);
  });

  const removals: [string, string, string][] = [
    ["kept.ts", directives, "// eslint-disable-next-line no-console"],
    ["kept.ts", directives, "/*#__PURE__*/"],
    ["kept.ts", directives, "// @ts-expect-error made-up mismatch"],
    ["kept.ts", directives, "/* @vite-ignore */"],
    ["typed.js", typeBlock, "/** @param {number} a */"],
  ];
  for (const [file, base, directive] of removals) {
    it(`fails when ${directive} is removed from ${file}`, async () => {
      const dir = repo({ [file]: base });
      write(dir, { [file]: base.replace(`${directive}\n`, "").replace(`${directive} `, "") });
      const result = await cli(dir, "prove", "--base", "HEAD");
      expect(result.status, result.stdout).toBe(1);
      expect(rowFor(result.stdout, file)).toContain(`kept comment removed: directive ${directive}`);
    });
  }
});

type KeptCase = { name: string; file: string; source: string; kept: string[]; plain: string[] };

describe("prove: the kept comment forms shared with the ESLint no-comments rule", CLI_TIMEOUT, () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const { cases } = JSON.parse(readFileSync(new URL("kept-comment-forms.json", import.meta.url), "utf8")) as { cases: KeptCase[] };

  it("has one text for every copy of the shared module and of the shared cases", () => {
    const groups = [
      ["tools/no-comments/lib/kept-comments.mjs", "tools/eslint/rules/kept-comments.mjs"],
      ["tests/integration/no-comments/kept-comment-forms.json", "tests/integration/eslint/kept-comment-forms.json"],
    ];
    for (const copies of groups) {
      const present = copies.filter((file) => existsSync(join(root, file)));
      expect(present).toContain(copies[0]);
      expect(new Set(present.map((file) => read(root, file))).size, present.join(" and ")).toBe(1);
    }
  });

  it("fails when any kept form is removed and passes when a plain comment is removed", async () => {
    const removals = cases.flatMap((entry, index) =>
      [...entry.kept.map((comment) => ({ comment, kept: true })), ...entry.plain.map((comment) => ({ comment, kept: false }))].map(
        (removal, position) => ({ ...removal, file: `${index}-${position}-${entry.file}`, source: entry.source }),
      ),
    );
    const dir = repo(Object.fromEntries(removals.map(({ file, source }) => [file, source])));
    write(dir, Object.fromEntries(removals.map(({ file, source, comment }) => [file, source.replace(comment, "")])));
    const result = await cli(dir, "prove", "--base", "HEAD");
    const verdict = (row: string | undefined) => (row === undefined ? "missing" : row.split(" ")[0]);
    expect(removals.map(({ file, comment }) => `${verdict(rowFor(result.stdout, file))} ${file} ${comment}`)).toEqual(
      removals.map(({ file, comment, kept }) => `${kept ? "FAIL" : "ok"} ${file} ${comment}`),
    );
    expect(result.status).toBe(1);
  });
});

describe.concurrent("prove: changes that are not comment removals", CLI_TIMEOUT, () => {
  it("fails for added, deleted and unprovable files and for a mode change", async () => {
    const dir = repo({ "keep.go": lines("package keep"), "gone.go": lines("package gone"), "notes.md": lines("# Notes"), "run.sh": lines("echo hi") });
    write(dir, { "new.go": lines("package added"), "notes.md": lines("# Changed notes") });
    unlinkSync(join(dir, "gone.go"));
    chmodSync(join(dir, "run.sh"), 0o755);
    git(dir, "add", "-N", "new.go");
    const result = await cli(dir, "prove", "--base", "HEAD");
    expect(result.status).toBe(1);
    expect(rowFor(result.stdout, "new.go")).toMatch(/^FAIL go +- +new\.go  added$/);
    expect(rowFor(result.stdout, "gone.go")).toMatch(/^FAIL go +- +gone\.go  deleted$/);
    expect(rowFor(result.stdout, "notes.md")).toMatch(/^FAIL - +- +notes\.md  no prover$/);
    expect(rowFor(result.stdout, "run.sh")).toMatch(/^FAIL shell +- +run\.sh  mode changed 100644 -> 100755$/);
    expect(rowFor(result.stdout, "keep.go")).toBe(undefined);
  });

  it("compares two commits with --head and limits the files to the given paths", async () => {
    const dir = repo({ "a/one.py": lines("x = 1  # one"), "b/two.py": lines("y = 2  # two") });
    write(dir, { "a/one.py": lines("x = 1"), "b/two.py": lines("y = 3") });
    git(dir, "commit", "-q", "-am", "head");
    const both = await cli(dir, "prove", "--base", "HEAD~1", "--head", "HEAD");
    expect(both.status).toBe(1);
    expect(rowFor(both.stdout, "a/one.py")).toMatch(/^ok /);
    expect(rowFor(both.stdout, "b/two.py")).toMatch(/^FAIL /);
    const scoped = await run(dir, "prove.mjs", "--base", "HEAD~1", "--head", "HEAD", "a");
    expect(scoped.status, scoped.stdout).toBe(0);
    expect(rowFor(scoped.stdout, "b/two.py")).toBe(undefined);
  });

  it("exits 2 on usage errors", async () => {
    const dir = repo({ "keep.go": lines("package keep") });
    expect((await cli(dir, "prove")).status).toBe(2);
    expect((await cli(dir, "prove", "--base", "no-such-ref")).status).toBe(2);
    expect((await cli(dir, "check", "no-such-path")).status).toBe(2);
    expect((await cli(dir, "lint")).status).toBe(2);
  });
});
