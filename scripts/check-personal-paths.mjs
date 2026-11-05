import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_USERS = ["ada"];

export const ALLOWED_FILES = new Map([
  ["tests/integration/scripts/public-export.test.ts", "fixtures that public-export must block as private-absolute-path"],
]);

const placeholder = `(?!(?:${FIXTURE_USERS.join("|")})\\b)`;
const name = "[a-z0-9._-]+";
export const PERSONAL_PATH = new RegExp(
  [
    String.raw`(?<![\w.$}{/-])/(?:users|home)/${placeholder}${name}/`,
    String.raw`\\/(?:users|home)\\/${placeholder}${name}\\/`,
    String.raw`\b[a-z]:(?:\\)+users(?:\\)+${placeholder}${name}\\`,
  ].join("|"),
  "i",
);

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  .split("\0")
  .filter((file) => file !== "" && !ALLOWED_FILES.has(file));
const hits = [];
for (const file of files) {
  let bytes;
  try {
    bytes = readFileSync(path.join(root, file));
  } catch {
    continue;
  }
  if (bytes.includes(0)) continue;
  for (const [index, line] of bytes.toString("utf8").split("\n").entries()) {
    const match = PERSONAL_PATH.exec(line);
    if (match) hits.push(`${file}:${index + 1}: ${match[0]}`);
  }
}
for (const hit of hits) {
  console.error(`personal-paths: ${hit}`);
}
if (hits.length > 0) {
  console.error(`personal-paths: ${hits.length} personal path(s) in tracked files. Write a placeholder (/Users/<you>/, ~/) or record the run without the home dir.`);
  process.exit(1);
}
console.log(`personal-paths: no personal path in ${files.length} tracked files`);
