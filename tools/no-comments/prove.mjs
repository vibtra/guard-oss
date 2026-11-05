import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { findComments, fixedComments } from "./lib/comments.mjs";
import { normalForms, shortHash, typescriptKeptComments } from "./lib/forms.mjs";
import { changedFiles, readBlob, readWorkingFile, repoRoot, verifyCommit } from "./lib/git.mjs";
import { languageFor, scannable } from "./lib/languages.mjs";

const usage = "usage: node tools/no-comments/prove.mjs --base <git-ref> [--head <git-ref>] [paths...]";

const firstLine = (text) => text.split(/\r?\n/)[0];

function changedLine(removed, added) {
  const [old, now] = [removed.split(/\r?\n/), added.split(/\r?\n/)];
  const index = old.findIndex((line, at) => line !== now[at]);
  const at = index < 0 ? old.length : index;
  if (at === 0) return `${old[0]} -> ${now[0]}`;
  const shown = (line) => (line === undefined ? "(end)" : line.trim());
  return `line ${at + 1} of ${old[0]}: ${shown(old[at])} -> ${shown(now[at])}`;
}

function missing(from, other) {
  const left = [...other];
  return from.filter((entry) => {
    const index = left.indexOf(entry);
    if (index < 0) return true;
    left.splice(index, 1);
    return false;
  });
}

async function keptComments(language, path, text) {
  if (language.form === "typescript") return typescriptKeptComments(path, text);
  return fixedComments((await findComments(language, text)).comments);
}

async function commentChange(language, path, before, after) {
  const [oldFixed, newFixed] = await Promise.all([keptComments(language, path, before), keptComments(language, path, after)]);
  if (oldFixed.join("\0") === newFixed.join("\0")) return null;
  const [removed] = missing(oldFixed, newFixed);
  const [added] = missing(newFixed, oldFixed);
  if (removed && added) return `kept comment changed: ${changedLine(removed, added)}`;
  if (removed) return `kept comment removed: ${firstLine(removed)}`;
  if (added) return `kept comment added: ${firstLine(added)}`;
  return "kept comments moved";
}

function problemOf(change, language) {
  if (change.status === "A") return "added";
  if (change.status === "D") return "deleted";
  if (change.status !== "M") return `status ${change.status}`;
  if (change.oldMode !== change.newMode) return `mode changed ${change.oldMode} -> ${change.newMode}`;
  if (!language) return "no prover";
  return null;
}

async function compare(pending) {
  const forms = await normalForms(
    pending.flatMap(({ row, language, before, after }) => [
      { path: row.path, language, text: before },
      { path: row.path, language, text: after },
    ]),
  );
  for (const [index, { row, language, before, after }] of pending.entries()) {
    const [old, now] = [forms[2 * index], forms[2 * index + 1]];
    if (old.error || now.error) {
      row.problem = old.error ? `base ${old.error}` : `head ${now.error}`;
      continue;
    }
    const partial = old.partial || now.partial;
    if (old.form === now.form) {
      row.hash = shortHash(now.form);
    } else if (partial && old.flat === now.flat) {
      row.hash = shortHash(now.flat);
      row.note = `partial parse at line ${partial}, compared token by token`;
    } else {
      row.hash = shortHash(now.form);
      row.problem = `code changed (base ${shortHash(old.form)})`;
      continue;
    }
    if (partial && !row.note) row.note = `partial parse at line ${partial}`;
    if (!scannable(language) && language.form !== "typescript") continue;
    try {
      row.problem = await commentChange(language, row.path, before, after);
    } catch (error) {
      row.problem = `comment scan failed: ${error.message}`;
    }
  }
}

export async function prove(argv) {
  let options;
  try {
    options = parseArgs({ args: argv, allowPositionals: true, options: { base: { type: "string" }, head: { type: "string" } } });
  } catch (error) {
    console.error(`${error.message}\n${usage}`);
    return 2;
  }
  const { base, head } = options.values;
  if (!base) {
    console.error(usage);
    return 2;
  }
  const rows = [];
  const pending = [];
  try {
    const root = repoRoot();
    verifyCommit(base);
    if (head) verifyCommit(head);
    for (const change of changedFiles(base, head, options.positionals)) {
      const language = languageFor(change.path);
      const row = { path: change.path, language: language?.name ?? "-", hash: "-", problem: problemOf(change, language) };
      rows.push(row);
      if (row.problem) continue;
      try {
        const before = readBlob(change.oldSha);
        const after = change.newSha ? readBlob(change.newSha) : readWorkingFile(root, change.path);
        pending.push({ row, language, before, after });
      } catch (error) {
        if (error.code !== "ERR_ENCODING_INVALID_ENCODED_DATA") throw error;
        row.problem = "not valid UTF-8";
      }
    }
    await compare(pending);
  } catch (error) {
    console.error(`prove: ${error.message}`);
    return 2;
  }
  for (const row of rows) {
    const result = row.problem ? "FAIL" : "ok";
    const detail = row.problem ?? row.note;
    console.log(`${result.padEnd(4)} ${row.language.padEnd(6)} ${row.hash.padEnd(12)} ${row.path}${detail ? `  ${detail}` : ""}`);
  }
  const failed = rows.filter((row) => row.problem).length;
  console.log(`prove: ${rows.length} files, ${failed} failed`);
  return failed > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await prove(process.argv.slice(2));
}
