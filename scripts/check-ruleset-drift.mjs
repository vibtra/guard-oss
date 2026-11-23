import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = "usage: node scripts/check-ruleset-drift.mjs --repo <owner/name> [--branch main] [--ruleset .github/rulesets/main.json] [--live <rules.json>]";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAGE = 100;

const contextsOf = (rules) => new Set(rules.filter((rule) => rule.type === "required_status_checks").flatMap((rule) => rule.parameters?.required_status_checks ?? []).map((check) => check.context));
const typesOf = (rules) => new Set(rules.map((rule) => rule.type));
const missingFrom = (left, right) => [...left].filter((item) => !right.has(item)).sort();
const list = (items) => (items.length === 0 ? "none" : items.join(", "));
const onOff = (on) => (on ? "on" : "off");

const drift = (committedRules, liveRules) => {
  const findings = [];
  const [fileTypes, liveTypes] = [typesOf(committedRules), typesOf(liveRules)];
  if (fileTypes.has("merge_queue") !== liveTypes.has("merge_queue")) findings.push(`merge queue: the file has it ${onOff(fileTypes.has("merge_queue"))}, GitHub has it ${onOff(liveTypes.has("merge_queue"))}.`);
  const [typesOnlyInFile, typesOnlyLive] = [missingFrom(fileTypes, liveTypes), missingFrom(liveTypes, fileTypes)];
  if (typesOnlyInFile.length + typesOnlyLive.length > 0) findings.push(`rule types: the file has ${list([...fileTypes].sort())}, GitHub has ${list([...liveTypes].sort())}.`);
  const [fileContexts, liveContexts] = [contextsOf(committedRules), contextsOf(liveRules)];
  const [contextsOnlyInFile, contextsOnlyLive] = [missingFrom(fileContexts, liveContexts), missingFrom(liveContexts, fileContexts)];
  if (contextsOnlyInFile.length > 0) findings.push(`required checks in the file that GitHub does not require: ${list(contextsOnlyInFile)}.`);
  if (contextsOnlyLive.length > 0) findings.push(`required checks GitHub requires that the file does not list: ${list(contextsOnlyLive)}.`);
  for (const rule of committedRules) {
    const live = liveRules.filter((candidate) => candidate.type === rule.type);
    if (live.length === 0) continue;
    for (const [key, value] of Object.entries(rule.parameters ?? {})) {
      if (value === null || typeof value === "object") continue;
      if (live.some((candidate) => candidate.parameters?.[key] === value)) continue;
      findings.push(`${rule.type}.${key}: the file has ${JSON.stringify(value)}, GitHub has ${list(live.map((candidate) => JSON.stringify(candidate.parameters?.[key])))}.`);
    }
  }
  return findings;
};

const fetchRules = async (repo, branch, token) => {
  const rules = [];
  for (let page = 1; ; page++) {
    const url = `${process.env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=${PAGE}&page=${page}`;
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "vibtra-guard-ruleset-drift",
        "x-github-api-version": "2022-11-28",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status} ${await response.text()}`);
    const batch = await response.json();
    if (!Array.isArray(batch)) throw new Error(`GET ${url}: the response is not a list`);
    rules.push(...batch);
    if (batch.length < PAGE) return rules;
  }
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY },
      branch: { type: "string", default: "main" },
      ruleset: { type: "string", default: path.join(ROOT, ".github/rulesets/main.json") },
      live: { type: "string" },
    },
  });
  if (!values.repo) throw new Error(USAGE);
  const committed = JSON.parse(readFileSync(values.ruleset, "utf8"));
  if (!Array.isArray(committed.rules)) throw new Error(`${values.ruleset} has no rules list`);
  const live = values.live === undefined ? await fetchRules(values.repo, values.branch, process.env.GITHUB_TOKEN) : JSON.parse(readFileSync(values.live, "utf8"));
  if (!Array.isArray(live)) throw new Error(`${values.live} is not a list of rules`);
  const file = path.relative(ROOT, path.resolve(values.ruleset)) || values.ruleset;
  const findings = drift(committed.rules, live);
  if (findings.length === 0) {
    console.log(`The rules GitHub enforces on ${values.branch} in ${values.repo} match ${file}.`);
    return 0;
  }
  console.error(
    [
      `The rules GitHub enforces on ${values.branch} in ${values.repo} differ from ${file}:`,
      ...findings.map((finding) => `- ${finding}`),
      `Until they match, a check that ${file} calls required does not block a merge.`,
      "Fix it one of two ways:",
      `- A repo admin applies the file: gh api -X POST repos/${values.repo}/rulesets --input ${file}`,
      `  If a ruleset for ${values.branch} exists already, update it instead: gh api -X PUT repos/${values.repo}/rulesets/<id> --input ${file}`,
      `- Or change ${file} to match GitHub in a reviewed PR.`,
    ].join("\n"),
  );
  return 1;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`check-ruleset-drift could not compare the rules: ${error.message}`);
    process.exit(2);
  },
);
