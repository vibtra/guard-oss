import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const filesUnder = (dir: string, ext: string): string[] =>
  readdirSync(path.join(repoRoot, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(ext))
    .map((f) => path.join(dir, f));

const macApp = ["guard/mac/VibtraGuard", "guard/mac/Shared", "guard/mac/VibtraGuardExtension"].flatMap((d) => filesUnder(d, ".swift"));
const userDocs = [...filesUnder("docs/guide", ".md"), "README.md", "SECURITY.md", "guard/README.md"];

const proxyRoute =
  /\b(?:https?|all)_proxy\b|\bport 9470\b|:9470\b|proxy exports|\buse (?:the|a|guard as a) proxy\b|\bset (?:its|the|a|your) proxy\b|\bproxy settings removed\b|\b(?:secure )?web proxy\b/gi;
const macOnly = /\b9470\b|\bproxyPort\b|setwebproxy|setsecurewebproxy|setautoproxyurl/gi;

const offenders = (files: string[], patterns: RegExp[]): string[] =>
  files.flatMap((rel) => {
    const text = readFileSync(path.join(repoRoot, rel), "utf8").replace(/\s+/g, " ");
    return patterns.flatMap((p) => [...text.matchAll(p)].map((m) => `${rel}: …${text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40)}…`));
  });

describe("the network extension is the only way into Guard on a Mac (decision 0005)", () => {
  it("the Mac app offers no proxy settings or proxy environment variables", () => {
    expect(macApp.length).toBeGreaterThan(10);
    expect(offenders(macApp, [proxyRoute, macOnly])).toEqual([]);
  });

  it("the user docs never tell anyone to point a tool at Guard as a proxy", () => {
    expect(userDocs.length).toBeGreaterThan(5);
    expect(offenders(userDocs, [proxyRoute])).toEqual([]);
  });

  it("the decision is recorded", () => {
    const adr = readFileSync(path.join(repoRoot, "docs/decisions/0005-network-extension-only.md"), "utf8");
    expect(adr).toMatch(/^- \*\*Status:\*\* Accepted/m);
  });
});
