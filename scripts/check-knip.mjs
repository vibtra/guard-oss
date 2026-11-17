import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const write = flag("--write-baseline");
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
    `${file} is a package's main entry and exports ${name}, which only tests import. Move it to a ./testing subpath export in package.json and import it from there in the tests.`,
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

const mainEntries = new Set();
for (const parent of ["apps", "packages"]) {
  const dir = path.join(root, parent);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const manifest = path.join(dir, name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8"));
    const dot = pkg.exports?.["."];
    const main = typeof dot === "string" ? dot : dot?.default ?? dot?.import ?? pkg.main;
    if (typeof main === "string") mainEntries.add(path.posix.join(parent, name, main.replace(/^\.\//, "")));
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

const entryExports = (issues) =>
  new Set(issues.filter((issue) => mainEntries.has(issue.file)).flatMap((issue) => [...(issue.exports ?? []), ...(issue.types ?? [])].map((item) => `${issue.file} ${nameOf(item)}`)));
const unusedAnywhere = entryExports(knip("--include-entry-exports"));
for (const key of entryExports(knip("--production", "--include-entry-exports"))) {
  if (unusedAnywhere.has(key)) continue;
  const [file, ...name] = key.split(" ");
  findings.set(`testOnly ${key}`, ADVICE.testOnly(file, name.join(" ")));
}

const baseline = existsSync(baselineFile) ? JSON.parse(readFileSync(baselineFile, "utf8")) : { entries: [] };
const problems = [];
const accepted = new Map();
for (const entry of baseline.entries ?? []) {
  if (typeof entry.reason !== "string" || entry.reason.trim().length < 20) {
    problems.push(`knip-baseline.json: the ${entry.kind} entry for ${entry.file} has no reason. Write why it stays, or fix the finding.`);
  }
  for (const name of entry.names ?? [entry.file]) accepted.set(`${entry.kind} ${entry.file} ${name}`, entry);
}

if (write) {
  const groups = new Map();
  for (const key of [...findings.keys()].sort()) {
    const [kind, file, ...rest] = key.split(" ");
    const id = `${kind} ${file}`;
    const known = accepted.get(key);
    const group = groups.get(id) ?? { kind, file, names: [], reason: known?.reason ?? "" };
    if (kind !== "files") group.names.push(rest.join(" "));
    groups.set(id, group);
  }
  const entries = [...groups.values()].map(({ names, ...rest }) => (rest.kind === "files" ? rest : { ...rest, names }));
  writeFileSync(baselineFile, `${JSON.stringify({ about: baseline.about, entries }, null, 2)}\n`);
  console.log(`check-knip: wrote ${entries.length} baseline entries to knip-baseline.json`);
  process.exit(0);
}

for (const [key, advice] of findings) {
  if (!accepted.has(key)) problems.push(`check-knip: ${advice}`);
}
for (const key of accepted.keys()) {
  if (!findings.has(key)) problems.push(`check-knip: knip-baseline.json still lists "${key}", which knip no longer finds. Remove it from the baseline.`);
}
for (const line of problems) console.error(line);
if (problems.length > 0) process.exit(1);
console.log(`check-knip: no new unused files, dependencies or exports, and no test-only main-entry exports, in apps/ and packages/ (${accepted.size} baselined)`);
