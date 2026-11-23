import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-ruleset-drift.mjs", import.meta.url));
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RULESET = {
  name: "main",
  target: "branch",
  enforcement: "active",
  rules: [
    { type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: true } },
    {
      type: "required_status_checks",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [
          { context: "gates", integration_id: 15368 },
          { context: "mutation", integration_id: 15368 },
        ],
      },
    },
    { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN" } },
    { type: "deletion" },
  ],
};

const SOURCE = { ruleset_source_type: "Repository", ruleset_source: "fixture/repo", ruleset_id: 42 };
const LIVE = [
  { type: "pull_request", parameters: { required_approving_review_count: 1, require_code_owner_review: true, required_reviewers: [], allowed_merge_methods: ["squash"] }, ...SOURCE },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      do_not_enforce_on_create: false,
      required_status_checks: [
        { context: "mutation", integration_id: 15368 },
        { context: "gates", integration_id: 15368 },
      ],
    },
    ...SOURCE,
  },
  { type: "merge_queue", parameters: { merge_method: "SQUASH", grouping_strategy: "ALLGREEN", max_entries_to_build: 5 }, ...SOURCE },
  { type: "deletion", ...SOURCE },
];

const check = async (live: unknown) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "check-ruleset-drift-"));
  dirs.push(dir);
  await writeFile(path.join(dir, "ruleset.json"), JSON.stringify(RULESET));
  await writeFile(path.join(dir, "live.json"), JSON.stringify(live));
  const result = spawnSync(process.execPath, [SCRIPT, "--repo", "fixture/repo", "--ruleset", path.join(dir, "ruleset.json"), "--live", path.join(dir, "live.json")], { encoding: "utf8" });
  return { status: result.status, stderr: result.stderr };
};

const FIX = "gh api -X POST repos/fixture/repo/rulesets --input";

describe("check-ruleset-drift", () => {
  it("passes when GitHub enforces what the file says, in any order and with the API's extra defaults", async () => {
    expect(await check(LIVE)).toEqual({ status: 0, stderr: "" });
  });

  it("fails and names the context when GitHub does not require a check the file requires", async () => {
    const live = LIVE.map((rule) =>
      rule.type === "required_status_checks" ? { ...rule, parameters: { ...rule.parameters, required_status_checks: [{ context: "gates", integration_id: 15368 }] } } : rule,
    );
    const result = await check(live);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required checks in the file that GitHub does not require: mutation.");
    expect(result.stderr).toContain(FIX);
  });

  it("fails and says merge queue on versus off when GitHub has no merge queue", async () => {
    const result = await check(LIVE.filter((rule) => rule.type !== "merge_queue"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("merge queue: the file has it on, GitHub has it off.");
    expect(result.stderr).toContain(FIX);
  });

  it("fails and names every side when GitHub enforces no rules at all", async () => {
    const result = await check([]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rule types: the file has deletion, merge_queue, pull_request, required_status_checks, GitHub has none.");
    expect(result.stderr).toContain("required checks in the file that GitHub does not require: gates, mutation.");
    expect(result.stderr).toContain(FIX);
  });

  it("fails when GitHub lowers a parameter the file sets", async () => {
    const live = LIVE.map((rule) => (rule.type === "pull_request" ? { ...rule, parameters: { ...rule.parameters, required_approving_review_count: 0 } } : rule));
    const result = await check(live);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull_request.required_approving_review_count: the file has 1, GitHub has 0.");
  });

  it("exits 2, not 0, when the live response is not a list of rules", async () => {
    const result = await check({ message: "Not Found" });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("could not compare the rules");
  });
});
