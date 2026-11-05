import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { findComments, removable, strip } from "./lib/comments.mjs";
import { gofmtSources } from "./lib/forms.mjs";
import { UsageError, readWorkingFile, repoRoot, trackedFiles } from "./lib/git.mjs";
import { languageFor, scannable } from "./lib/languages.mjs";
import { prove } from "./prove.mjs";

const usage = [
  "usage: node tools/no-comments/cli.mjs check [paths...]",
  "       node tools/no-comments/cli.mjs fix [paths...]",
  "       node tools/no-comments/cli.mjs prove --base <git-ref> [--head <git-ref>] [paths...]",
].join("\n");

function listFiles(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const root = repoRoot();
  return { root, files: trackedFiles(positionals).filter((path) => scannable(languageFor(path))) };
}

function writeGo(root, fixes) {
  const sources = (key) => fixes.map((fix) => ({ name: fix.path, source: fix[key] }));
  const formatted = gofmtSources([...sources("original"), ...sources("fixed")]);
  fixes.forEach(({ path, original, fixed }, index) => {
    const before = formatted[index];
    const after = formatted[fixes.length + index];
    const wasClean = !before.error && before.printed === original;
    writeFileSync(join(root, path), wasClean && !after.error ? after.printed : fixed);
  });
}

async function scan(command, argv) {
  let listing;
  try {
    listing = listFiles(argv);
  } catch (error) {
    console.error(error instanceof UsageError ? `no-comments: ${error.message}` : `${error.message}\n${usage}`);
    return 2;
  }
  const { root, files } = listing;
  const counts = new Map();
  let total = 0;
  let touched = 0;
  let left = 0;
  let failures = 0;
  const goFixes = [];
  for (const path of files) {
    const language = languageFor(path);
    let text;
    let scanned;
    try {
      text = readWorkingFile(root, path);
      scanned = await findComments(language, text);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      console.error(`${path}: ${error.code === "ERR_ENCODING_INVALID_ENCODED_DATA" ? "not valid UTF-8" : error.message}`);
      failures += 1;
      continue;
    }
    const { comments, errorLine } = scanned;
    const found = command === "fix" ? comments.filter(removable) : comments.filter((comment) => !comment.kept);
    const unparsed = comments.filter((comment) => !comment.kept && comment.unparsed).length;
    if (errorLine) {
      const effect = command === "fix" && unparsed > 0 ? ", left in place" : "";
      console.error(`${path}:${errorLine}: partial parse, ${unparsed} comments inside unparsed code${effect}`);
    }
    if (command === "fix") left += unparsed;
    if (found.length === 0) continue;
    total += found.length;
    touched += 1;
    counts.set(language.name, (counts.get(language.name) ?? 0) + found.length);
    if (command === "check") {
      for (const comment of found) console.log(`${path}:${comment.line}: ${comment.text.split(/\r?\n/)[0]}`);
    } else if (language.name === "go") {
      goFixes.push({ path, original: text, fixed: strip(language, text, comments) });
    } else {
      writeFileSync(join(root, path), strip(language, text, comments));
    }
  }
  if (goFixes.length > 0) {
    try {
      writeGo(root, goFixes);
    } catch (error) {
      console.error(`no-comments: ${error.message}`);
      return 2;
    }
  }
  const byLanguage = [...counts].map(([name, count]) => `${name} ${count}`).join(", ");
  const verb = command === "fix" ? "removed" : "found";
  const rest = left > 0 ? `; ${left} comments inside unparsed code left in place` : "";
  console.error(`no-comments: ${verb} ${total} comments in ${touched} files${byLanguage ? ` (${byLanguage})` : ""}${rest}`);
  if (failures > 0) return 2;
  return (command === "check" ? total : left) > 0 ? 1 : 0;
}

async function main([command, ...argv]) {
  if (command === "check" || command === "fix") return scan(command, argv);
  if (command === "prove") return prove(argv);
  console.error(usage);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
