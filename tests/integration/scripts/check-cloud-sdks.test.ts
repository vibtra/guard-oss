import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-cloud-sdks.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tree = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "cloud-sdks-"));
  roots.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
};

const check = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
const manifest = (deps: Record<string, string>) => JSON.stringify({ name: "@vibtra/example", dependencies: deps });

describe("check-cloud-sdks", () => {
  it("passes this repository", () => {
    const result = spawnSync(process.execPath, [SCRIPT], { encoding: "utf8" });
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("passes a tree whose cloud SDKs live only in ee/, infra/, node_modules or dist", async () => {
    const result = check(
      await tree({
        "apps/registry/package.json": manifest({ zod: "^3.25.76" }),
        "apps/registry/src/index.ts": 'import { z } from "zod";\n',
        "apps/registry/node_modules/@aws-sdk/client-kms/index.js": 'export * from "@aws-sdk/core";\n',
        "packages/guard-contract/dist/index.js": 'import "@azure/identity";\n',
        "ee/package.json": manifest({ "@aws-sdk/client-kms": "^3.0.0" }),
        "ee/src/kms.ts": 'import { KMSClient } from "@aws-sdk/client-kms";\n',
        "infra/lib/stack.ts": 'import { KMS } from "@aws-sdk/client-kms";\n',
      }),
    );
    expect([result.status, result.stderr]).toEqual([0, ""]);
  });

  it("fails on every @aws-sdk, @google-cloud or @azure import or dependency under apps/ or packages/, and names each", async () => {
    const result = check(
      await tree({
        "apps/registry/package.json": manifest({ "@aws-sdk/client-kms": "^3.0.0" }),
        "apps/registry/src/kms.ts": 'import { KMSClient } from "@aws-sdk/client-kms";\n',
        "packages/keys/src/gcp.mts": 'const kms = await import("@google-cloud/kms");\n',
        "packages/keys/src/azure.cjs": 'const { KeyClient } = require("@azure/keyvault-keys");\n',
        "packages/keys/src/note.ts": '// import "@aws-sdk/client-kms";\nexport const name = "@aws-sdk/in-a-string-is-fine";\n',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr.trim().split("\n").map((line) => line.slice(0, line.indexOf(". guard-oss")))).toEqual([
      "cloud-sdks: apps/registry/package.json lists @aws-sdk/client-kms in dependencies",
      "cloud-sdks: apps/registry/src/kms.ts imports @aws-sdk/client-kms",
      "cloud-sdks: packages/keys/src/azure.cjs imports @azure/keyvault-keys",
      "cloud-sdks: packages/keys/src/gcp.mts imports @google-cloud/kms",
    ]);
  });
});
