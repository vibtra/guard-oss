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
const proxyRoute = /\b(?:https?|all)_proxy\b|127\.0\.0\.1:9470|proxy exports/i;

const offenders = (files: string[]): string[] =>
  files.flatMap((rel) =>
    readFileSync(path.join(repoRoot, rel), "utf8")
      .split("\n")
      .flatMap((line, i) => (proxyRoute.test(line) ? [`${rel}:${i + 1}: ${line.trim()}`] : [])),
  );

describe("the network extension is the only way into Guard on a Mac (decision 0005)", () => {
  it("the Mac app offers no proxy settings or proxy environment variables", () => {
    expect(macApp.length).toBeGreaterThan(10);
    expect(offenders(macApp)).toEqual([]);
  });

  it("the user docs never tell anyone to point a tool at Guard as a proxy", () => {
    expect(userDocs.length).toBeGreaterThan(5);
    expect(offenders(userDocs)).toEqual([]);
  });

  it("the decision is recorded", () => {
    const adr = readFileSync(path.join(repoRoot, "docs/decisions/0005-network-extension-only.md"), "utf8");
    expect(adr).toMatch(/^- \*\*Status:\*\* Accepted/m);
  });
});
