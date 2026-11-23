import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ESLINT_TIMEOUT, lines, lintFiles, lintText, root } from "./cli";

type Allowlist = Record<string, { scope: string[]; allow: Array<{ files: string[]; reason: string }> } | string>;

const GUARDRAILS = ["vibtra/no-key-material", "vibtra/no-process-env", "vibtra/no-envelope-prefix-literal", "vibtra/no-org-locked-tx-cast"];

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
    for (const file of ["apps/registry/src/guard/local-signer.ts", "packages/guard-contract/src/signing.ts", "apps/registry/src/vault/seal.ts", "tests/integration/registry/probe.test.ts"]) {
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

  it("vibtra/no-envelope-prefix-literal fires on a prefix outside the sealers, and says to read envelopePrefix", async () => {
    const code = lines('export const a = "kms.v1.";', "export const b = `bao.v2.`;", 'export const c = "a vault.v1. row";', 'export const d = "v1.";', 'export const e = "Kms.v1.";');
    expect(await hits(code, "apps/registry/src/vault/tripwire.ts")).toEqual([
      "vibtra/no-envelope-prefix-literal 1:18",
      "vibtra/no-envelope-prefix-literal 2:18",
      "vibtra/no-envelope-prefix-literal 3:18",
    ]);
    expect((await messagesOf('export const a = "kms.v1.";\n', "ee/src/kms.ts"))[0]).toBe(
      'Do not hard-code the envelope prefix "kms.v1.". Read it from VaultSealer.envelopePrefix (or envelopePrefixes for every prefix a ring opens), so a new sealer (a KMS one, say) is covered without editing this file.',
    );
    expect(await hits(code, "apps/registry/src/vault/seal.ts")).toEqual([]);
  });

  it("vibtra/no-org-locked-tx-cast fires on a cast to OrgLockedTx outside org-lock.ts, however the type is named, and says to take the tx from withOrgLock", async () => {
    const code = lines(
      'import type { OrgLockedTx, OrgLockedTx as Locked } from "../store/org-lock.js";',
      'import type * as lock from "../store/org-lock.js";',
      "export const a = (orgId: string) => ({ orgId }) as OrgLockedTx;",
      "export const b = (orgId: string) => <OrgLockedTx>{ orgId };",
      "export const c = (x: unknown) => x as unknown as Locked;",
      "export const d = (x: unknown) => x as lock.OrgLockedTx;",
      'export const e = (x: unknown) => x as import("../store/org-lock.js").OrgLockedTx;',
      "export const f = (x: unknown) => x as Forged;",
      "export const g = (x: unknown) => x as OrgLockedTx & { extra: true };",
      "export const h = (x: unknown) => x as { orgId: string };",
      "type Forged = Locked;",
    );
    expect(await hits(code, "apps/registry/src/guard/store.ts")).toEqual([
      "vibtra/no-org-locked-tx-cast 3:37",
      "vibtra/no-org-locked-tx-cast 4:37",
      "vibtra/no-org-locked-tx-cast 5:34",
      "vibtra/no-org-locked-tx-cast 6:34",
      "vibtra/no-org-locked-tx-cast 7:34",
      "vibtra/no-org-locked-tx-cast 8:34",
      "vibtra/no-org-locked-tx-cast 9:34",
    ]);
    expect((await messagesOf(code, "tests/integration/registry/forged.test.ts"))[0]).toBe(
      "Do not cast to OrgLockedTx. Only withOrgLock(orgId, fn) in apps/registry/src/store/org-lock.ts makes one, after it takes the org lock, and the stores trust it. Take the tx that withOrgLock passes to fn and pass it down. A cast is allowed only in the files listed for vibtra/no-org-locked-tx-cast in tools/eslint/guardrails.json.",
    );
    expect(await hits(code, "apps/registry/src/store/org-lock.ts")).toEqual([]);
  });

  it("an inline eslint-disable cannot switch a guardrail off", async () => {
    const result = await lintText(lines("// eslint-disable-next-line vibtra/no-process-env", "export const a = process.env.X;"), "apps/registry/src/guard/service.ts");
    expect(result.messages.map((message) => message.ruleId)).toContain("@eslint-community/eslint-comments/no-restricted-disable");
  });
});

