import { spawnSync } from "node:child_process";
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const usage = "usage: node scripts/engine-agent-grade.mjs <clone> --base <sha>";
const { values, positionals } = parseArgs({ allowPositionals: true, options: { base: { type: "string" } } });
if (positionals.length !== 1 || !values.base) {
  console.error(usage);
  process.exit(2);
}
const clone = path.resolve(positionals[0]);
const base = values.base;
const AGENT = "guard/agent-go";
const ENGINE = `${AGENT}/engine`;
const MAIN = `${AGENT}/main.go`;
const MAIN_LIMIT = 2;
const PROTECTED = [
  [`${ENGINE}/rules/`, (file) => file.startsWith(`${ENGINE}/rules/`)],
  [`${ENGINE}/conformance/`, (file) => file.startsWith(`${ENGINE}/conformance/`)],
  ["the proxy files", (file) => file.startsWith(`${AGENT}/`) && file !== MAIN && !file.startsWith(`${ENGINE}/`)],
  [".golangci.yml", (file) => file === ".golangci.yml" || file === ".golangci.yaml"],
  ["scripts/", (file) => file.startsWith("scripts/")],
];
const PURE_STDLIB = new Set([
  "bufio", "bytes", "cmp", "compress/flate", "compress/gzip", "compress/zlib", "container/heap", "container/list", "container/ring", "context",
  "crypto/hmac", "crypto/md5", "crypto/sha1", "crypto/sha256", "crypto/sha512", "crypto/subtle", "encoding", "encoding/base32", "encoding/base64",
  "encoding/binary", "encoding/csv", "encoding/hex", "encoding/json", "errors", "hash", "hash/adler32", "hash/crc32", "hash/crc64", "hash/fnv",
  "hash/maphash", "html", "io", "iter", "maps", "math", "math/big", "math/bits", "math/rand", "math/rand/v2", "path", "regexp", "regexp/syntax",
  "slices", "sort", "strconv", "strings", "sync", "sync/atomic", "time", "unicode", "unicode/utf16", "unicode/utf8", "unique",
]);
const ENGINE_FILE = /\.(go|md)$/;
const temps = [];

const temp = (label) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), `engine-grade-${label}-`));
  temps.push(dir);
  return dir;
};

const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 600_000, ...options, env: { ...process.env, ...options.env } });
  return { code: result.error ? null : result.status, stdout: result.stdout ?? "", out: `${result.error ? `${result.error.message}\n` : ""}${result.stdout ?? ""}${result.stderr ?? ""}` };
};

const git = (...args) => {
  const result = run("git", ["-C", clone, ...args]);
  if (result.code !== 0) throw new Error(`git ${args.join(" ")} failed:\n${result.out.trim()}`);
  return result.stdout;
};

const lines = (text) => text.split("\n").filter(Boolean);
const tail = (text) => text.trim().split("\n").slice(-8).join("\n");

const changedFiles = () => [...new Set([...lines(git("diff", "--no-renames", "--name-only", base)), ...lines(git("ls-files", "--others", "--exclude-standard"))])].sort();

const existedAtBase = (dir) => run("git", ["-C", clone, "cat-file", "-e", `${base}:${dir}`]).code === 0;

const freshEngines = (changed) => [...new Set(changed.filter((file) => file.startsWith(`${ENGINE}/`) && file.split("/").length > 4).map((file) => file.split("/")[3]))].filter((name) => !existedAtBase(`${ENGINE}/${name}`));

