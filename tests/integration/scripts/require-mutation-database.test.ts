import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/require-mutation-database.mjs", import.meta.url));

const run = (mode: string, env: Record<string, string>) => spawnSync(process.execPath, [SCRIPT, mode], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", ...env } });

describe("require-mutation-database", () => {
  it("lets Stryker and the survivors check run when VIBTRA_TEST_DATABASE_URL is set", () => {
    for (const mode of ["run", "survivors"]) {
      const result = run(mode, { VIBTRA_TEST_DATABASE_URL: "postgres://made-up@127.0.0.1:5432/made_up" });
      expect([result.status, result.stderr], mode).toEqual([0, ""]);
    }
  });

  it("refuses to run Stryker without VIBTRA_TEST_DATABASE_URL, empty or unset", () => {
    for (const env of [{}, { VIBTRA_TEST_DATABASE_URL: "" }]) {
      const result = run("run", env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("mutation: refusing to run Stryker. VIBTRA_TEST_DATABASE_URL is not set, so the Postgres-backed tests would skip.");
    }
  });

  it("refuses the survivors check without VIBTRA_TEST_DATABASE_URL, even with the override", () => {
    const result = run("survivors", { VIBTRA_MUTATION_WITHOUT_POSTGRES: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mutation: refusing to check survivors.");
  });

  it("runs Stryker without Postgres only with the override, and warns that survivors.json must not change", () => {
    const result = run("run", { VIBTRA_MUTATION_WITHOUT_POSTGRES: "1" });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("mutation: WARNING: VIBTRA_MUTATION_WITHOUT_POSTGRES=1 is set, so Stryker runs without Postgres. Use this run to explore only. Do not edit tests/mutation/survivors.json from it.");
  });
});
