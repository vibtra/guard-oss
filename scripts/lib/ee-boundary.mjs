// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

export const ZONES = /** @type {const} */ (["core", "apache", "ee"]);

const APACHE_PREFIXES = ["packages/guard-contract/", "guard/"];
const EE_PREFIXES = ["ee/", "tests/integration/ee/"];

export const zoneOf = (rel) => {
  if (EE_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) return "ee";
  if (APACHE_PREFIXES.some((p) => rel === p.slice(0, -1) || rel.startsWith(p))) return "apache";
  return "core";
};

export const allowed = (from, to) => {
  if (from === to) return true;
  if (from === "ee") return true;
  if (from === "core") return to === "apache";
  return false;
};

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const SPECIFIERS = [
  /\b(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\/\/\/\s*<reference\s+path\s*=\s*["']([^"']+)["']/g,
];

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/(^|[^:"'`\\])\/\/(?!\/\s*<reference).*$/gm, "$1");

export const specifiersOf = (text) => {
  const body = stripComments(text);
  const out = [];
  for (const re of SPECIFIERS) {
    re.lastIndex = 0;
    for (const m of body.matchAll(re)) out.push(m[1]);
  }
  return out;
};

export const targetZone = (fromRel, spec, packages) => {
  if (spec.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    if (resolved.startsWith("..")) return undefined;
    return zoneOf(resolved);
  }
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  const dir = packages.get(name);
  if (dir === undefined) return undefined;
  const sub = spec.slice(name.length).replace(/^\//, "");
  return zoneOf(sub === "" ? `${dir}/` : `${dir}/${sub}`);
};

/**
 * @param {Array<{ path: string, text: string }>} files  repository-relative POSIX paths
 * @param {Map<string, string>} packages  workspace package name → directory
 * @param {Array<{ path: string, json: any }>} manifests  package.json files
 * @returns {Array<{ file: string, from: string, to: string, spec: string }>}
 */
export const checkBoundary = (files, packages, manifests = []) => {
  const violations = [];
  for (const { path: rel, text } of files) {
    if (!SOURCE.test(rel)) continue;
    const from = zoneOf(rel);
    for (const spec of specifiersOf(text)) {
      const to = targetZone(rel, spec, packages);
      if (to !== undefined && !allowed(from, to)) violations.push({ file: rel, from, to, spec });
    }
  }
  for (const { path: rel, json } of manifests) {
    const from = zoneOf(rel);
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const name of Object.keys(json?.[field] ?? {})) {
        const dir = packages.get(name);
        if (dir === undefined) continue;
        const to = zoneOf(`${dir}/`);
        if (!allowed(from, to)) violations.push({ file: rel, from, to, spec: `${field}: ${name}` });
      }
    }
  }
  return violations;
};

export const scanRepository = (root) => {
  let list;
  try {
    list = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
      .split("\0")
      .filter(Boolean);
  } catch {
    throw new Error(`ee-boundary: ${root} is not a git checkout; run it from one`);
  }
  const manifests = [];
  const packages = new Map();
  for (const rel of list.filter((f) => f.endsWith("package.json") && !f.includes("node_modules/"))) {
    if (!existsSync(path.join(root, rel))) continue;
    const json = JSON.parse(readFileSync(path.join(root, rel), "utf8"));
    manifests.push({ path: rel, json });
    if (typeof json.name === "string") packages.set(json.name, path.posix.dirname(rel));
  }
  const files = list
    .filter((f) => SOURCE.test(f) && !f.includes("node_modules/") && !/(^|\/)dist\//.test(f))
    .filter((f) => existsSync(path.join(root, f)))
    .map((f) => ({ path: f, text: readFileSync(path.join(root, f), "utf8") }));
  return { violations: checkBoundary(files, packages, manifests), files: files.length, packages };
};
