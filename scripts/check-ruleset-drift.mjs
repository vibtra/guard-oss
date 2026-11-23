import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE = "usage: node scripts/check-ruleset-drift.mjs --repo <owner/name> [--branch main] [--ruleset .github/rulesets/main.json]";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = process.env.GITHUB_API_URL ?? "https://api.github.com";
const PAGE = 100;

const checkKey = (check) => `${check.context} (${check.integration_id == null ? "any app" : `app ${check.integration_id}`})`;
const checksOf = (rules) => new Set(rules.filter((rule) => rule.type === "required_status_checks").flatMap((rule) => rule.parameters?.required_status_checks ?? []).map(checkKey));
const typesOf = (rules) => new Set(rules.map((rule) => rule.type));
const missingFrom = (left, right) => [...left].filter((item) => !right.has(item)).sort();
const list = (items) => (items.length === 0 ? "none" : items.join(", "));
const onOff = (on) => (on ? "on" : "off");
const shown = (value) => (value === undefined ? "not set" : JSON.stringify(value));
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).sort().join(",")}]`
    : value !== null && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value ?? null);
const actors = (bypass) => bypass.map((actor) => `${actor.actor_type} ${actor.actor_id ?? "any"} (${actor.bypass_mode})`);

const rulesDrift = (committedRules, liveRules) => {
  const findings = [];
  const [fileTypes, liveTypes] = [typesOf(committedRules), typesOf(liveRules)];
  if (fileTypes.has("merge_queue") !== liveTypes.has("merge_queue")) findings.push(`merge queue: the file has it ${onOff(fileTypes.has("merge_queue"))}, GitHub has it ${onOff(liveTypes.has("merge_queue"))}.`);
  if (missingFrom(fileTypes, liveTypes).length + missingFrom(liveTypes, fileTypes).length > 0) findings.push(`rule types: the file has ${list([...fileTypes].sort())}, GitHub has ${list([...liveTypes].sort())}.`);
  const [fileChecks, liveChecks] = [checksOf(committedRules), checksOf(liveRules)];
  const [checksOnlyInFile, checksOnlyLive] = [missingFrom(fileChecks, liveChecks), missingFrom(liveChecks, fileChecks)];
  if (checksOnlyInFile.length > 0) findings.push(`required checks in the file that GitHub does not require: ${list(checksOnlyInFile)}.`);
  if (checksOnlyLive.length > 0) findings.push(`required checks GitHub requires that the file does not list: ${list(checksOnlyLive)}.`);
  for (const rule of committedRules) {
    const live = liveRules.filter((candidate) => candidate.type === rule.type);
    if (live.length === 0) continue;
    for (const [key, value] of Object.entries(rule.parameters ?? {})) {
      if (value === null || typeof value === "object") continue;
      if (live.some((candidate) => candidate.parameters?.[key] === value)) continue;
      findings.push(`${rule.type}.${key}: the file has ${JSON.stringify(value)}, GitHub has ${list(live.map((candidate) => shown(candidate.parameters?.[key])))}.`);
    }
  }
  return findings;
};

const rulesetDrift = (committed, rulesets) => {
  const findings = [];
  const unreadable = [];
  for (const ruleset of rulesets) {
    const name = `ruleset ${ruleset.id} (${JSON.stringify(ruleset.name)})`;
    if (ruleset.enforcement !== committed.enforcement) findings.push(`${name} enforcement: the file has ${shown(committed.enforcement)}, GitHub has ${shown(ruleset.enforcement)}.`);
    if (canonical(ruleset.conditions) !== canonical(committed.conditions)) findings.push(`${name} conditions: the file has ${canonical(committed.conditions)}, GitHub has ${canonical(ruleset.conditions)}.`);
    if (!Array.isArray(ruleset.bypass_actors)) {
      unreadable.push(
        `${name} bypass actors: this token cannot read them. GitHub returns bypass_actors only to a caller with write access to the ruleset, and a workflow's job token cannot have that, so an actor who can skip every rule above could be added unseen.`,
      );
    } else if (canonical(actors(ruleset.bypass_actors)) !== canonical(actors(committed.bypass_actors ?? []))) {
      findings.push(`${name} bypass actors: the file has ${list(actors(committed.bypass_actors ?? []).sort())}, GitHub has ${list(actors(ruleset.bypass_actors).sort())}.`);
    }
  }
  return { findings, unreadable };
};

const get = async (url, token) => {
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
  return response.json();
};

const fetchLive = async (repo, branch, token) => {
  const rules = [];
  for (let page = 1; ; page++) {
    const url = `${API}/repos/${repo}/rules/branches/${encodeURIComponent(branch)}?per_page=${PAGE}&page=${page}`;
    const batch = await get(url, token);
    if (!Array.isArray(batch)) throw new Error(`GET ${url}: the response is not a list`);
    rules.push(...batch);
    if (batch.length < PAGE) break;
  }
  const ids = [...new Set(rules.map((rule) => rule.ruleset_id))].sort((a, b) => a - b);
  const rulesets = await Promise.all(ids.map((id) => get(`${API}/repos/${repo}/rulesets/${id}`, token)));
  return { rules, rulesets };
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      repo: { type: "string", default: process.env.GITHUB_REPOSITORY },
      branch: { type: "string", default: "main" },
      ruleset: { type: "string", default: path.join(ROOT, ".github/rulesets/main.json") },
    },
  });
  if (!values.repo) throw new Error(USAGE);
  const committed = JSON.parse(readFileSync(values.ruleset, "utf8"));
  if (!Array.isArray(committed.rules)) throw new Error(`${values.ruleset} has no rules list`);
  const live = await fetchLive(values.repo, values.branch, process.env.GITHUB_TOKEN);
  const file = path.relative(ROOT, path.resolve(values.ruleset)) || values.ruleset;
  const { findings: rulesetFindings, unreadable } = rulesetDrift(committed, live.rulesets);
  const findings = [...rulesDrift(committed.rules, live.rules), ...rulesetFindings];
  if (findings.length === 0 && unreadable.length === 0) {
    console.log(`The rules GitHub enforces on ${values.branch} in ${values.repo} match ${file}, and so do the enforcement, conditions and bypass actors of each ruleset that sets them.`);
    return 0;
  }
  const report = [];
  if (findings.length > 0) {
    report.push(
      `The rules GitHub enforces on ${values.branch} in ${values.repo} differ from ${file}:`,
      ...findings.map((finding) => `- ${finding}`),
      `Until they match, a check that ${file} calls required does not block a merge.`,
      "Fix it one of two ways:",
      `- A repo admin applies the file: gh api -X POST repos/${values.repo}/rulesets --input ${file}`,
      `  If a ruleset for ${values.branch} exists already, update it instead: gh api -X PUT repos/${values.repo}/rulesets/<id> --input ${file}`,
      `- Or change ${file} to match GitHub in a reviewed PR.`,
    );
  }
  if (unreadable.length > 0) {
    report.push(
      "check-ruleset-drift could not compare everything, so it fails:",
      ...unreadable.map((reason) => `- ${reason}`),
      `To compare them, run it with the token of a repo admin: GITHUB_TOKEN=$(gh auth token) node scripts/check-ruleset-drift.mjs --repo ${values.repo}`,
    );
  }
  console.error(report.join("\n"));
  return unreadable.length > 0 ? 2 : 1;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`check-ruleset-drift could not compare the rules: ${error.message}`);
    process.exit(2);
  },
);
