import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESLINT_TIMEOUT, lines, lintFiles, lintText, root } from "./cli";

type Allowlist = Record<string, { scope: string[]; allow: Array<{ files: string[]; reason: string }> } | string>;

const GUARDRAILS = ["vibtra/no-key-material", "vibtra/no-process-env", "vibtra/no-envelope-prefix-literal"];

const hits = async (code: string, file: string) =>
  (await lintText(code, file)).messages.filter((message) => GUARDRAILS.includes(message.ruleId ?? "")).map((message) => `${message.ruleId} ${message.line}:${message.column}`);

const messagesOf = async (code: string, file: string) =>
  (await lintText(code, file)).messages.filter((message) => GUARDRAILS.includes(message.ruleId ?? "")).map((message) => message.message);

const keyMaterial = lines(
  'import { createPrivateKey, sign } from "node:crypto";',
  'import * as nodeCrypto from "crypto";',
  "export const leak = (row: { privateKeyPem: string }) => row.privateKeyPem;",
  'export const named = "sealedPrivateKey";',
  'export const raw = (pem: string, input: Buffer) => sign("sha256", input, createPrivateKey(pem));',
  'export const viaNamespace = (pem: string, input: Buffer) => nodeCrypto.sign("sha256", input, nodeCrypto.createPrivateKey(pem));',
  'export const viaRequire = () => require("node:crypto").createPrivateKey("x");',
);

describe.concurrent("VIB-65 guardrail lint rules", ESLINT_TIMEOUT, () => {
  it("the repository is clean under every guardrail rule", async () => {
    const results = await lintFiles(["apps", "packages", "scripts", "tools", "infra", "tests"]);
    const found = results.flatMap((result) =>
      result.messages.filter((message) => GUARDRAILS.includes(message.ruleId ?? "")).map((message) => `${path.relative(root, result.filePath)}:${message.line} ${message.ruleId}`),
    );
    expect(found).toEqual([]);
  });

  it("every allowlist entry in tools/eslint/guardrails.json has a reason", async () => {
    const allowlist = JSON.parse(await readFile(path.join(root, "tools/eslint/guardrails.json"), "utf8")) as Allowlist;
    const rules = Object.entries(allowlist).filter(([rule]) => rule.startsWith("vibtra/"));
    expect(rules.map(([rule]) => rule)).toEqual(GUARDRAILS);
    for (const [rule, config] of rules) {
      if (typeof config === "string") throw new Error(`${rule} has no scope`);
      for (const entry of config.allow) expect(entry.reason.trim().length, `${rule} ${entry.files.join(",")}`).toBeGreaterThanOrEqual(20);
    }
  });

  it("vibtra/no-key-material fires on key names, createPrivateKey and node:crypto sign outside the allowlist", async () => {
    expect(await hits(keyMaterial, "apps/registry/src/guard/service.ts")).toEqual([
      "vibtra/no-key-material 1:10",
      "vibtra/no-key-material 1:28",
      "vibtra/no-key-material 3:29",
      "vibtra/no-key-material 3:61",
      "vibtra/no-key-material 4:22",
      "vibtra/no-key-material 5:74",
      "vibtra/no-key-material 6:61",
      "vibtra/no-key-material 6:94",
      "vibtra/no-key-material 7:33",
    ]);
  });

  it("vibtra/no-key-material says to ask GuardSigner instead", async () => {
    expect(await messagesOf("export const pem = (k: { privateKeyPem: string }) => k;\n", "packages/ui/src/key.ts")).toEqual([
      "Ask GuardSigner.sign() for a signature; never hold a private key outside LocalSigner (apps/registry/src/guard/local-signer.ts). privateKeyPem is allowed only in the files listed for vibtra/no-key-material in tools/eslint/guardrails.json.",
    ]);
  });

  it("vibtra/no-key-material stays quiet in the allowlisted key modules and on WebCrypto's subtle.sign", async () => {
    for (const file of ["apps/registry/src/guard/local-signer.ts", "packages/guard-contract/src/signing.ts", "apps/registry/src/guard/store.ts", "tests/integration/registry/probe.test.ts"]) {
      expect(await hits(keyMaterial, file), file).toEqual([]);
    }
    expect(await hits("export const s = (k: CryptoKey, d: Uint8Array) => crypto.subtle.sign(\"ECDSA\", k, d);\n", "apps/registry/src/guard/service.ts")).toEqual([]);
  });

  it("vibtra/no-process-env fires outside config.ts and the CLI entry, and says where to read it", async () => {
    const code = lines("export const a = process.env.VIBTRA_X;", 'export const b = process.env["VIBTRA_Y"];', "const { env } = process;", "export const c = globalThis.process.env;", "export { env };");
    expect(await hits(code, "apps/registry/src/guard/service.ts")).toEqual([
      "vibtra/no-process-env 1:18",
      "vibtra/no-process-env 2:18",
      "vibtra/no-process-env 3:9",
      "vibtra/no-process-env 4:18",
    ]);
    expect((await messagesOf("export const a = process.env;\n", "packages/guard-contract/src/x.ts"))[0]).toBe(
      "Read process.env only in apps/registry/src/config.ts (or the CLI entry). Add the variable to loadRegistryConfig and the known-variable list there, and pass the parsed value in, so an unknown or ineffective variable is refused at boot instead of silently ignored.",
    );
    for (const file of ["apps/registry/src/config.ts", "apps/registry/src/cli.ts", "scripts/probe.mjs", "tests/integration/registry/probe.test.ts"]) {
      expect(await hits(code, file), file).toEqual([]);
    }
  });

  it("vibtra/no-envelope-prefix-literal fires on a whole-string prefix outside the sealers, and says to read envelopePrefix", async () => {
    const code = lines('export const a = "kms.v1.";', "export const b = `bao.v2.`;", 'export const c = "a vault.v1. row";', 'export const d = "v1.";', 'export const e = "Kms.v1.";');
    expect(await hits(code, "apps/registry/src/vault/tripwire.ts")).toEqual(["vibtra/no-envelope-prefix-literal 1:18", "vibtra/no-envelope-prefix-literal 2:18"]);
    expect((await messagesOf('export const a = "kms.v1.";\n', "ee/src/kms.ts"))[0]).toBe(
      'Do not hard-code the envelope prefix "kms.v1.". Read it from VaultSealer.envelopePrefix (or envelopePrefixes for every prefix a ring opens), so a new sealer such as kms.v1. is covered without editing this file.',
    );
    expect(await hits(code, "apps/registry/src/vault/seal.ts")).toEqual([]);
  });

  it("an inline eslint-disable cannot switch a guardrail off", async () => {
    const result = await lintText(lines("// eslint-disable-next-line vibtra/no-process-env", "export const a = process.env.X;"), "apps/registry/src/guard/service.ts");
    expect(result.messages.map((message) => message.ruleId)).toContain("@eslint-community/eslint-comments/no-restricted-disable");
  });
});
