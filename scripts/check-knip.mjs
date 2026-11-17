import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return false;
  args.splice(at, 1);
  return true;
};
const option = (name) => {
  const at = args.indexOf(name);
  if (at === -1) return undefined;
  const [, value] = args.splice(at, 2);
  return value;
};
const write = flag("--write-baseline");
const base = option("--base") ?? "origin/main";
const root = path.resolve(args[0] ?? path.join(here, ".."));
const knipBin = path.join(here, "..", "node_modules", ".bin", "knip");
const baselineFile = path.join(root, "knip-baseline.json");

const SCOPE = /^(?:apps|packages)\//;
const KINDS = ["files", "dependencies", "devDependencies", "optionalPeerDependencies", "unlisted", "unresolved", "binaries", "exports", "types", "enumMembers", "namespaceMembers", "duplicates"];

const ADVICE = {
  files: (file) => `${file} is not imported from any entry. Delete it, or import it where it is needed.`,
  dependencies: (file, name) => `${file} lists ${name} in dependencies but nothing imports it. Remove it from package.json.`,
  devDependencies: (file, name) => `${file} lists ${name} in devDependencies but nothing uses it. Remove it from package.json.`,
  optionalPeerDependencies: (file, name) => `${file} lists ${name} as an optional peer but nothing imports it. Remove it from package.json.`,
  unlisted: (file, name) => `${file} imports ${name}, which its package.json does not list. Add it to that package.json.`,
  unresolved: (file, name) => `${file} imports ${name}, which does not resolve. Fix the path or the package name.`,
  binaries: (file, name) => `${file} runs ${name}, which no dependency provides. Add the package that provides it.`,
  exports: (file, name) => `${file} exports ${name} but nothing imports it. Drop the export keyword, or delete it if nothing uses it.`,
  types: (file, name) => `${file} exports the type ${name} but nothing imports it. Drop the export keyword, or delete it if nothing uses it.`,
  enumMembers: (file, name) => `${file} has the enum member ${name} that nothing uses. Delete it.`,
  namespaceMembers: (file, name) => `${file} has the namespace member ${name} that nothing uses. Delete it.`,
  duplicates: (file, name) => `${file} exports the same value twice (${name}). Keep one name.`,
  testOnly: (file, name) =>
    `${file} exports ${name} through a package entry (an exports key in package.json), and only tests import it. Move it to a ./testing subpath export in package.json and import it from there in the tests.`,
  entryExports: (file, name) =>
    `${file} exports ${name} through a package entry (an exports key in package.json), but nothing imports it. Drop it from the entry's exports, or delete it if nothing uses it.`,
};

const knip = (...flags) => {
  let out;
  try {
    out = execFileSync(knipBin, ["--reporter", "json", "--no-progress", ...flags], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 });
  } catch (error) {
    if (typeof error.stdout !== "string" || error.stdout.trim() === "") throw new Error(`knip ${flags.join(" ")} failed: ${error.stderr ?? error.message}`, { cause: error });
    out = error.stdout;
  }
  return JSON.parse(out.slice(out.indexOf("{"))).issues;
};

const nameOf = (item) => item.name ?? (Array.isArray(item) ? item.map((entry) => entry.name).join(" = ") : String(item));

const NOT_PUBLIC = new Set(["./testing", "./package.json"]);
const targetOf = (value) => {
  if (typeof value === "string") return value;
  if (value === null || typeof value !== "object") return undefined;
  return targetOf(value.default ?? value.import ?? value.node ?? value.require);
};
const exportTargets = (pkg) => {
  if (pkg.exports === undefined) return typeof pkg.main === "string" ? [pkg.main] : [];
  if (typeof pkg.exports === "string") return [pkg.exports];
  const keyed = Object.keys(pkg.exports).some((key) => key.startsWith("."));
  const entries = keyed ? Object.entries(pkg.exports) : [[".", pkg.exports]];
  return entries.filter(([key]) => !NOT_PUBLIC.has(key) && !key.includes("*")).map(([, value]) => targetOf(value));
};

