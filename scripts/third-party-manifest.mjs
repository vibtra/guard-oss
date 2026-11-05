#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = path.join(repoRoot, "apps/registry");
const REGISTRY_OUT = path.join(REGISTRY, "NOTICES.md");

const NO_LICENCE_TEXT = {
  "@better-auth/utils": { copyright: "Copyright (c) Better Auth contributors" },
  "@nodable/entities": { copyright: "Copyright (c) Nodable contributors" },
  "node-rsa": { copyright: "Copyright (c) rzcoder and node-rsa contributors" },
  "react-remove-scroll-bar": { copyright: "Copyright (c) Anton Korzunov" },
  "@1password/sdk": { copyright: "Copyright (c) AgileBits Inc. (1Password)" },
  "@1password/sdk-core": { copyright: "Copyright (c) AgileBits Inc. (1Password)" },
  "abstract-logging": { copyright: "Copyright (c) Jesse Tomchak and abstract-logging contributors" },
  "pg-types": { copyright: "Copyright (c) Brian Carlson and node-postgres contributors" },
  pgpass: { copyright: "Copyright (c) Hannes Hörl and pgpass contributors" },
  eastasianwidth: { copyright: "Copyright (c) Masaki Komatsu" },
  "emoji-regex": { copyright: "Copyright (c) Mathias Bynens" },
  "@aws-sdk/credential-provider-http": { copyright: "Copyright Amazon.com, Inc. or its affiliates (aws/aws-sdk-js-v3)" },
  "@aws-sdk/credential-provider-login": { copyright: "Copyright Amazon.com, Inc. or its affiliates (aws/aws-sdk-js-v3)" },
  "@aws-sdk/nested-clients": { copyright: "Copyright Amazon.com, Inc. or its affiliates (aws/aws-sdk-js-v3)" },
  "data-uri-to-buffer": { copyright: "Copyright (c) Nathan Rajlich" },
  "proxy-agent-negotiate": { copyright: "Copyright (c) Nathan Rajlich (TooTallNate/proxy-agents)" },
  standardwebhooks: { copyright: "Copyright (c) Standard Webhooks contributors" },
  ignore: { copyright: "Copyright (c) 2013 Kael Zhang <i@kael.me>, contributors" },
};

const VENDORED_REGISTRY = [
  {
    name: "free-email-domains (vendored data)",
    version: "1.12.21",
    licence: "MIT",
    homepage: "https://github.com/Kikobeats/free-email-domains",
    licenceFile: "apps/registry/src/tenancy/vendor/free-email-domains/LICENSE.md",
  },
];

const OURS = /^@vibtra\//;
const LICENCE_FILE = /^(LICEN[CS]E|COPYING)(\.|$)/i;

function resolveDep(fromDir, name) {
  let dir = path.resolve(fromDir);
  for (;;) {
    const manifest = path.join(dir, "node_modules", name, "package.json");
    if (existsSync(manifest)) return realpathSync(path.dirname(manifest));
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const readPkg = (dir) => JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));

function productionClosure(rootDir) {
  const found = new Map();
  const versions = new Map();
  const problems = [];
  const seen = new Set();
  const queue = [realpathSync(rootDir)];
  while (queue.length > 0) {
    const dir = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (!existsSync(path.join(dir, "package.json"))) {
      problems.push(`${path.relative(repoRoot, dir)}: not installed; run pnpm install before regenerating`);
      continue;
    }
    const pkg = readPkg(dir);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const installed = resolveDep(dir, name);
      if (installed === null) {
        problems.push(`${name}: not resolvable from ${String(pkg.name)}; run pnpm install`);
        continue;
      }
      queue.push(installed);
      if (OURS.test(name)) continue;
      const version = String(readPkg(installed).version ?? "unknown");
      const seenVersions = versions.get(name) ?? new Map();
      seenVersions.set(version, installed);
      versions.set(name, seenVersions);
      if (!found.has(name)) found.set(name, { dir: installed });
    }
  }
  for (const [name, seenVersions] of versions) {
    found.get(name).versions = [...seenVersions.entries()].sort((a, b) => a[0].localeCompare(b[0], "en"));
  }
  return { found, problems };
}

function licenceText(dir) {
  const file = readdirSync(dir).find((f) => LICENCE_FILE.test(f));
  if (!file) return null;
  return { file, text: readFileSync(path.join(dir, file), "utf8").replace(/\r\n/g, "\n").trimEnd() };
}

function spdx(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license.type === "string") return pkg.license.type;
  if (Array.isArray(pkg.licenses) && pkg.licenses[0]?.type) return pkg.licenses[0].type;
  return null;
}

