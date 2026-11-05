import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

interface Annotation {
  paths: string[];
  precedence: string;
  copyright: string[];
  licence: string;
}

interface ReuseModule {
  parseReuseToml(text: string): { version: number; annotations: Annotation[] };
  resolveAnnotation(annotations: Annotation[], rel: string): Annotation | undefined;
  effectiveLicence(annotations: Annotation[], rel: string, text: string): string | undefined;
}

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const reuseModule = pathToFileURL(path.join(repoRoot, "scripts/lib/reuse.mjs")).href;
const head800 = (rel: string): string => readFileSync(path.join(repoRoot, rel), "utf8").slice(0, 800);

const SHADCN = [
  "packages/ui/src/react/components/badge.tsx",
  "packages/ui/src/react/components/button.tsx",
  "packages/ui/src/react/components/command.tsx",
  "packages/ui/src/react/components/dialog.tsx",
  "packages/ui/src/react/components/dropdown-menu.tsx",
  "packages/ui/src/react/components/input-group.tsx",
  "packages/ui/src/react/components/input.tsx",
  "packages/ui/src/react/components/label.tsx",
  "packages/ui/src/react/components/scroll-area.tsx",
  "packages/ui/src/react/components/separator.tsx",
  "packages/ui/src/react/components/sheet.tsx",
  "packages/ui/src/react/components/table.tsx",
  "packages/ui/src/react/components/tabs.tsx",
  "packages/ui/src/react/components/toast.tsx",
  "packages/ui/src/react/lib/cn.ts",
  "apps/guard-console/src/components/ui/breadcrumb.tsx",
  "apps/guard-console/src/components/ui/dropdown-menu.tsx",
  "apps/guard-console/src/components/ui/sheet.tsx",
  "apps/guard-console/src/components/ui/sidebar.tsx",
  "apps/guard-console/src/hooks/use-mobile.ts",
  "apps/guard-console/src/lib/utils.ts",
];

const BLOCKS_SO = ["apps/guard-console/src/components/ui/sidebar.tsx", "apps/guard-console/src/components/sidebar-05/app-sidebar.tsx"];

const LICENCE_FIXTURES = [
  "tests/integration/eslint/kept-comment-forms.json",
  "tests/integration/eslint/no-comments.test.ts",
  "tests/integration/no-comments/cli.test.ts",
  "tests/integration/no-comments/kept-comment-forms.json",
];

let reuse: ReuseModule;
let annotations: Annotation[] = [];

beforeAll(async () => {
  reuse = (await import(reuseModule)) as ReuseModule;
  annotations = reuse.parseReuseToml(readFileSync(path.join(repoRoot, "REUSE.toml"), "utf8")).annotations;
});

