import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const value = args[at + 1];
  args.splice(at, 2);
  return value;
};
const base = option("--base") ?? "origin/main";
const allowFile = option("--allow") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "check-migrations.allow.json");
const root = path.resolve(args[0] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));

const DIR = "apps/registry/migrations";
const NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;
const problems = [];
const fail = (line) => problems.push(`check-migrations: ${line}`);

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const allow = JSON.parse(readFileSync(allowFile, "utf8"));
const allowedDuplicates = new Map();
for (const [number, entry] of Object.entries(allow.duplicates ?? {})) {
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
    fail(`${path.basename(allowFile)} grandfathers ${number} with no reason. Write why the duplicate is safe to keep.`);
  }
  allowedDuplicates.set(number, [...entry.files].sort());
}

const dir = path.join(root, DIR);
const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sql")).sort() : [];
const byNumber = new Map();
for (const file of files) {
  const match = NAME.exec(file);
  if (match === null) {
    fail(`${DIR}/${file} is not named NNNN_snake_case.sql. Rename it to the next free four-digit number and a lowercase name.`);
    continue;
  }
  byNumber.set(match[1], [...(byNumber.get(match[1]) ?? []), file]);
}
for (const [number, group] of byNumber) {
  if (group.length < 2) continue;
  const allowed = allowedDuplicates.get(number);
  if (allowed !== undefined && JSON.stringify(allowed) === JSON.stringify(group)) continue;
  fail(`${group.map((file) => `${DIR}/${file}`).join(" and ")} share the number ${number}. Renumber the new one to the next free number above the highest on ${base}.`);
}

let baseBlobs;
try {
  git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  baseBlobs = new Map(
    git("ls-tree", base, "--", `${DIR}/`)
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [meta, file] = line.split("\t");
        return [path.posix.basename(file), meta.split(" ")[2]];
      })
      .filter(([file]) => file.endsWith(".sql")),
  );
} catch {
  fail(`cannot read ${base}. Fetch it first (git fetch origin main), or pass --base <ref>.`);
}

if (baseBlobs !== undefined) {
  const highest = [...baseBlobs.keys()].map((file) => NAME.exec(file)?.[1]).filter(Boolean).sort().at(-1) ?? "0000";
  for (const [file, blob] of baseBlobs) {
    if (!files.includes(file)) {
      fail(`${DIR}/${file} is on ${base} but is gone here (deleted or renamed). A shipped migration has already run on real databases; restore it and add a new migration instead.`);
      continue;
    }
    const current = git("hash-object", "--", path.join(DIR, file)).trim();
    if (current !== blob) {
      fail(`${DIR}/${file} differs from ${base}. A shipped migration has already run on real databases; revert the edit and put the change in a new migration numbered above ${highest}.`);
    }
  }
  for (const file of files.filter((name) => !baseBlobs.has(name))) {
    const number = NAME.exec(file)?.[1];
    if (number !== undefined && number <= highest) {
      fail(`${DIR}/${file} is new but its number ${number} is not above ${highest}, the highest on ${base}. Another branch took that number first: renumber it above ${highest}.`);
    }
  }
}

for (const line of problems) console.error(line);
if (problems.length > 0) process.exit(1);
console.log(`check-migrations: ${files.length} migrations, numbers unique, none on ${base} edited, renamed or deleted, new ones above ${base}`);
