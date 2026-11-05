import { describe, expect, it } from "vitest";
import { ESLINT_TIMEOUT, lines, lintText, run } from "./cli";

const errors = async (code: string, file: string) => {
  const result = await lintText(code, file);
  return result.messages.filter((message) => message.severity === 2).map((message) => `${message.ruleId} ${message.line}`);
};

const rulesFor = async (file: string) => (JSON.parse(await run(["--print-config", file])) as { rules: Record<string, unknown> }).rules;

const changedRules = async (file: string, sibling: string) => {
  const [mine, theirs] = await Promise.all([rulesFor(file), rulesFor(sibling)]);
  return [...new Set([...Object.keys(mine), ...Object.keys(theirs)])].filter((rule) => JSON.stringify(mine[rule]) !== JSON.stringify(theirs[rule]));
};

const fixture = lines("export const fixtures = {", "  seed: async ({}, use: (value: number) => Promise<void>) => {", "    await use(1);", "  },", "};");
const vitestImport = lines("import { it } from \"vitest\";", "it(\"runs\", () => {});");

describe.concurrent("the two narrow overrides in eslint.config.mjs cover exactly their globs", ESLINT_TIMEOUT, () => {
  for (const file of ["tests/e2e/console/support/probe.ts", "tests/e2e/providers/support/probe.ts", "tests/e2e/console/support/deep/probe.ts"]) {
    it(`a Playwright fixture's ({}, use) passes in ${file}`, async () => {
      expect(await errors(fixture, file)).toEqual([]);
    });
  }

  for (const file of ["tests/e2e/console/probe.spec.ts", "tests/e2e/support.ts", "tests/integration/support/probe.ts", "packages/demo/src/support/probe.ts"]) {
    it(`the same fixture still fails no-empty-pattern in ${file}`, async () => {
      expect(await errors(fixture, file)).toEqual(["no-empty-pattern 2"]);
    });
  }

  it("a support file differs from its spec sibling only in no-empty-pattern", async () => {
    expect(await changedRules("tests/e2e/console/support/probe.ts", "tests/e2e/console/probe.spec.ts")).toEqual(["no-empty-pattern"]);
  });

  it("tests/integration/ee may import vitest without declaring it", async () => {
    expect(await errors(vitestImport, "tests/integration/ee/probe.test.ts")).toEqual([]);
  });

  it("only tests/integration/ee carries allowModules: vitest", async () => {
    expect((await rulesFor("tests/integration/ee/sub/probe.test.ts"))["n/no-extraneous-import"]).toEqual([2, { allowModules: ["vitest"] }]);
    for (const file of ["tests/integration/eex/probe.test.ts", "tests/integration/scripts/probe.test.ts", "tests/e2e/console/probe.spec.ts", "ee/src/probe.ts"]) {
      expect((await rulesFor(file))["n/no-extraneous-import"], file).toEqual([2]);
    }
  });

  it("an ee test differs from a sibling folder's test only in n/no-extraneous-import", async () => {
    expect(await changedRules("tests/integration/ee/probe.test.ts", "tests/integration/scripts/probe.test.ts")).toEqual(["n/no-extraneous-import"]);
  });
});
