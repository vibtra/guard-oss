import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const target = fileURLToPath(new URL("disabled-at-import.json", import.meta.url));
const NO_COMMENTS = "vibtra/no-comments";

process.env.NODE_PATH ??= path.join(root, "node_modules/.pnpm/node_modules");
const { ESLint } = await import("eslint");
const { default: config } = await import("../../eslint.config.mjs");
const { default: commentsOnly } = await import("./comments.config.mjs");
const { scriptFiles } = await import("./index.mjs");

const imported = config.filter((entry) => !entry.name?.startsWith("vibtra/disabled-at-import"));

const definitionOf = (plugins, ruleId) => {
  const name = Object.keys(plugins)
    .filter((key) => ruleId.startsWith(`${key}/`))
    .toSorted((a, b) => b.length - a.length)[0];
  return name === undefined ? undefined : plugins[name].rules?.[ruleId.slice(name.length + 1)];
};

const needingTypes = async () => {
  const probe = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: imported });
  const resolved = await probe.calculateConfigForFile(path.join(root, "type-information.tsx"));
  return Object.entries(resolved.rules)
    .filter(([ruleId, [severity]]) => severity !== 0 && definitionOf(resolved.plugins, ruleId)?.meta?.docs?.requiresTypeChecking === true)
    .map(([ruleId]) => ruleId)
    .toSorted();
};

const kindOf = (message) => {
  if (message.fatal === true || message.message.startsWith("Definition for rule")) return "blocking";
  if (message.ruleId === null) return /^Unused eslint-(?:disable|enable) directive/.test(message.message) ? "directive" : "blocking";
  if (message.ruleId === NO_COMMENTS) return "comment";
  return message.ruleId.startsWith("vibtra/") ? "blocking" : "rule";
};

const tally = (results) => {
  const counts = new Map();
  for (const result of results) {
    for (const message of result.messages) {
      if (kindOf(message) === "rule") counts.set(message.ruleId, (counts.get(message.ruleId) ?? 0) + 1);
    }
  }
  return counts;
};

const filesWith = (results, kind) =>
  results.filter((result) => result.messages.some((message) => kindOf(message) === kind)).map((result) => path.relative(root, result.filePath));

const describe = (results, kind, prefix = "") =>
  results.flatMap((result) =>
    result.messages.filter((message) => kindOf(message) === kind).map((message) => `${prefix}${path.relative(root, result.filePath)}:${message.line} ${message.message}`),
  );

const sorted = (counts) => Object.fromEntries([...counts].toSorted(([a], [b]) => a.localeCompare(b)));

const packageOf = (filePath) => {
  const parts = path.relative(root, filePath).split(path.sep);
  if (["apps", "packages", "tools"].includes(parts[0])) return parts.slice(0, 2).join("/");
  return parts.length > 1 ? parts[0] : ".";
};

const typeAware = await needingTypes();
const fixer = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: commentsOnly, fix: true });
const fixed = await fixer.lintFiles(["."]);
const leftover = fixed.flatMap((result) =>
  result.messages.filter((message) => message.ruleId === NO_COMMENTS).map((message) => `${path.relative(root, result.filePath)}:${message.line}`),
);
const outputs = new Map(fixed.filter((result) => result.output !== undefined).map((result) => [result.filePath, result.output]));

const lintBoth = async (off, quiet) => {
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      ...imported,
      { name: "vibtra/measure", files: scriptFiles, rules: Object.fromEntries([...typeAware, ...off].map((ruleId) => [ruleId, "off"])) },
      ...(quiet.length > 0 ? [{ name: "vibtra/measure-directives", files: quiet, linterOptions: { reportUnusedDisableDirectives: "off" } }] : []),
    ],
  });
  const now = await eslint.lintFiles(["."]);
  const later = [];
  for (const result of now) {
    const output = outputs.get(result.filePath);
    later.push(output === undefined ? result : (await eslint.lintText(output, { filePath: result.filePath }))[0]);
  }
  return { now, later };
};

const violations = new Map();
const afterOnly = new Map();
const directives = new Set();
let first;
let last;
for (let round = 0; ; round += 1) {
  last = await lintBoth([...violations.keys(), ...afterOnly.keys()], [...directives].toSorted());
  first ??= last;
  const now = tally(last.now);
  const later = tally(last.later);
  const unused = [...filesWith(last.now, "directive"), ...filesWith(last.later, "directive")];
  for (const [ruleId, total] of now) violations.set(ruleId, total);
  for (const [ruleId, total] of later) if (!now.has(ruleId)) afterOnly.set(ruleId, total);
  for (const file of unused) directives.add(file);
  if ((now.size === 0 && later.size === 0 && unused.length === 0) || round === 4) break;
}
await writeFile(
  target,
  `${JSON.stringify(
    {
      violations: sorted(violations),
      violationsAfterCommentRemoval: sorted(afterOnly),
      needsTypeInformation: typeAware,
      unusedDisableDirectives: [...directives].toSorted(),
    },
    undefined,
    2,
  )}\n`,
);

const comments = new Map();
for (const result of first.now) {
  const total = result.messages.filter((message) => message.ruleId === NO_COMMENTS).length;
  if (total > 0) comments.set(packageOf(result.filePath), (comments.get(packageOf(result.filePath)) ?? 0) + total);
}
const blocking = [...describe(last.now, "blocking"), ...describe(last.later, "blocking", "after comment removal: ")];
const remaining = [...describe(last.now, "rule"), ...describe(last.now, "directive"), ...describe(last.later, "rule", "after comment removal: ")];
const before = tally(first.now);
const rising = [...tally(first.later)].filter(([ruleId, total]) => total > (before.get(ruleId) ?? 0));
console.log(`files linted: ${first.now.length}`);
console.log(`rules turned off: ${violations.size} with violations, ${afterOnly.size} only after comment removal, ${typeAware.length} need type information`);
console.log(`files whose disable directives name a turned-off rule: ${directives.size}`);
for (const file of [...directives].toSorted()) console.log(`  ${file}`);
console.log(`${NO_COMMENTS} findings: ${[...comments.values()].reduce((sum, total) => sum + total, 0)}`);
for (const [name, total] of [...comments].toSorted(([a], [b]) => a.localeCompare(b))) console.log(`  ${name}: ${total}`);
console.log(`files the ${NO_COMMENTS} fixer changes: ${outputs.size}; comments it leaves: ${leftover.length}`);
for (const line of leftover) console.log(`  ${line}`);
console.log("rules that report more often after comment removal (all turned off):");
for (const [ruleId, total] of rising) console.log(`  ${ruleId}: ${before.get(ruleId) ?? 0} -> ${total}`);
console.log(`findings left with the final config: ${remaining.length}`);
for (const line of remaining) console.log(`  ${line}`);
console.log(`problems a rule switch cannot fix: ${blocking.length}`);
for (const line of blocking) console.log(`  ${line}`);