const paths = (changed) => {
  const fresh = freshEngines(changed);
  const allowedDir = fresh.length === 1 ? `${ENGINE}/${fresh[0]}/` : undefined;
  const outside = changed.filter((file) => file !== MAIN && !(allowedDir && file.startsWith(allowedDir)));
  const problems = [];
  if (fresh.length > 1) problems.push(`more than one new engine directory: ${fresh.join(", ")}`);
  if (outside.length > 0) problems.push(`paths outside one new ${ENGINE}/<new>/ directory and ${MAIN}:\n${outside.join("\n")}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return allowedDir ? `only ${allowedDir} and ${MAIN} changed` : `no new engine directory; only ${MAIN} changed`;
};

const mainDiff = () => {
  const numstat = lines(git("diff", "--numstat", base, "--", MAIN));
  const [added, removed] = numstat.length === 0 ? [0, 0] : numstat[0].split("\t").map(Number);
  if (!(added <= MAIN_LIMIT && removed <= MAIN_LIMIT)) throw new Error(`${MAIN} changed by +${numstat[0]?.split("\t")[0]} -${numstat[0]?.split("\t")[1]}; at most +${MAIN_LIMIT} -${MAIN_LIMIT} (the constructor line and its import)`);
  return `${MAIN} changed by +${added} -${removed}`;
};

const protectedFiles = (changed) => {
  const hits = PROTECTED.flatMap(([label, match]) => changed.filter(match).map((file) => `${file} (${label})`));
  if (hits.length > 0) throw new Error(`protected files changed:\n${hits.join("\n")}`);
  return "nothing under engine/rules, engine/conformance, the proxy files, .golangci.yml or scripts/ changed";
};

const modulePath = () => {
  const match = /^module\s+(\S+)/m.exec(readFileSync(path.join(clone, AGENT, "go.mod"), "utf8"));
  if (!match) throw new Error(`${AGENT}/go.mod has no module line`);
  return match[1];
};

const engineSource = (changed) => {
  const fresh = freshEngines(changed).filter((name) => existsSync(path.join(clone, ENGINE, name)));
  if (fresh.length === 0) return "no new engine directory to check";
  const module = modulePath();
  const problems = [];
  for (const name of fresh) {
    const dir = path.join(clone, ENGINE, name);
    if (!lstatSync(dir).isDirectory()) {
      problems.push(`${ENGINE}/${name} is not a directory`);
      continue;
    }
    for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
      const file = path.relative(clone, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
      if (entry.isDirectory()) continue;
      if (!entry.isFile() || !ENGINE_FILE.test(entry.name)) problems.push(`${file}: only regular .go and .md files may sit in the engine directory`);
    }
    const allowed = (imported) => PURE_STDLIB.has(imported) || [`${module}/engine`, `${module}/engine/rules`, `${module}/policy`].includes(imported) || imported.startsWith(`${module}/engine/${name}/`);
    const own = `${module}/engine/${name}`;
    const listed = run("go", ["list", "-mod=readonly", "-deps", "-f", "{{.ImportPath}} {{join .Imports \" \"}}", `./engine/${name}/...`], { cwd: path.join(clone, AGENT) });
    if (listed.code !== 0) {
      problems.push(`go list -deps ./engine/${name}/... failed:\n${tail(listed.out)}`);
      continue;
    }
    const packages = lines(listed.stdout)
      .map((line) => line.trim().split(/\s+/))
      .filter(([pkg]) => pkg === own || pkg.startsWith(`${own}/`));
    for (const [pkg, ...imports] of packages) {
      for (const imported of imports.filter((entry) => !allowed(entry))) problems.push(`${pkg} imports ${imported}`);
    }
  }
  if (problems.length > 0) {
    throw new Error(`the new engine may import only the engine port, engine/rules, policy, its own packages and standard-library packages that cannot read arguments, environment, the network or arbitrary files, or exit. Every package under the engine directory that the build pulls in is checked, testdata/, _x/ and .x/ included:\n${problems.join("\n")}`);
  }
  return `${fresh.map((name) => `${ENGINE}/${name}`).join(", ")} holds only regular .go/.md files and imports only allowed packages`;
};

let binary;

const buildAndCheck = () => {
  const out = temp("build");
  const bin = path.join(out, "vibtra-guard");
  const build = run("go", ["build", "-mod=readonly", "-o", bin, "."], { cwd: path.join(clone, AGENT) });
  if (build.code !== 0) throw new Error(`go build failed:\n${tail(build.out)}`);
  binary = bin;
  const check = run(bin, ["engine", "check"], { env: { VIBTRA_GUARD_DIR: temp("check") } });
  if (check.code !== 0) throw new Error(`\`engine check\` exited ${check.code}:\n${tail(check.out)}`);
  return "the build passes and `engine check` exits 0";
};

const canonicalJson = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
};

