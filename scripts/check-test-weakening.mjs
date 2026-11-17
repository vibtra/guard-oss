import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const TEST_FILE = [/(^|\/)tests?\//, /(^|\/)__tests__\//, /\.(test|spec)\.[cm]?[jt]sx?$/, /_test\.go$/, /(^|\/)test_[^/]*\.py$/, /_test\.py$/, /Tests?\.swift$/];
const WEAKENING_REMOVAL = /expect\(|assert|toThrow|rejects|\.resolves\b|\.(to|not\.)[A-Z]\w*\(/;
const WEAKENING_ADDITIONS = [
  { kind: "added a skip, only or todo", pattern: /\.(skip|only|todo)(If|Unless)?\b|\b(runIf|skipIf)\(|\bx(it|describe|test)\(|\bf(it|describe)\(|XCTSkip|\bt\.Skip(Now|f)?\(|pytest\.mark\.(skip|xfail)|unittest\.skip/ },
  { kind: "added a return", pattern: /^\s*return\b/ },
  { kind: "added a catch", pattern: /\bcatch\s*[({]/ },
];
const MIN_REASON = 20;
const HEADING = /^##\s+Tests changed\s*$/i;
const SKIPPED_EVENTS = new Map([
  ["workflow_dispatch", "workflow_dispatch run: there is no pull request body to read, so the test-weakening check is skipped."],
  ["schedule", "Scheduled run: there is no pull request body to read, so the test-weakening check is skipped."],
  ["push", "Push run: the pull request was checked before it merged, so the test-weakening check is skipped."],
]);

const usage = "usage: node scripts/check-test-weakening.mjs --base <git-ref> [--head <git-ref>] [--event <name>] [--body-file <path>] [--repo <dir>]";

const isTestFile = (file) => TEST_FILE.some((pattern) => pattern.test(file));

const git = (repo, args) => execFileSync("git", ["-C", repo, "-c", "core.quotePath=false", ...args], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });

const unquote = (raw) => (raw.startsWith('"') ? JSON.parse(raw) : raw);
const pathOf = (raw, prefix) => {
  const value = unquote(raw.trim());
  return value === "/dev/null" ? null : value.slice(prefix.length);
};

const parseDiff = (text) => {
  const files = [];
  let current = null;
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of text.split("\n")) {
    if (current !== null && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("-") && oldLeft > 0) {
        current.removed.push({ line: oldLine, text: line.slice(1) });
        oldLine += 1;
        oldLeft -= 1;
      } else if (line.startsWith("+") && newLeft > 0) {
        current.added.push({ line: newLine, text: line.slice(1) });
        newLine += 1;
        newLeft -= 1;
      } else if (line.startsWith(" ")) {
        oldLine += 1;
        newLine += 1;
        oldLeft -= 1;
        newLeft -= 1;
      }
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = { oldPath: undefined, newPath: undefined, renamed: false, deleted: false, removed: [], added: [] };
      files.push(current);
      continue;
    }
    if (current === null) continue;
    if (line.startsWith("--- ")) {
      current.oldPath = pathOf(line.slice(4), "a/");
      continue;
    }
    if (line.startsWith("+++ ")) {
      current.newPath = pathOf(line.slice(4), "b/");
      if (current.newPath === null) current.deleted = true;
      continue;
    }
    if (line.startsWith("rename from ")) {
      current.oldPath = unquote(line.slice("rename from ".length));
      current.renamed = true;
    }
    if (line.startsWith("rename to ")) current.newPath = unquote(line.slice("rename to ".length));
    if (line.startsWith("new file mode")) current.oldPath = null;
    if (line.startsWith("deleted file mode")) current.deleted = true;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
    }
  }
  return files;
};

const findWeakening = (files) => {
  const findings = [];
  for (const file of files) {
    if (file.oldPath === null || file.oldPath === undefined) continue;
    if (!isTestFile(file.oldPath)) continue;
    const name = file.deleted ? file.oldPath : (file.newPath ?? file.oldPath);
    if (file.deleted) findings.push({ file: name, where: file.oldPath, kind: "deleted a test file", text: file.oldPath });
    else if (file.renamed) findings.push({ file: name, where: file.oldPath, kind: "renamed a test file", text: `${file.oldPath} -> ${name}` });
    for (const { line, text } of file.removed) {
      if (WEAKENING_REMOVAL.test(text)) findings.push({ file: name, where: `${file.oldPath}:${line}`, kind: "removed or changed an assertion", text: text.trim() });
    }
    if (file.deleted) continue;
    for (const { line, text } of file.added) {
      const hit = WEAKENING_ADDITIONS.find(({ pattern }) => pattern.test(text));
      if (hit !== undefined) findings.push({ file: name, where: `${name}:${line}`, kind: hit.kind, text: text.trim() });
    }
  }
  return findings;
};

const cellsOf = (row) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

const bare = (cell) => cell.replace(/^`+|`+$/g, "").trim();

const declaredFiles = (body) => {
  const lines = (body ?? "").replace(/\r\n/g, "\n").split("\n");
  const start = lines.findIndex((line) => HEADING.test(line.trim()));
  if (start === -1) return { found: false, files: new Map() };
  const files = new Map();
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,2}\s/.test(line.trim())) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = cellsOf(line);
    if (cells.every((cell) => /^:?-{3,}:?$/.test(cell) || cell === "")) continue;
    if (cells.length < 2) continue;
    const file = bare(cells[0]);
    const reason = cells[cells.length - 1];
    if (/^file$/i.test(file)) continue;
    if (reason.length < MIN_REASON) continue;
    files.set(file, reason);
  }
  return { found: true, files };
};

const main = () => {
  let options;
  try {
    ({ values: options } = parseArgs({
      options: { base: { type: "string" }, head: { type: "string" }, event: { type: "string" }, "body-file": { type: "string" }, repo: { type: "string" } },
    }));
  } catch (error) {
    console.error(`test-weakening: ${error.message}\n${usage}`);
    return 2;
  }
  const event = options.event ?? process.env.EVENT_NAME ?? process.env.GITHUB_EVENT_NAME ?? "pull_request";
  const skipped = SKIPPED_EVENTS.get(event);
  if (skipped !== undefined) {
    console.log(`test-weakening: ${skipped}`);
    return 0;
  }
  if (options.base === undefined || options.base === "") {
    console.error(`test-weakening: --base is required\n${usage}`);
    return 2;
  }
  const repo = options.repo ?? process.cwd();
  const head = options.head ?? "HEAD";
  const body = options["body-file"] === undefined ? (process.env.PR_BODY ?? "") : readFileSync(options["body-file"], "utf8");
  let mergeBase;
  try {
    mergeBase = git(repo, ["merge-base", options.base, head]).trim();
  } catch {
    console.error(`test-weakening: no merge base between ${options.base} and ${head}; fetch the full history (fetch-depth: 0) and try again`);
    return 2;
  }
  const diff = git(repo, ["diff", "--no-color", "--no-ext-diff", "--unified=0", "-M", mergeBase, head]);
  const findings = findWeakening(parseDiff(diff));
  if (findings.length === 0) {
    console.log(`test-weakening: no test file renamed or deleted, no assertion removed or changed, and no skip, only, todo, return or catch added, in a test file that exists on ${mergeBase.slice(0, 12)}`);
    return 0;
  }
  const declared = declaredFiles(body);
  const undeclared = [...new Set(findings.map((finding) => finding.file))].filter((file) => !declared.files.has(file));
  for (const finding of findings) {
    const mark = declared.files.has(finding.file) ? "declared" : "NOT DECLARED";
    console.log(`test-weakening: ${finding.where}: ${finding.kind} (${mark}): ${finding.text.slice(0, 160)}`);
  }
  if (undeclared.length === 0) {
    console.log(`test-weakening: ${findings.length} change(s) in ${declared.files.size} declared file(s); each has a reason in the "## Tests changed" table`);
    return 0;
  }
  const missing = declared.found
    ? `The "## Tests changed" table in the pull request body has no row with a reason for: ${undeclared.join(", ")}. A reason needs at least ${MIN_REASON} characters.`
    : `The pull request body has no "## Tests changed" section.`;
  console.error(
    `test-weakening: ${missing} Restore the tests, or add a row per file to a "## Tests changed" table in the pull request body: | file | test | reason |. Editing the body runs this check again on the current body.`,
  );
  return 1;
};

process.exit(main());
