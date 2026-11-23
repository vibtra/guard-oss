import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-workflow-pipefail.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-pipefail-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
};

const check = (root?: string) => spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], { encoding: "utf8" });
const findings = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("workflow-pipefail: "));
const lint = async (files: Record<string, string>) => {
  const result = check(await tree(files));
  return { status: result.status, findings: findings(result.stderr), stderr: result.stderr };
};

const RULESET_DRIFT_8B25433 = `name: Ruleset drift
on:
  schedule:
    - cron: '0 6 * * *'
  push:
    branches: [main]
permissions:
  contents: read
jobs:
  ruleset-drift:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - name: Set up Node (actions/setup-node v4.4.0)
        uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020
        with:
          node-version-file: .nvmrc
      - name: The rules GitHub enforces on main match .github/rulesets/main.json
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: node scripts/check-ruleset-drift.mjs --repo "$GITHUB_REPOSITORY" --branch main 2>&1 | tee -a "$GITHUB_STEP_SUMMARY"
`;

const job = (step: string, jobKeys = "") => `    runs-on: ubuntu-latest\n${jobKeys}    steps:\n      - name: Made-up step\n${step}`;
const workflow = (step: string, { top = "", jobKeys = "" } = {}) => `name: made-up\non: pull_request\n${top}jobs:\n  made-up:\n${job(step, jobKeys)}`;
const BASH_DEFAULTS = "defaults:\n  run:\n    shell: bash\n";
const PIPED_BLOCK = "        run: |\n          made-up-producer --flag\n          made-up-producer | made-up-consumer\n";

