import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { config: { type: "string" }, partial: { type: "boolean", default: false } } });
const reportPath = path.resolve(positionals[0] ?? path.join(root, "reports/mutation/mutation.json"));
const recordPath = path.resolve(positionals[1] ?? path.join(root, "tests/mutation/survivors.json"));
const SURVIVING = new Set(["Survived", "NoCoverage"]);

const report = JSON.parse(readFileSync(reportPath, "utf8"));
const record = JSON.parse(readFileSync(recordPath, "utf8"));

const originalOf = (source, location) => {
  const lines = source.split("\n");
  const { start, end } = location;
  if (start.line === end.line) return lines[start.line - 1].slice(start.column - 1, end.column - 1);
  return [lines[start.line - 1].slice(start.column - 1), ...lines.slice(start.line, end.line - 1), lines[end.line - 1].slice(0, end.column - 1)].join("\n");
};

const keyOf = (entry) => JSON.stringify([entry.file, entry.mutator, entry.sourceLine, entry.original, entry.replacement]);
const normalise = (file) => path.relative(root, path.resolve(root, file)).split(path.sep).join("/");

const surviving = new Map();
const timedOut = new Map();
const mutated = new Set();
for (const [file, result] of Object.entries(report.files)) {
  const name = normalise(file);
  mutated.add(name);
  for (const mutant of result.mutants) {
    if (!SURVIVING.has(mutant.status) && mutant.status !== "Timeout") continue;
    const entry = {
      file: name,
      mutator: mutant.mutatorName,
      sourceLine: result.source.split("\n")[mutant.location.start.line - 1].trim(),
      original: originalOf(result.source, mutant.location),
      replacement: mutant.replacement ?? "",
      line: mutant.location.start.line,
      status: mutant.status,
    };
    (mutant.status === "Timeout" ? timedOut : surviving).set(keyOf(entry), entry);
  }
}

const recorded = new Map();
const problems = [];
if (options.config !== undefined) {
  const configPath = path.resolve(options.config);
  const expected = JSON.parse(readFileSync(configPath, "utf8")).mutate.map((entry) => {
    if (/[*?[{]/.test(entry)) problems.push(`mutation-survivors: "${entry}" in ${path.relative(root, configPath)} is a glob. List each mutated file by path, so a missing file cannot pass unnoticed.`);
    return normalise(entry.replace(/:\d+(-\d+)?$/, ""));
  });
  for (const file of mutated) {
    if (!expected.includes(file)) problems.push(`mutation-survivors: the report mutated ${file}, which is not in the mutate list of ${path.relative(root, configPath)}.`);
  }
  const missing = expected.filter((file) => !mutated.has(file));
  if (options.partial && mutated.size === 0) problems.push("mutation-survivors: the report mutated no file.");
  if (!options.partial) {
    for (const file of missing) problems.push(`mutation-survivors: ${file} is in the mutate list of ${path.relative(root, configPath)} but is missing from the report, so it was not mutated. Fix the path in the mutate list.`);
  }
}
for (const entry of record.survivors) {
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) problems.push(`mutation-survivors: ${entry.file} ${entry.mutator} "${entry.original}" has no reason. Say why no test can kill it.`);
  if (mutated.has(entry.file)) recorded.set(keyOf(entry), entry);
}

for (const [key, entry] of surviving) {
  if (recorded.has(key)) continue;
  problems.push(
    `mutation-survivors: ${entry.status} mutant at ${entry.file}:${entry.line} (${entry.mutator}): "${entry.original}" -> "${entry.replacement}". Add a test that kills it, or record it in ${path.relative(root, recordPath)} with the reason no test can.`,
  );
}
const timedOutRecords = [];
for (const [key, entry] of recorded) {
  if (surviving.has(key)) continue;
  if (timedOut.has(key)) {
    timedOutRecords.push({ ...entry, line: timedOut.get(key).line });
    console.warn(`mutation-survivors: warning: recorded mutant at ${entry.file}:${timedOut.get(key).line} (${entry.mutator}) timed out. A timeout does not show that a test kills it, so the record stays.`);
    continue;
  }
  problems.push(`mutation-survivors: ${entry.file} ${entry.mutator} "${entry.original}" -> "${entry.replacement}" is recorded but no longer survives. Remove it from ${path.relative(root, recordPath)}.`);
}

const cell = (text) => `\`${String(text).replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\n/g, " ")}\``;
if (process.env.GITHUB_STEP_SUMMARY && timedOutRecords.length > 0) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    [
      `### Recorded survivors that timed out (${timedOutRecords.length})`,
      "",
      "A timeout does not show that a test kills the mutant, so each record stays.",
      "",
      "| File | Line | Mutator | Original | Replacement |",
      "| --- | --- | --- | --- | --- |",
      ...timedOutRecords.map((entry) => `| ${entry.file} | ${entry.line} | ${entry.mutator} | ${cell(entry.original)} | ${cell(entry.replacement)} |`),
      "",
    ].join("\n"),
  );
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`mutation-survivors: ${surviving.size} surviving mutant(s) in ${mutated.size} file(s), each recorded with a reason`);