const publicEntries = new Set();
for (const parent of ["apps", "packages"]) {
  const dir = path.join(root, parent);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const manifest = path.join(dir, name, "package.json");
    if (!existsSync(manifest)) continue;
    for (const target of exportTargets(JSON.parse(readFileSync(manifest, "utf8")))) {
      if (typeof target === "string" && /\.[cm]?[jt]sx?$/.test(target)) publicEntries.add(path.posix.join(parent, name, target.replace(/^\.\//, "")));
    }
  }
}

const findings = new Map();
for (const issue of knip()) {
  if (!SCOPE.test(issue.file)) continue;
  for (const kind of KINDS) {
    for (const item of issue[kind] ?? []) {
      const name = kind === "files" ? issue.file : nameOf(item);
      findings.set(`${kind} ${issue.file} ${name}`, ADVICE[kind](issue.file, name));
    }
  }
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];
const resolveModule = (fromFile, specifier) => {
  if (!specifier.startsWith(".")) return undefined;
  const bare = path.posix.join(path.posix.dirname(fromFile), specifier).replace(/\.(?:[cm]?js|jsx)$/, "");
  const candidates = [bare, ...SOURCE_EXTENSIONS.map((extension) => `${bare}${extension}`), ...SOURCE_EXTENSIONS.map((extension) => `${bare}/index${extension}`)];
  return candidates.find((candidate) => /\.[cm]?[jt]sx?$/.test(candidate) && existsSync(path.join(root, candidate)) && statSync(path.join(root, candidate)).isFile());
};

const RE_EXPORT = /export\s+(type\s+)?(\*(?:\s+as\s+\w+)?|\{[^}]*\})\s*from\s*["']([^"']+)["']/g;
const reachable = new Map();
const reach = (file, names) => {
  const known = reachable.get(file);
  if (known === "*" || (known !== undefined && names !== "*" && names.every((name) => known.has(name)))) return;
  reachable.set(file, names === "*" ? "*" : new Set([...(known ?? []), ...names]));
  const text = readFileSync(path.join(root, file), "utf8");
  for (const [, , clause, specifier] of text.matchAll(RE_EXPORT)) {
    const target = resolveModule(file, specifier);
    if (target === undefined) continue;
    if (clause.startsWith("*")) {
      reach(target, "*");
      continue;
    }
    const exported = clause
      .slice(1, -1)
      .split(",")
      .map((part) => part.trim().replace(/^type\s+/, ""))
      .filter(Boolean)
      .map((part) => {
        const [original, alias] = part.split(/\s+as\s+/);
        return { original, alias: alias ?? original };
      })
      .filter(({ alias }) => names === "*" || names.includes(alias))
      .map(({ original }) => original);
    if (exported.length > 0) reach(target, exported);
  }
};
for (const entry of publicEntries) if (existsSync(path.join(root, entry))) reach(entry, "*");

const throughMainEntry = (file, name) => {
  const names = reachable.get(file);
  return names === "*" || (names !== undefined && names.has(name));
};

const reachableExports = (issues) =>
  new Set(
    issues.flatMap((issue) =>
      [...(issue.exports ?? []), ...(issue.types ?? [])].map((item) => [issue.file, nameOf(item)]).filter(([file, name]) => throughMainEntry(file, name)).map(([file, name]) => `${file} ${name}`),
    ),
  );
const unusedAnywhere = reachableExports(knip("--include-entry-exports"));
for (const key of reachableExports(knip("--production", "--include-entry-exports"))) {
  if (unusedAnywhere.has(key)) continue;
  const [file, ...name] = key.split(" ");
  findings.set(`testOnly ${key}`, ADVICE.testOnly(file, name.join(" ")));
}
for (const key of unusedAnywhere) {
  if (findings.has(`exports ${key}`) || findings.has(`types ${key}`)) continue;
  const [file, ...name] = key.split(" ");
  findings.set(`entryExports ${key}`, ADVICE.entryExports(file, name.join(" ")));
}

const MIN_REASON = 20;
const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : { entries: [] };
const problems = [];
const accepted = new Map();
const namesOf = (entry) => entry.names ?? [entry.file];
for (const entry of baseline.entries ?? []) {
  if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_REASON) {
    problems.push(`knip-baseline.json: the ${entry.kind} entry for ${entry.file} has no reason. Write why it stays, or fix the finding.`);
  }
  for (const name of namesOf(entry)) accepted.set(`${entry.kind} ${entry.file} ${name}`, entry);
}