describe.concurrent("VIB-65 guardrail lint rules: the bypasses review found", ESLINT_TIMEOUT, () => {
  it("B2: vibtra/no-key-material fires on the signing module's key helpers, generateKeyPair(Sync), a dynamic crypto import and an aliased crypto namespace", async () => {
    const code = lines(
      'import { generateGuardSigningKey, signGuardBundle } from "@vibtra/guard-contract/signing";',
      "export const minted = (bundle: never) => signGuardBundle(bundle, generateGuardSigningKey());",
      'import { generateKeyPairSync } from "node:crypto";',
      'export const exported = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" });',
      'const nc = await import("node:crypto");',
      'export const viaDynamic = (input: Buffer, key: never) => nc.sign("sha256", input, key);',
      "const a = nc;",
      'export const viaAlias = (input: Buffer, key: never) => a.sign("sha256", input, key);',
      'const { generateKeyPair } = await import("node:crypto");',
      'export const viaNamespacePair = () => nc.generateKeyPairSync("ec", { namedCurve: "P-256" });',
      'export { signEs256 } from "../../../packages/guard-contract/src/signing.js";',
      'export { generateKeyPair };',
    );
    expect(await hits(code, "apps/registry/src/guard/service.ts")).toEqual([
      "vibtra/no-key-material 1:10",
      "vibtra/no-key-material 3:10",
      "vibtra/no-key-material 6:58",
      "vibtra/no-key-material 8:56",
      "vibtra/no-key-material 9:9",
      "vibtra/no-key-material 10:39",
      "vibtra/no-key-material 11:10",
    ]);
    expect(await hits(code, "apps/registry/src/guard/local-signer.ts")).toEqual([]);
  });

  it("S1: vibtra/no-process-env fires on node:process imports, aliases, a template-literal key and Reflect.get", async () => {
    const code = lines(
      'import { env } from "node:process";',
      'import proc from "node:process";',
      'import * as np from "node:process";',
      "export const a = proc.env.VIBTRA_X;",
      "export const b = np.env;",
      "export const c = process[`env`];",
      "const p = process;",
      "export const d = p.env;",
      'export const e = Reflect.get(process, "env");',
      'const required = require("node:process");',
      "export const f = required.env;",
      "export { env };",
    );
    expect(await hits(code, "apps/registry/src/guard/service.ts")).toEqual([
      "vibtra/no-process-env 1:10",
      "vibtra/no-process-env 4:18",
      "vibtra/no-process-env 5:18",
      "vibtra/no-process-env 6:18",
      "vibtra/no-process-env 8:18",
      "vibtra/no-process-env 9:18",
      "vibtra/no-process-env 11:18",
    ]);
  });

  it("nit: vibtra/no-process-env sees through as, ! and default parameters", async () => {
    const code = lines(
      "export const a = (process as NodeJS.Process).env;",
      "export const b = process!.env;",
      "export const c = (p = process) => p.env;",
      "export const d = ({ env } = process) => env;",
      "export const e = (globalThis as any).process.env;",
      "export const f = (p: { env: string } = { env: \"\" }) => p.env;",
    );
    expect(await hits(code, "apps/registry/src/guard/service.ts")).toEqual([
      "vibtra/no-process-env 1:18",
      "vibtra/no-process-env 2:18",
      "vibtra/no-process-env 3:35",
      "vibtra/no-process-env 4:21",
      "vibtra/no-process-env 5:18",
    ]);
  });

  it("nit: vibtra/no-key-material fires on WebCrypto exportKey(pkcs8 or jwk) and generateKey of an extractable signing key", async () => {
    const code = lines(
      'export const a = (k: CryptoKey) => crypto.subtle.exportKey("pkcs8", k);',
      'export const b = (k: CryptoKey) => crypto.subtle.exportKey("jwk", k);',
      'export const c = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);',
      'export const d = (k: CryptoKey) => crypto.subtle.exportKey("spki", k);',
      'export const e = () => crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);',
      'export const f = () => crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);',
    );
    expect(await hits(code, "apps/registry/src/guard/service.ts")).toEqual(["vibtra/no-key-material 1:36", "vibtra/no-key-material 2:36", "vibtra/no-key-material 3:24"]);
    expect((await messagesOf(code, "apps/registry/src/guard/service.ts"))[0]).toContain('exportKey("pkcs8") is allowed only in the files listed for vibtra/no-key-material');
  });

  it("S5: an allow entry with only exempts just the names it lists", async () => {
    const keys = lines("export const sealed = (row: { sealedPrivateKey: Buffer }) => row.sealedPrivateKey;", "export const opened = (row: { privateKeyPem: string }) => row.privateKeyPem;");
    for (const file of ["apps/registry/src/guard/store.ts", "apps/registry/src/guard/postgres-store.ts"]) {
      expect(await hits(keys, file), file).toEqual(["vibtra/no-key-material 2:31", "vibtra/no-key-material 2:63"]);
    }
    const env = lines("export const landing = process.env.VIBTRA_LANDING_DIST;", "export const other = process.env.VIBTRA_VAULT_KEY;", "export const all = process.env;", 'export const dynamic = (name: string) => process.env[name];');
    expect(await hits(env, "apps/registry/src/server.ts")).toEqual(["vibtra/no-process-env 2:22", "vibtra/no-process-env 3:20", "vibtra/no-process-env 4:42"]);
  });

  it("R6: vibtra/no-envelope-prefix-literal finds a prefix inside strings, templates, regex literals and RegExp sources", async () => {
    const code = lines(
      "export const a = /^(vault|bao)\\.v1\\./;",
      "export const b = \"SELECT id FROM vault WHERE sealed LIKE 'vault.v1.%'\";",
      "export const c = (x: string) => `vault.v1.${x}`;",
      'export const d = new RegExp("^vault\\\\.v1\\\\.");',
      'export const e = "kms-ee.v1.";',
      'export const f = RegExp(`^(?:vault|kms-ee)[.]v\\\\d+[.]`);',
      'export const g = "see https://example.com/docs/v1.2 and node.v1.x";',
      'export const h = new RegExp("^v1\\\\.");',
    );
    expect(await hits(code, "apps/registry/src/vault/tripwire.ts")).toEqual([
      "vibtra/no-envelope-prefix-literal 1:18",
      "vibtra/no-envelope-prefix-literal 2:18",
      "vibtra/no-envelope-prefix-literal 3:33",
      "vibtra/no-envelope-prefix-literal 4:29",
      "vibtra/no-envelope-prefix-literal 5:18",
      "vibtra/no-envelope-prefix-literal 6:25",
      "vibtra/no-envelope-prefix-literal 7:18",
    ]);
    expect(await messagesOf('export const b = "x LIKE \'vault.v1.%\'";\n', "apps/registry/src/vault/tripwire.ts")).toEqual([
      expect.stringContaining('Do not hard-code the envelope prefix "vault.v1."'),
    ]);
  });

  it("nit: vibtra/no-envelope-prefix-literal fires on a regex literal, a concatenation and a template with a placeholder", async () => {
    const code = lines(
      "export const a = /^kms\\.v1\\./;",
      'export const b = "kms" + ".v1.";',
      "export const c = (n: string) => `${n}.v1.`;",
      'export const d = (n: string) => n + ".v1.";',
      "export const e = /^v1\\./;",
      'export const f = (n: string) => `${n}.json`;',
    );
    expect(await hits(code, "apps/registry/src/vault/tripwire.ts")).toEqual([
      "vibtra/no-envelope-prefix-literal 1:18",
      "vibtra/no-envelope-prefix-literal 2:18",
      "vibtra/no-envelope-prefix-literal 3:33",
      "vibtra/no-envelope-prefix-literal 4:33",
    ]);
  });
});
