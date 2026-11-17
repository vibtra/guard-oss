import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const TESTS = path.join(REPO, "tests");
const SEAL = path.join(REPO, "apps/registry/src/vault/seal.ts");
const FIXTURE_CONFIG = path.join(TESTS, "fixtures/sealer-mutant/vitest.config.ts");
const VITEST = path.join(path.dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
const AAD = /^const aad = \(binding: SealBinding\): Buffer => .*$/m;
const CONCATENATED = 'const aad = (binding: SealBinding): Buffer => Buffer.from(binding.orgId + binding.connectionId, "utf8");';
const KILLERS = [
  "refuses a value under any re-split of the same orgId and connectionId, so the binding is not their plain concatenation",
  "refuses a value sealed for orgId ab and connectionId c under orgId a and connectionId bc",
];

const dirs: string[] = [];

afterAll(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const writeModule = async (source: string): Promise<string> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-seal-mutant-"));
  dirs.push(dir);
  const file = path.join(dir, "seal.ts");
  await writeFile(file, source.replace('"../errors.js"', JSON.stringify(path.join(REPO, "apps/registry/src/errors.ts"))));
  return file;
};

const withoutSeed = (): NodeJS.ProcessEnv => {
  const { FC_SEED: _seed, ...env } = process.env;
  return env;
};

const runContract = async (modulePath: string) => {
  const report = path.join(path.dirname(modulePath), "report.json");
  const child = spawnSync(process.execPath, [VITEST, "run", "--config", FIXTURE_CONFIG, "--reporter=json", `--outputFile=${report}`], {
    cwd: TESTS,
    encoding: "utf8",
    env: { ...withoutSeed(), VIBTRA_VAULT_SEAL_MODULE: modulePath },
    timeout: 120_000,
  });
  const parsed = JSON.parse(await readFile(report, "utf8")) as { testResults: Array<{ assertionResults: Array<{ title: string; status: string }> }> };
  return { status: child.status, results: new Map(parsed.testResults.flatMap((file) => file.assertionResults.map((test) => [test.title, test.status] as const))) };
};

describe("the VaultSealer contract against an ambiguous AAD (S4)", () => {
  it("passes the real sealer, and fails only the re-split tests when the AAD is orgId + connectionId", async () => {
    const source = await readFile(SEAL, "utf8");
    expect(source.match(new RegExp(AAD.source, "gm")), "seal.ts builds its AAD in exactly one place").toHaveLength(1);
    const mutant = source.replace(AAD, CONCATENATED);
    expect(mutant).not.toBe(source);

    const real = await runContract(await writeModule(source));
    expect([...real.results.values()].filter((status) => status !== "passed")).toEqual([]);
    for (const title of KILLERS) expect(real.results.get(title), title).toBe("passed");
    expect(real.status).toBe(0);

    const mutated = await runContract(await writeModule(mutant));
    expect(mutated.results.size).toBe(real.results.size);
    expect([...mutated.results].filter(([, status]) => status !== "passed").map(([title]) => title).sort()).toEqual([...KILLERS].sort());
    expect(mutated.status).toBe(1);
  });
});