if (write) {
  const entries = (baseline.entries ?? [])
    .map((entry) => (entry.kind === "files" ? entry : { ...entry, names: entry.names.filter((name) => findings.has(`${entry.kind} ${entry.file} ${name}`)) }))
    .filter((entry) => (entry.kind === "files" ? findings.has(`files ${entry.file} ${entry.file}`) : entry.names.length > 0));
  writeFileSync(baselineFile, `${JSON.stringify({ about: baseline.about, entries }, null, 2)}\n`);
  const removed = accepted.size - entries.reduce((sum, entry) => sum + namesOf(entry).length, 0);
  console.log(`check-knip: removed ${removed} fixed findings from knip-baseline.json; --write-baseline never adds one`);
  const missing = [...findings].filter(([key]) => !accepted.has(key));
  for (const [, advice] of missing) console.error(`check-knip: not in the baseline, so fix it or add a new entry with its own reason by hand: ${advice}`);
  process.exit(0);
}

const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const baseEntries = () => {
  if (base === "none") return [];
  try {
    git("rev-parse", "--verify", "--quiet", `${base}^{commit}`);
  } catch {
    console.error(`check-knip: cannot read ${base}, which new baseline names are checked against. Fetch it first (git fetch origin main), or pass --base <ref>.`);
    process.exit(1);
  }
  let text;
  try {
    text = git("show", `${base}:knip-baseline.json`);
  } catch {
    return [];
  }
  return JSON.parse(text).entries ?? [];
};
const onBase = new Map();
const baseReasons = new Set();
for (const entry of baseEntries()) {
  baseReasons.add(entry.reason);
  onBase.set(`${entry.kind} ${entry.file} ${entry.reason}`, new Set(namesOf(entry)));
}
for (const entry of baseline.entries ?? []) {
  const known = onBase.get(`${entry.kind} ${entry.file} ${entry.reason}`);
  if (known === undefined) {
    if (baseReasons.has(entry.reason)) {
      problems.push(
        `knip-baseline.json: the new ${entry.kind} entry for ${entry.file} reuses a reason from ${base}'s baseline. ` +
          `Write a reason of its own (at least ${MIN_REASON} characters) that says why these findings stay, so the addition is reviewed.`,
      );
    }
    continue;
  }
  for (const name of namesOf(entry)) {
    if (known.has(name)) continue;
    problems.push(
      `knip-baseline.json: the ${entry.kind} entry for ${entry.file} gained ${name}, which ${base}'s baseline does not list under that reason. ` +
        `Fix the finding, or put it in a new entry with a reason of its own (at least ${MIN_REASON} characters), so the addition is reviewed.`,
    );
  }
}

for (const [key, advice] of findings) {
  if (!accepted.has(key)) problems.push(`check-knip: ${advice}`);
}
for (const key of accepted.keys()) {
  if (!findings.has(key)) problems.push(`check-knip: knip-baseline.json still lists "${key}", which knip no longer finds. Remove it from the baseline.`);
}
for (const line of problems) console.error(line);
if (problems.length > 0) process.exit(1);
console.log(`check-knip: no new unused files, dependencies or exports (package-entry exports included), and no export through a package entry that only tests use, in apps/ and packages/ (${accepted.size} baselined)`);
