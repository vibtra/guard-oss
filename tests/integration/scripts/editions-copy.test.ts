import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENTERPRISE_FEATURE_NAMES } from "@vibtra/registry/src/enterprise.ts";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const section = (rel: string): string => {
  const text = readFileSync(path.join(repoRoot, rel), "utf8");
  const start = text.indexOf("## Editions\n");
  expect(start, `${rel} has an Editions section`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf("\n## ", start + 1);
  return text.slice(start, end === -1 ? undefined : end);
};
const lineStarting = (text: string, prefix: string): string => text.split("\n").find((l) => l.startsWith(prefix)) ?? "";

describe("the Editions copy (decision 0002)", () => {
  const readme = section("README.md");
  const guide = section("docs/guide/coverage.md");

  it("says the same in the README and the coverage guide", () => {
    expect(readme.startsWith(guide.trimEnd())).toBe(true);
  });

  it("names the Community Edition's four surfaces, same-day fixes, no caps and the fixed surface list", () => {
    for (const phrase of ["Claude on the web, Claude for macOS, ChatGPT on the web and ChatGPT for macOS", "the same day", "No caps on devices, seats or usage", "surface list does not grow"]) {
      expect(guide).toContain(phrase);
    }
    expect(guide).not.toMatch(/\$\s?\d/);
  });

  it("advertises SCIM as built and every other enterprise feature as coming", () => {
    const features = lineStarting(guide, "- The enterprise features in `ee/`.");
    const [built, coming] = features.split("Coming:");
    expect(built).toContain("SCIM directory sync");
    for (const [id, name] of Object.entries(ENTERPRISE_FEATURE_NAMES)) {
      if (id === "scim") continue;
      expect(coming?.toLowerCase(), id).toContain(name.toLowerCase());
    }
  });
});
