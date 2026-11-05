import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-personal-paths.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const repo = async (files: Record<string, string | Buffer>, untracked: Record<string, string> = {}): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-paths-"));
  roots.push(root);
  for (const [file, text] of Object.entries({ ...files, ...untracked })) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  execFileSync("git", ["init", "-q", root]);
  if (Object.keys(files).length > 0) execFileSync("git", ["-C", root, "add", "--", ...Object.keys(files)]);
  return root;
};

const check = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });

const personal = [
  `{"profile": "(subpath \\"${"/Users"}/someone/Library/Caches/python\\")"}`,
  `cd ${"/home"}/someone/src`,
  `${"/USERS"}/Someone/notes`,
  `C:${"\\Users"}\\someone\\AppData`,
  `"${"\\/Users"}\\/someone\\/x"`,
];

const generic = [
  `${"/Users"}/ada/bin/claude`,
  `${"/Users"}/<you>/Library`,
  "~/Library/Caches/python",
  `https://typescript-eslint.io${"/users"}/configs/`,
  `PATCH /scim/v2${"/Users"}/:id`,
  `\`\${base}${"/Users"}/\${row.userId}/\``,
];

describe("check-personal-paths", () => {
  it.each(personal)("fails a tracked file that names a home dir: %s", async (text) => {
    const result = check(await repo({ "docs/notes.md": `intro\n${text}\n` }));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("personal-paths: docs/notes.md:2: ");
  });

  it.each(generic)("passes placeholders, URLs and templated paths: %s", async (text) => {
    const result = check(await repo({ "docs/notes.md": `${text}\n` }));
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("skips untracked, binary and allowlisted files", async () => {
    const line = `${"/Users"}/someone/x\n`;
    const result = check(
      await repo(
        { "tests/integration/scripts/public-export.test.ts": line, "model.bin": Buffer.from(`\0${line}`) },
        { "scratch.md": line },
      ),
    );
    expect([result.status, result.stdout]).toEqual([0, "personal-paths: no personal path in 1 tracked files\n"]);
  });
});
