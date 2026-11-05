import { describe, expect, it } from "vitest";
import { ESLINT_TIMEOUT, FENCES_CONFIG, lintFiles, run } from "./cli";

const COLOURS = ["vibtra/no-palette-colour", "vibtra/no-raw-colour"];

type Printed = { rules: Record<string, unknown[]>; linterOptions: { noInlineConfig?: boolean } };

const printed = async (file: string) => JSON.parse(await run(["--config", FENCES_CONFIG, "--print-config", file])) as Printed;
const severities = (config: Printed) => Object.fromEntries(Object.entries(config.rules).map(([ruleId, [severity]]) => [ruleId, severity]));

describe("the fences-only config over the real tree", ESLINT_TIMEOUT, () => {
  it("turns on the fences, and only the fences, with inline config ignored", async () => {
    const app = await printed("apps/guard-console/src/App.tsx");
    expect(severities(app)).toEqual(Object.fromEntries(COLOURS.map((ruleId) => [ruleId, 2])));
    expect(app.linterOptions.noInlineConfig).toBe(true);
    expect(severities(await printed("apps/registry/src/server.ts"))).toEqual({});
    expect(severities(await printed("apps/guard-console/src/index.css"))).toEqual({ "vibtra/no-palette-colour": 2, "vibtra/no-raw-colour": 2 });
  });

  it("finds no fence violation and no parse error in any tracked source file", async () => {
    const results = await lintFiles(["--config", FENCES_CONFIG, "."]);
    expect(results.length).toBeGreaterThan(400);
    const errors = results.flatMap((result) =>
      result.messages.filter((message) => message.severity === 2).map((message) => `${result.filePath}:${message.line} ${message.ruleId} ${message.message}`),
    );
    expect(errors).toEqual([]);
  });
});
