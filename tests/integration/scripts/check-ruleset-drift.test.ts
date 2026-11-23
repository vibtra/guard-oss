import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-ruleset-drift.mjs", import.meta.url));
const TOKEN = "fake-token-ruleset-drift-test";

const RULESET = {
  name: "main",
  target: "branch",
  enforcement: "active",
  bypass_actors: [],
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
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

type Rule = { type: string; parameters?: Record<string, unknown>; ruleset_id?: number };
const SOURCE = { ruleset_source_type: "Repository", ruleset_source: "fixture/repo", ruleset_id: 42 };
const LIVE_RULES: Rule[] = [
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
const LIVE_RULESET = {
  id: 42,
  name: "main",
  target: "branch",
  source_type: "Repository",
  source: "fixture/repo",
  enforcement: "active",
  bypass_actors: [] as unknown[],
  conditions: { ref_name: { exclude: [], include: ["~DEFAULT_BRANCH"] } },
  current_user_can_bypass: "never",
};

type Api = { pages: unknown[]; rulesets: Record<string, unknown>; status: number; requests: { url: string; auth: string | undefined }[] };
const api: Api = { pages: [], rulesets: {}, status: 200, requests: [] };

const server: Server = createServer((request, response) => {
  api.requests.push({ url: request.url ?? "", auth: request.headers.authorization });
  const send = (status: number, body: unknown) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  };
  if (api.status !== 200) return send(api.status, { message: "Resource not accessible by integration" });
  const url = new URL(request.url ?? "", "http://fake");
  if (url.pathname === "/repos/fixture/repo/rules/branches/main") return send(200, api.pages[Number(url.searchParams.get("page")) - 1] ?? []);
  const ruleset = api.rulesets[url.pathname.replace("/repos/fixture/repo/rulesets/", "")];
  return ruleset === undefined ? send(404, { message: "Not Found" }) : send(200, ruleset);
});

let apiUrl = "";
let dir = "";

beforeAll(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  apiUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  dir = await mkdtemp(path.join(os.tmpdir(), "check-ruleset-drift-"));
  await writeFile(path.join(dir, "ruleset.json"), JSON.stringify(RULESET));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  Object.assign(api, { pages: [LIVE_RULES], rulesets: { "42": LIVE_RULESET }, status: 200, requests: [] });
});

const check = () =>
  new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, "--repo", "fixture/repo", "--ruleset", path.join(dir, "ruleset.json")], {
      env: { PATH: process.env.PATH ?? "", GITHUB_API_URL: apiUrl, GITHUB_TOKEN: TOKEN },
    });
    let [stdout, stderr] = ["", ""];
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });

const withRules = (change: (rule: Rule) => Rule) => [LIVE_RULES.map(change)];
const withChecks = (checks: unknown[]) =>
  withRules((rule) => (rule.type === "required_status_checks" ? { ...rule, parameters: { ...rule.parameters, required_status_checks: checks } } : rule));

const FIX = "gh api -X POST repos/fixture/repo/rulesets --input";