const signedProfile = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const keyId = `gk_${randomBytes(4).toString("hex")}`;
  const orgId = `org_${randomBytes(6).toString("hex")}`;
  const deviceId = `gdev_${randomBytes(12).toString("hex")}`;
  const person = { userId: "user_engine_grade", email: "person@example.test" };
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const envelope = (kind, document) => {
    const header = encode({ alg: "ES256", typ: "vibtra-guard+jwt", kid: keyId });
    const payload = encode({
      kind,
      keyId,
      iat: Math.floor(Date.now() / 1000),
      orgId,
      ...(kind === "bundle" ? { deviceId } : {}),
      version: kind === "bundle" ? document.bundleVersion : document.version,
      digest: createHash("sha256").update(canonicalJson(document), "utf8").digest("hex"),
    });
    const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(privateKey.export({ type: "pkcs8", format: "pem" })), dsaEncoding: "ieee-p1363" }).toString("base64url");
    return JSON.stringify({ [kind]: document, signature: { alg: "ES256", keyId, jws: `${header}.${payload}.${signature}` } });
  };
  const files = {
    "device.json": JSON.stringify({
      deviceId,
      orgId,
      orgHandle: "example-org",
      orgName: "Example Org",
      person: { ...person, name: "Test Person" },
      signing: { keyId, alg: "ES256", publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString() },
      server: { baseUrl: "http://127.0.0.1:9", syncIntervalSeconds: 60, batchSize: 100 },
      clientMode: "enforce",
      enrolledAt: "2026-10-24T00:00:00.000Z",
      revoked: false,
    }),
    "device.token": `gdt_${randomBytes(24).toString("hex")}`,
    "bundle.json": envelope("bundle", {
      protocol: 1,
      orgId,
      deviceId,
      bundleVersion: 1,
      catalogueVersion: "engine-grade",
      generatedAt: "2026-10-24T00:00:00.000Z",
      person,
      clientMode: "enforce",
      defaultAction: "allow",
      services: {},
      contentRules: [],
      exceptions: [],
      settings: { requestsEnabled: true, workspaceRedirect: { enabled: false }, snippetPolicy: "redacted", snippetMax: 80 },
    }),
    "catalogue.json": envelope("catalogue", {
      version: "engine-grade",
      generatedAt: "2026-10-24T00:00:00.000Z",
      services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }],
    }),
  };
  const dir = temp("profile");
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content, { mode: 0o600 });
  return dir;
};

const behaviour = () => {
  if (!binary) throw new Error("skipped: the build failed");
  const rows = [
    { id: "pineapple", host: "chatgpt.com", contentType: "application/json", body: '{"prompt":"Add PINEAPPLE to the shopping list"}' },
    { id: "plain", host: "chatgpt.com", contentType: "application/json", body: '{"prompt":"Add bread to the shopping list"}' },
  ];
  const dir = signedProfile();
  const scan = run(binary, ["policy-scan", "--data-dir", dir], { env: { VIBTRA_GUARD_DIR: dir }, input: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
  if (scan.code !== 0) throw new Error(`\`policy-scan\` exited ${scan.code}:\n${tail(scan.out)}`);
  const scanned = new Map(
    lines(scan.stdout).map((line) => {
      const row = JSON.parse(line);
      return [row.id, row];
    }),
  );
  const problems = rows.filter((row) => scanned.get(row.id)?.intercepted !== true).map((row) => `the ${row.id} row was not intercepted for ${row.host}, so the signed catalogue or bundle did not apply`);
  const verdict = (id) => scanned.get(id)?.verdict;
  if (verdict("pineapple") !== "blocked") problems.push(`the row with PINEAPPLE was ${verdict("pineapple") ?? "missing"}, not blocked`);
  if (verdict("plain") === undefined || verdict("plain") === "blocked") problems.push(`the row without PINEAPPLE was ${verdict("plain") ?? "missing"}`);
  if (problems.length > 0) throw new Error(problems.join("\n"));
  return `both rows intercepted; PINEAPPLE is blocked and the plain row is ${verdict("plain")} under a signed enforce bundle`;
};

let failed = 0;
const step = (name, check) => {
  try {
    console.log(`PASS ${name}: ${check()}`);
  } catch (error) {
    failed++;
    console.log(`FAIL ${name}: ${error.message}`);
  }
};

try {
  let changed;
  step("setup", () => {
    if (run("git", ["-C", clone, "rev-parse", "--verify", "--quiet", `${base}^{commit}`]).code !== 0) throw new Error(`base commit ${base} is not in ${clone}. Fetch the full history`);
    changed = changedFiles();
    return `${changed.length} path(s) changed since ${base}`;
  });
  if (changed) {
    step("paths", () => paths(changed));
    step("main.go", mainDiff);
    step("protected files", () => protectedFiles(changed));
    step("engine source", () => engineSource(changed));
    step("build and engine check", buildAndCheck);
    step("behaviour (policy-scan)", behaviour);
  }
} finally {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
}
console.log(failed === 0 ? "engine-agent-grade: PASS" : `engine-agent-grade: FAIL (${failed} step(s))`);
process.exit(failed === 0 ? 0 : 1);
