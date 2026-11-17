import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TESTS = path.join(REPO, "tests");
const LOCAL_SIGNER = path.join(REPO, "apps/registry/src/guard/local-signer.ts");
const FIXTURE_CONFIG = path.join(TESTS, "fixtures/race-mutant/vitest.config.ts");
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const RACE_TEST = "signs with exactly the one stored key when two signers race to first use of one organisation";
const STORE_THE_FRESH_KEY = /\n(\s*)row = (await store\.putSigningKeyIfAbsent\([^\n]*\);)\n/g;

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const importsResolvedFrom = (source: string): string =>
  source
    .replace('"@vibtra/guard-contract/signing"', JSON.stringify(path.join(REPO, "packages/guard-contract/src/signing.ts")))
    .replace('"../errors.js"', JSON.stringify(path.join(REPO, "apps/registry/src/errors.ts")))
    .replace('"../vault/seal.js"', JSON.stringify(path.join(REPO, "apps/registry/src/vault/seal.ts")))
    .replace('"./store.js"', JSON.stringify(path.join(REPO, "apps/registry/src/guard/store.ts")));

const signFreshKeyMutant = (source: string): string => {
  const matches = [...source.matchAll(STORE_THE_FRESH_KEY)];
  expect(matches, "the LocalSigner stores a fresh key in exactly one place").toHaveLength(1);
  return source.replace(STORE_THE_FRESH_KEY, "\n$1$2\n$1return fresh;\n");
};

const writeModule = async (source: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "local-signer-mutant-"));
  dirs.push(dir);
  const file = path.join(dir, "local-signer.ts");
  await writeFile(file, importsResolvedFrom(source));
  return file;
};

interface ContractRun {
  status: number | null;
  results: Map<string, string>;
}

const runContract = async (modulePath: string): Promise<ContractRun> => {
  const report = path.join(path.dirname(modulePath), "report.json");
  const child = spawnSync(process.execPath, [VITEST, "run", "--config", FIXTURE_CONFIG, "--reporter=json", `--outputFile=${report}`], {
    cwd: TESTS,
    encoding: "utf8",
    env: { ...process.env, VIBTRA_LOCAL_SIGNER_MODULE: modulePath },
    timeout: 120_000,
  });
  const parsed = JSON.parse(await readFile(report, "utf8")) as { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> };
  const results = new Map(parsed.testResults.flatMap((file) => file.assertionResults.map((test) => [test.title, test.status] as const)));
  return { status: child.status, results };
};

describe("the GuardSigner contract's race test against the guard-oss#46 mutant", () => {
  it("passes the real LocalSigner, and fails only the race test when a racer signs with its fresh key instead of the stored one", async () => {
    const source = await readFile(LOCAL_SIGNER, "utf8");
    const mutant = signFreshKeyMutant(source);
    expect(mutant).not.toBe(source);

    const real = await runContract(await writeModule(source));
    expect(real.results.get(RACE_TEST)).toBe("passed");
    expect([...real.results.values()].filter((status) => status !== "passed")).toEqual([]);
    expect(real.status).toBe(0);

    const mutated = await runContract(await writeModule(mutant));
    expect(mutated.results.size).toBe(real.results.size);
    expect([...mutated.results].filter(([, status]) => status !== "passed").map(([title]) => title)).toEqual([RACE_TEST]);
    expect(mutated.status).toBe(1);
  });
});
