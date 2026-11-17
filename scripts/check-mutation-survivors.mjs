import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = path.resolve(process.argv[2] ?? path.join(root, "reports/mutation/mutation.json"));
const recordPath = path.resolve(process.argv[3] ?? path.join(root, "tests/mutation/survivors.json"));
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
const mutated = new Set();
for (const [file, result] of Object.entries(report.files)) {
  const name = normalise(file);
  mutated.add(name);
  for (const mutant of result.mutants) {
    if (!SURVIVING.has(mutant.status)) continue;
    const entry = {
      file: name,
      mutator: mutant.mutatorName,
      sourceLine: result.source.split("\n")[mutant.location.start.line - 1].trim(),
      original: originalOf(result.source, mutant.location),
      replacement: mutant.replacement ?? "",
      line: mutant.location.start.line,
      status: mutant.status,
    };
    surviving.set(keyOf(entry), entry);
  }
}

const recorded = new Map();
const problems = [];
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
for (const [key, entry] of recorded) {
  if (surviving.has(key)) continue;
  problems.push(`mutation-survivors: ${entry.file} ${entry.mutator} "${entry.original}" -> "${entry.replacement}" is recorded but no longer survives. Remove it from ${path.relative(root, recordPath)}.`);
}

for (const problem of problems) console.error(problem);
if (problems.length > 0) process.exit(1);
console.log(`mutation-survivors: ${surviving.size} surviving mutant(s) in ${mutated.size} file(s), each recorded with a reason`);
