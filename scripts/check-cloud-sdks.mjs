import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { specifiersOf } from "./lib/ee-boundary.mjs";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const CLOUD_SDK = /^@(?:aws-sdk|google-cloud|azure)\//;
const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

const SKIPPED = new Set(["node_modules", "dist", ".git"]);

const filesUnder = (dir) => {
  let entries;
  try {
    entries = readdirSync(path.join(root, dir), { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED.has(entry.name) ? [] : filesUnder(rel);
    return entry.isFile() ? [rel] : [];
  });
};

const found = [];
for (const file of ["apps", "packages"].flatMap(filesUnder).sort()) {
  const text = readFileSync(path.join(root, file), "utf8");
  if (path.posix.basename(file) === "package.json") {
    const manifest = JSON.parse(text);
    for (const field of DEPENDENCY_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {}).filter((dep) => CLOUD_SDK.test(dep))) found.push(`${file} lists ${name} in ${field}`);
    }
  } else if (SOURCE.test(file)) {
    for (const spec of specifiersOf(text).filter((s) => CLOUD_SDK.test(s))) found.push(`${file} imports ${spec}`);
  }
}
for (const line of found) {
  console.error(`cloud-sdks: ${line}. guard-oss ships one local adapter per key interface; cloud adapters (AWS, Google Cloud, Azure) belong in ee/.`);
}
if (found.length > 0) process.exit(1);
console.log("cloud-sdks: no @aws-sdk/*, @google-cloud/* or @azure/* under apps/ or packages/");