describe("check-workflow-pipefail", () => {
  it("passes this tree: every run step that pipes has pipefail", () => {
    const result = check();
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain("every run step that pipes");
  });

  it("fails the ruleset-drift workflow as 8b25433 had it, which went green on real drift", async () => {
    const result = await lint({ ".github/workflows/ruleset-drift.yml": RULESET_DRIFT_8B25433 });
    expect(result.status).toBe(1);
    expect(result.findings).toEqual([
      `workflow-pipefail: .github/workflows/ruleset-drift.yml: jobs.ruleset-drift.steps[1] "The rules GitHub enforces on main match .github/rulesets/main.json" pipes under GitHub's default shell, bash -e {0}, which has no pipefail: node scripts/check-ruleset-drift.mjs --repo "$GITHUB_REPOSITORY" --branch main 2>&1 | tee -a "$GITHUB_STEP_SUMMARY"`,
    ]);
    expect(result.stderr).toContain("Fix: add `defaults: run: shell: bash` to the workflow or the job, or `shell: bash` to the step, or make `set -euo pipefail` the script's first line.");
  });

  it.each([
    ["a pipe in a block script, named by its line", workflow(PIPED_BLOCK), "made-up-producer | made-up-consumer"],
    ["a pipe inside a command substitution", workflow('        run: echo "$(made-up-producer | made-up-consumer)"\n'), 'echo "$(made-up-producer | made-up-consumer)"'],
    ["shell: sh, which has no pipefail", workflow(`        shell: sh\n${PIPED_BLOCK}`), "made-up-producer | made-up-consumer"],
    ["set -o pipefail below the first line", workflow("        run: |\n          made-up-producer | made-up-consumer\n          set -o pipefail\n"), "made-up-producer | made-up-consumer"],
    ["bash defaults on a different job", `name: made-up\non: pull_request\njobs:\n  made-up:\n${job(PIPED_BLOCK)}  other:\n    runs-on: ubuntu-latest\n    defaults:\n      run:\n        shell: bash\n    steps:\n      - run: echo other\n`, "made-up-producer | made-up-consumer"],
    ["job defaults shell: sh over workflow defaults shell: bash", workflow(PIPED_BLOCK, { top: BASH_DEFAULTS, jobKeys: "    defaults:\n      run:\n        shell: sh\n" }), "made-up-producer | made-up-consumer"],
    ["the text shell: bash inside the script", workflow("        run: |\n          made-up-producer | made-up-consumer\n          shell: bash\n"), "made-up-producer | made-up-consumer"],
    ["the script on the line after run:", workflow("        run:\n          a | b\n"), "a | b"],
    ["a plain script continued on the next line", workflow("        run: a\n          | b\n"), "a | b"],
    ["a double-quoted script over two lines", workflow('        run: "a\n          | b"\n'), "a | b"],
    ["a quoted run key", workflow('        "run": a | b\n'), "a | b"],
    ["a flow mapping step", workflow('        run: echo first\n      - { name: Flow, run: "a | b" }\n'), "a | b"],
  ])("fails on %s", async (_case, text, piped) => {
    const result = await lint({ ".github/workflows/made-up.yml": text });
    expect(result.status).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatch(/^workflow-pipefail: \.github\/workflows\/made-up\.yml: jobs\.made-up\.steps\[\d\] /);
    expect(result.findings[0]?.endsWith(`which has no pipefail: ${piped}`)).toBe(true);
  });

  it("names the step of a second pipe after one that has pipefail", async () => {
    const result = await lint({ ".github/workflows/made-up.yml": workflow(`        shell: bash\n        run: a | b\n      - name: Second\n        run: c | d\n`) });
    expect(result.findings).toEqual([`workflow-pipefail: .github/workflows/made-up.yml: jobs.made-up.steps[1] "Second" pipes under GitHub's default shell, bash -e {0}, which has no pipefail: c | d`]);
  });

  it("fails, and does not pass, a file it cannot read as YAML", async () => {
    const result = await lint({ ".github/workflows/made-up.yml": workflow("        run: a | b\n        run: c\n") });
    expect(result.status).toBe(1);
    expect(result.findings[0]).toMatch(/^workflow-pipefail: \.github\/workflows\/made-up\.yml: cannot be read as YAML/);
  });

  it("fails on a composite action step without shell: bash, and workflow-style defaults do not cover an action", async () => {
    const action = `name: made-up\nruns:\n  using: composite\n  steps:\n    - name: Made-up action step\n      shell: sh\n      run: a | b\n`;
    const withDefaults = `name: made-up\n${BASH_DEFAULTS}runs:\n  using: composite\n  steps:\n    - name: Made-up action step\n      run: a | b\n`;
    const result = await lint({ ".github/actions/made-up/action.yml": action, ".github/actions/other/action.yml": withDefaults });
    expect(result.findings).toEqual([
      `workflow-pipefail: .github/actions/made-up/action.yml: runs.steps[0] "Made-up action step" pipes under shell: sh, which has no pipefail: a | b`,
      `workflow-pipefail: .github/actions/other/action.yml: runs.steps[0] "Made-up action step" pipes under GitHub's default shell, bash -e {0}, which has no pipefail: a | b`,
    ]);
  });

  it.each([
    ["workflow defaults.run.shell: bash", workflow(PIPED_BLOCK, { top: BASH_DEFAULTS })],
    ["job defaults.run.shell: bash", workflow(PIPED_BLOCK, { jobKeys: "    defaults:\n      run:\n        shell: bash\n" })],
    ["the step's shell: bash", workflow(`        shell: bash\n${PIPED_BLOCK}`)],
    ["set -euo pipefail as the first line", workflow("        run: |\n          # made-up comment\n          set -euo pipefail\n          a | b\n")],
    ["set -o pipefail as the first line", workflow("        run: |\n          set -o pipefail\n          a | b\n")],
    ["only ||, in the script and in an expression", workflow("        run: |\n          a || b\n          echo ${{ github.head_ref || 'main' }}\n")],
    ["a | only in a comment line", workflow("        run: |\n          # a | b\n          a\n")],
    ["no run step pipes", workflow("        run: echo made-up\n")],
    ["a script line that looks like a run step", workflow("        run: |\n          set -euo pipefail\n          cat <<'EOF'\n          run: a | b\n          EOF\n")],
  ])("passes with %s", async (_case, text) => {
    expect(await lint({ ".github/workflows/made-up.yml": text })).toMatchObject({ status: 0, findings: [] });
  });
});