describe("check-ruleset-drift", () => {
  it("passes when GitHub enforces what the file says, in any order and with the API's extra defaults, and reads each ruleset with the token", async () => {
    const result = await check();
    expect(result).toMatchObject({ status: 0, stderr: "" });
    expect(api.requests.map((request) => request.url)).toEqual(["/repos/fixture/repo/rules/branches/main?per_page=100&page=1", "/repos/fixture/repo/rulesets/42"]);
    expect(api.requests.every((request) => request.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("reads every page of rules: a rule on page 2 counts", async () => {
    const filler = Array.from({ length: 100 - (LIVE_RULES.length - 1) }, () => ({ type: "deletion", ...SOURCE }));
    api.pages = [[...LIVE_RULES.filter((rule) => rule.type !== "merge_queue"), ...filler], LIVE_RULES.filter((rule) => rule.type === "merge_queue")];
    expect(await check()).toMatchObject({ status: 0, stderr: "" });
    expect(api.requests.map((request) => request.url)).toContain("/repos/fixture/repo/rules/branches/main?per_page=100&page=2");
  });

  it.each([403, 404, 500])("exits 2, not 0, when GitHub answers HTTP %i", async (status) => {
    api.status = status;
    const result = await check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`could not compare the rules: GET ${apiUrl}/repos/fixture/repo/rules/branches/main?per_page=100&page=1: HTTP ${status}`);
  });

  it("exits 2 when a rule names a ruleset that GitHub does not return", async () => {
    api.rulesets = {};
    const result = await check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("/repos/fixture/repo/rulesets/42: HTTP 404");
  });

  it("exits 2, not 0, when the rules response is not a list", async () => {
    api.pages = [{ message: "Not Found" }];
    const result = await check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("the response is not a list");
  });

  it("fails and names the check when GitHub does not require a check the file requires", async () => {
    api.pages = withChecks([{ context: "gates", integration_id: 15368 }]);
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required checks in the file that GitHub does not require: mutation (app 15368).");
    expect(result.stderr).toContain(FIX);
  });

  it("fails and names the check when GitHub requires a check the file does not list", async () => {
    api.pages = withChecks([...(LIVE_RULES[1]?.parameters?.required_status_checks as unknown[]), { context: "deploy", integration_id: 15368 }]);
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required checks GitHub requires that the file does not list: deploy (app 15368).");
  });

  it("fails when a required check accepts any app, or another app, instead of the one the file pins", async () => {
    api.pages = withChecks([{ context: "gates" }, { context: "mutation", integration_id: 99 }]);
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required checks in the file that GitHub does not require: gates (app 15368), mutation (app 15368).");
    expect(result.stderr).toContain("required checks GitHub requires that the file does not list: gates (any app), mutation (app 99).");
  });

  it("fails and says merge queue on versus off when GitHub has no merge queue", async () => {
    api.pages = [LIVE_RULES.filter((rule) => rule.type !== "merge_queue")];
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("merge queue: the file has it on, GitHub has it off.");
    expect(result.stderr).toContain(FIX);
  });

  it("fails when GitHub enforces a rule type the file does not have", async () => {
    api.pages = [[...LIVE_RULES, { type: "required_linear_history", ...SOURCE }]];
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rule types: the file has deletion, merge_queue, pull_request, required_status_checks, GitHub has deletion, merge_queue, pull_request, required_linear_history, required_status_checks.");
  });

  it("fails and names every side when GitHub enforces no rules at all", async () => {
    api.pages = [[]];
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("rule types: the file has deletion, merge_queue, pull_request, required_status_checks, GitHub has none.");
    expect(result.stderr).toContain("required checks in the file that GitHub does not require: gates (app 15368), mutation (app 15368).");
    expect(result.stderr).toContain(FIX);
  });

  it("fails when GitHub lowers a parameter the file sets, and says not set when GitHub has none", async () => {
    api.pages = withRules((rule) =>
      rule.type === "pull_request" ? { ...rule, parameters: { required_approving_review_count: 0 } } : rule,
    );
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("pull_request.required_approving_review_count: the file has 1, GitHub has 0.");
    expect(result.stderr).toContain("pull_request.require_code_owner_review: the file has true, GitHub has not set.");
  });

  it("fails and names the actor when the ruleset gains a bypass actor", async () => {
    api.rulesets = { "42": { ...LIVE_RULESET, bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }] } };
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ruleset 42 ("main") bypass actors: the file has none, GitHub has RepositoryRole 5 (always).');
  });

  it("fails closed with the reason, exit 2, when the token cannot read the bypass actors", async () => {
    const { bypass_actors: _hidden, ...withoutBypass } = LIVE_RULESET;
    api.rulesets = { "42": withoutBypass };
    const result = await check();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('ruleset 42 ("main") bypass actors: this token cannot read them.');
  });

  it("fails when the ruleset is only evaluated, or targets other branches", async () => {
    api.rulesets = { "42": { ...LIVE_RULESET, enforcement: "evaluate", conditions: { ref_name: { include: ["~ALL"], exclude: ["refs/heads/main"] } } } };
    const result = await check();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('ruleset 42 ("main") enforcement: the file has "active", GitHub has "evaluate".');
    expect(result.stderr).toContain('ruleset 42 ("main") conditions: the file has {"ref_name":{"exclude":[],"include":["~DEFAULT_BRANCH"]}}, GitHub has {"ref_name":{"exclude":["refs/heads/main"],"include":["~ALL"]}}.');
  });
});
