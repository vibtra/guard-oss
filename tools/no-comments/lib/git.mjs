import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export class UsageError extends Error {}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function git(args, encoding = "utf8") {
  try {
    return execFileSync("git", args, { encoding, maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    throw new UsageError(String(error.stderr || error.message).trim());
  }
}

export const repoRoot = () => git(["rev-parse", "--show-toplevel"]).trim();

export function trackedFiles(paths) {
  const listing = git(["ls-files", "-s", "-z", "--full-name", "--error-unmatch", "--", ...paths]);
  const files = new Set();
  for (const entry of listing.split("\0")) {
    const tab = entry.indexOf("\t");
    if (tab < 0) continue;
    const mode = entry.slice(0, 6);
    if (mode === "100644" || mode === "100755") files.add(entry.slice(tab + 1));
  }
  return [...files].sort();
}

export function verifyCommit(ref) {
  git(["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
}

const zeroSha = /^0+$/;

export function changedFiles(base, head, paths) {
  const output = git(["diff", "--raw", "-z", "--no-renames", "--no-abbrev", "--no-ext-diff", base, ...(head ? [head] : []), "--", ...paths]);
  const fields = output.split("\0");
  const changes = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, oldSha, newSha, status] = fields[index].slice(1).split(" ");
    changes.push({ path: fields[index + 1], status, oldMode, newMode, oldSha, newSha: zeroSha.test(newSha) ? null : newSha });
  }
  return changes;
}

export const decode = (bytes) => utf8.decode(bytes);

export const readBlob = (sha) => decode(git(["cat-file", "blob", sha], "buffer"));

export const readWorkingFile = (root, path) => decode(readFileSync(join(root, path)));