function homepage(pkg) {
  const repo = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  if (typeof repo === "string" && repo.length > 0) {
    const cleaned = repo.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://").replace(/\.git$/, "");
    if (cleaned.startsWith("https://")) return cleaned;
    if (/^[\w.-]+\/[\w.-]+$/.test(cleaned)) return `https://github.com/${cleaned}`;
  }
  if (typeof pkg.homepage === "string" && pkg.homepage.startsWith("https://")) return pkg.homepage;
  return null;
}

function componentsOf(rootDir) {
  const { found, problems } = productionClosure(rootDir);
  const components = [];
  for (const name of [...found.keys()].sort((a, b) => a.localeCompare(b, "en"))) {
    const { dir, versions } = found.get(name);
    const pkg = readPkg(dir);
    const id = spdx(pkg);
    if (!id) problems.push(`${name}@${String(pkg.version)}: declares no licence; it cannot be distributed`);
    const declared = new Set(versions.map(([, at]) => spdx(readPkg(at)) ?? "UNKNOWN"));
    if (declared.size > 1) problems.push(`${name}: installed versions declare different licences (${[...declared].sort().join(" and ")}); pin one version`);
    const licence = licenceText(dir);
    const exception = Object.hasOwn(NO_LICENCE_TEXT, name) ? NO_LICENCE_TEXT[name] : undefined;
    if (licence === null && exception === undefined) problems.push(`${name}@${String(pkg.version)}: ships no licence file and is not in NO_LICENCE_TEXT; add it with its SPDX id and an upstream copyright line`);
    if (licence !== null && exception !== undefined) problems.push(`${name}@${String(pkg.version)}: is in NO_LICENCE_TEXT but now ships ${licence.file}; remove the exception`);
    components.push({
      name,
      version: versions.map(([v]) => v).join(" · ") || String(pkg.version ?? "unknown"),
      licence: id ?? "UNKNOWN",
      homepage: homepage(pkg),
      text: licence?.text ?? null,
      copyright: licence === null ? (exception?.copyright ?? null) : null,
    });
  }
  return { components, problems };
}

function markdownNotices(label, artefact, components) {
  const lines = [
    `# Third-party notices — ${label}`,
    "",
    "<!-- GENERATED FILE — DO NOT EDIT BY HAND. Written by",
    "     `scripts/third-party-manifest.mjs`; regenerate with `pnpm licence:manifest`.",
    "     `pnpm licence:manifest --check` re-derives it and fails when it is stale. -->",
    "",
    `\`${artefact}\` is distributed with the open-source components below — its`,
    "**transitive production closure** as installed, which is what actually",
    "travels rather than only what we chose to type (precedent: github/licensed).",
    "Each component's own licence text is reproduced verbatim; where a package",
    "ships none, its declared SPDX identifier and upstream copyright line stand",
    "in its place.",
    "",
    `**${String(components.length)} components.**`,
    "",
    "| Component | Version | Licence |",
    "|---|---|---|",
    ...components.map((c) => `| ${c.homepage === null ? c.name : `[${c.name}](${c.homepage})`} | ${c.version} | ${c.licence} |`),
    "",
    "---",
    "",
  ];
  for (const c of components) {
    lines.push(`## ${c.name} ${c.version}`, "", `SPDX: \`${c.licence}\``, "");
    if (c.text === null) {
      lines.push(`${String(c.copyright)}`, "", `This package publishes no licence file. It is distributed under \`${c.licence}\`,`, "as the package itself declares.", "");
    } else {
      lines.push("```text", c.text, "```", "");
    }
  }
  return `${lines.join("\n")}\n`;
}

function buildRegistry() {
  const { components: installed, problems } = componentsOf(REGISTRY);
  if (problems.length > 0) {
    console.error(`[third-party] cannot generate the backend notices:\n  - ${problems.join("\n  - ")}`);
    process.exit(1);
  }
  const vendored = VENDORED_REGISTRY.map((v) => ({
    name: v.name,
    version: v.version,
    licence: v.licence,
    homepage: v.homepage,
    text: readFileSync(path.join(repoRoot, v.licenceFile), "utf8").trim(),
    copyright: null,
  }));
  return markdownNotices("the Vibtra registry", "apps/registry", [...installed, ...vendored]);
}

const next = buildRegistry();
const count = Number(/\*\*(\d+) components\.\*\*/.exec(next)?.[1] ?? 0);
const rel = path.relative(repoRoot, REGISTRY_OUT);
if (!process.argv.includes("--check")) {
  writeFileSync(REGISTRY_OUT, next, "utf8");
  console.log(`[third-party] wrote ${rel}: ${count} components`);
} else if ((existsSync(REGISTRY_OUT) ? readFileSync(REGISTRY_OUT, "utf8") : "") === next) {
  console.log(`[third-party] ${rel} is current (${count} components)`);
} else {
  console.error(`[third-party] STALE: ${rel} does not match the installed dependency tree. Run pnpm licence:manifest and commit ${rel}.`);
  process.exit(1);
}
