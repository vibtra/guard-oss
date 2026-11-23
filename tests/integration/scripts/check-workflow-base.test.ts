import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-workflow-base.mjs", import.meta.url));
const ACTION = ".github/actions/pr-base/action.yml";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "workflow-base-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
};

const check = (root?: string) => spawnSync(process.execPath, root === undefined ? [SCRIPT] : [SCRIPT, root], { encoding: "utf8" });
const workflow = (line: string) => `name: made-up\non: pull_request\njobs:\n  made-up:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Made-up step\n        env:\n          ${line}\n        run: echo made-up\n`;
const findings = (stderr: string) => stderr.split("\n").filter((line) => line.startsWith("workflow-base: "));

describe("check-workflow-base", () => {
  it("passes this tree: only the pr-base action reads the PR's base", () => {
    const result = check();
    expect([result.status, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toContain(`only ${ACTION} reads the PR's base`);
  });

  it.each([
    ["guard-oss ci.yml before VIB-102 (mac and landing filter, mutation-paths)", "PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}"],
    ["guard-oss ci.yml before VIB-102 (selection shadow report)", "BASE: ${{ github.event.pull_request.base.sha }}"],
    ["guard gate-files and tripwire before 5a1bd728 and a72865b6 (the event's base branch)", "BASE_REF: ${{ github.event.pull_request.base.ref }}"],
    ["guard gate-files, tripwire and classifier before d4739403, 7d858643 and 82737af7 (the pulls API's base.sha)", `base_sha="$(jq -er '.base.sha | select(test("^[0-9a-f]{40}$"))' <<< "$pr")"`],
    ["guard-oss gate workflows before VIB-102 (their own copy of the base branch read)", `"\${GITHUB_API_URL}/repos/\${REPO}/pulls/\${PR_NUMBER}" | jq -er '.base.ref')"`],
    ["the event file read with jq", `BASE: $(jq -r .pull_request.base.sha "$GITHUB_EVENT_PATH")`],
    ["bracket access", "BASE: ${{ github.event.pull_request['base']['sha'] }}"],
    ["the base_ref shorthand", "BASE: ${{ github.base_ref }}"],
    ["the runner's base branch variable (QA round 1)", 'run: git diff "origin/${GITHUB_BASE_REF}...HEAD"'],
    ["bracket access to the base's sha (QA round 1)", "BASE: ${{ github.event.pull_request.base['sha'] }}"],
    ["bracket access to base_ref (QA round 1)", "BASE: ${{ github['base_ref'] }}"],
    ["gh pr view's base commit (QA round 1)", "run: gh pr view --json baseRefOid"],
    ["gh pr view's base branch (QA round 1)", "run: gh pr view --json baseRefName"],
  ])("fails on %s and names the pr-base action", async (_, line) => {
    const result = check(await tree({ ".github/workflows/made-up.yml": workflow(line) }));
    expect(result.status).toBe(1);
    expect(findings(result.stderr)).toEqual([`workflow-base: .github/workflows/made-up.yml:9: ${line}`]);
    expect(result.stderr).toContain("uses: ./.github/actions/pr-base");
    expect(result.stderr).toContain("steps.base.outputs.merge_base");
  });

  it("fails on a base read in another composite action or a .yaml workflow, naming each file and line", async () => {
    const result = check(
      await tree({
        ".github/actions/made-up/action.yml": "runs:\n  using: composite\n  steps:\n    - run: echo ${{ github.event.pull_request.base.sha }}\n      shell: bash\n",
        ".github/workflows/made-up.yaml": workflow("BASE: ${{ github.event.pull_request.base.ref }}"),
      }),
    );
    expect(result.status).toBe(1);
    expect(findings(result.stderr)).toEqual([
      "workflow-base: .github/actions/made-up/action.yml:4: - run: echo ${{ github.event.pull_request.base.sha }}",
      "workflow-base: .github/workflows/made-up.yaml:9: BASE: ${{ github.event.pull_request.base.ref }}",
    ]);
  });

  it("passes the pr-base action's own read and the outputs, head SHA, merge base and base-change fields other steps use", async () => {
    const result = check(
      await tree({
        [ACTION]: "runs:\n  using: composite\n  steps:\n    - run: jq -er '.base.ref' pull.json\n      shell: bash\n",
        ".github/workflows/made-up.yml": [
          "MERGE_BASE: ${{ steps.base.outputs.merge_base }}",
          "HEAD_SHA: ${{ github.event.pull_request.head.sha }}",
          "BASE_CHANGED: ${{ github.event.changes.base }}",
          'BASE_COMMIT: $(git rev-parse "$merge_base.sha")',
          "REF: refs/remotes/pr/base",
        ]
          .map(workflow)
          .join(""),
      }),
    );
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });
});