describe("REUSE.toml upstream attribution", () => {
  it("has a licence text in LICENSES/ for every licence an annotation in this tree names", () => {
    const inTree = annotations.filter((a) => a.paths.some((p) => existsSync(path.join(repoRoot, p.split("*")[0] ?? ""))));
    const ids = new Set(inTree.flatMap((a) => a.licence.split(/[\s()]+/).filter((t) => t !== "" && !["AND", "OR", "WITH"].includes(t))));
    expect([...ids].filter((id) => !existsSync(path.join(repoRoot, "LICENSES", `${id}.txt`)))).toEqual([]);
    expect(ids).toContain("ISC");
  });

  it.each(SHADCN)("credits shadcn/ui under MIT and keeps the AGPL-3.0-only part on %s", (rel) => {
    expect(existsSync(path.join(repoRoot, rel))).toBe(true);
    const a = reuse.resolveAnnotation(annotations, rel);
    expect(a?.licence).toBe("AGPL-3.0-only AND MIT");
    expect(a?.copyright).toEqual(expect.arrayContaining(["2026 Sam Rahmani and Tyler Stewart", "2023 shadcn"]));
    expect(reuse.effectiveLicence(annotations, rel, head800(rel))).toBe("AGPL-3.0-only AND MIT");
  });

  it.each(BLOCKS_SO)("credits the blocks.so sidebar-05 block (2025 Ephraim Duncan, MIT) on %s", (rel) => {
    expect(existsSync(path.join(repoRoot, rel))).toBe(true);
    const a = reuse.resolveAnnotation(annotations, rel);
    expect(a?.licence).toBe("AGPL-3.0-only AND MIT");
    expect(a?.copyright).toEqual(expect.arrayContaining(["2026 Sam Rahmani and Tyler Stewart", "2025 Ephraim Duncan"]));
  });

  it("adds Lucide's ISC notice to the block page's glyphs and keeps the file's own Apache-2.0", () => {
    const rel = "guard/agent/src/marks.rs";
    const text = readFileSync(path.join(repoRoot, rel), "utf8");
    expect(text).toContain('<path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>');
    const a = reuse.resolveAnnotation(annotations, rel);
    expect(a).toMatchObject({ precedence: "aggregate", licence: "ISC", copyright: ["Lucide Contributors"] });
    expect(reuse.effectiveLicence(annotations, rel, head800(rel))).toBe("Apache-2.0");
  });

  it.each(LICENCE_FIXTURES)("does not read the sample licence headers in %s as the file's licence", (rel) => {
    expect(readFileSync(path.join(repoRoot, rel), "utf8")).toContain(`${"SPDX-"}License-Identifier`);
    expect(reuse.effectiveLicence(annotations, rel, head800(rel))).toBe("AGPL-3.0-only");
  });
});

const HOLDERS = "2026 Sam Rahmani and Tyler Stewart";
const APACHE_DIRS = ["guard/", "packages/guard-contract/"];
const NOTICES = APACHE_DIRS.map((dir) => `${dir}NOTICE`);

describe("copyright holders until the company is incorporated (decision 0002)", () => {
  it("names the founders on the AGPL-3.0-only default and the Apache-2.0 zone", () => {
    const fallback = reuse.resolveAnnotation(annotations, "apps/registry/src/server.ts");
    expect(fallback).toMatchObject({ licence: "AGPL-3.0-only", copyright: [HOLDERS] });
    const apache = reuse.resolveAnnotation(annotations, "packages/guard-contract/src/index.ts");
    expect(apache).toMatchObject({ licence: "Apache-2.0", copyright: [HOLDERS] });
  });

  it("leaves no annotation naming the placeholder holder Vibtra", () => {
    expect(annotations.flatMap((a) => a.copyright).filter((c) => /\bVibtra\b/.test(c))).toEqual([]);
  });

  it.each(NOTICES)("names the founders in %s", (rel) => {
    expect(readFileSync(path.join(repoRoot, rel), "utf8").split("\n")[1]).toBe(`Copyright ${HOLDERS}`);
  });
});

describe("the root LICENSE", () => {
  const text = readFileSync(path.join(repoRoot, "LICENSE"), "utf8");

  it("points to the per-path licences instead of a proprietary grant", () => {
    expect(text).not.toMatch(/proprietary|All rights reserved/i);
    expect(text).toContain("REUSE.toml");
    expect(text).toMatch(/Everything not listed below\s+AGPL-3\.0-only/);
    for (const dir of APACHE_DIRS) expect(text).toContain(dir);
    expect(text).toContain("CLA.md");
  });

  it.each(APACHE_DIRS)("is right that %s carries its own LICENSE and NOTICE", (dir) => {
    expect(text).toContain("Directories under Apache-2.0 carry their own LICENSE and NOTICE files.");
    for (const file of ["LICENSE", "NOTICE"]) expect(existsSync(path.join(repoRoot, dir, file)), `${dir}${file}`).toBe(true);
  });

  it("names every licence it cites with a text in LICENSES/", () => {
    for (const id of ["AGPL-3.0-only", "Apache-2.0"]) expect(existsSync(path.join(repoRoot, "LICENSES", `${id}.txt`))).toBe(true);
  });
});
