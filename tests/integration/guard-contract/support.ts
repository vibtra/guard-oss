import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_BANNED_FIELD_FRAGMENTS, GUARD_BANNED_FIELD_NAMES, GUARD_CONTENT_NAMED_FIELDS, GuardEnrolResponse, type GuardVerdict } from "@vibtra/guard-contract";
import { mintDeviceToken, type GuardSigningKeyPair } from "@vibtra/guard-contract/signing";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const PACKAGE_DIR = path.dirname(createRequire(import.meta.url).resolve("@vibtra/guard-contract/package.json"));

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export const runProcess = async (command: string, args: readonly string[], options: { cwd?: string; input?: string; env?: Readonly<Record<string, string>> } = {}): Promise<ProcessResult> => {
  const child = spawn(command, args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let stdinError: Error | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  child.stdin.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE") stdinError = error;
  });
  child.stdin.end(options.input ?? "");
  const [code]: unknown[] = await once(child, "close");
  if (stdinError !== undefined) throw stdinError;
  return { code: typeof code === "number" ? code : null, stdout, stderr };
};

export interface Scratch {
  dir(): string;
  dispose(): void;
}

export const scratch = (label: string): Scratch => {
  const root = mkdtempSync(path.join(os.tmpdir(), `guard-contract-${label}-`));
  let next = 0;
  return {
    dir: () => {
      const dir = path.join(root, String(next++));
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
};

export interface GoAgent {
  run(args: readonly string[], input?: string): Promise<ProcessResult>;
}

export const buildGoAgent = async (into: string, env: Readonly<Record<string, string>> = {}): Promise<GoAgent> => {
  const bin = path.join(into, "vibtra-guard");
  const built = await runProcess("go", ["build", "-tags=guard_test", "-o", bin, "."], { cwd: path.join(REPO_ROOT, "guard/agent-go") });
  if (built.code !== 0) throw new Error(`go build of guard/agent-go failed (${built.code}): ${built.stderr}`);
  return { run: (args, input) => runProcess(bin, args, { input: input ?? "", env }) };
};

export const ORG_ID = "org_fernwood";
export const DEVICE_ID = "gdev_0123456789abcdef";
export const OTHER_DEVICE_ID = "gdev_ffffffffffffffff";
export const PERSON = { userId: "u_bo", email: "bo@fernwood.example" } as const;

export const enrolmentFor = (key: Pick<GuardSigningKeyPair, "keyId" | "publicKeyPem">, deviceId = DEVICE_ID, orgId = ORG_ID): GuardEnrolResponse =>
  GuardEnrolResponse.parse({
    deviceId,
    deviceToken: mintDeviceToken(),
    orgId,
    orgHandle: "fernwood",
    orgName: "Fernwood",
    person: PERSON,
    server: { baseUrl: "https://registry.example.test", syncIntervalSeconds: 60, batchSize: 200 },
    signing: { keyId: key.keyId, alg: "ES256", publicKeyPem: key.publicKeyPem },
    clientMode: "monitor",
  });

export const storedDevice = (enrolment: GuardEnrolResponse): Record<string, unknown> => {
  const { deviceToken: _shownOnce, ...device } = enrolment;
  return { ...device, enrolledAt: "2026-10-24T00:00:00.000Z", revoked: false };
};

export const writePolicy = (dir: string, files: { device: unknown; bundle?: unknown; catalogue?: unknown }): string => {
  writeFileSync(path.join(dir, "device.json"), JSON.stringify(files.device));
  if (files.bundle !== undefined) writeFileSync(path.join(dir, "bundle.json"), JSON.stringify(files.bundle));
  if (files.catalogue !== undefined) writeFileSync(path.join(dir, "catalogue.json"), JSON.stringify(files.catalogue));
  return dir;
};

export interface ScanRequest {
  id: string;
  host: string;
  contentType?: string;
  body?: string;
  userAgent?: string;
  filenames?: string[];
}

export interface ScanRow {
  id: string;
  verdict: GuardVerdict["verdict"];
  enforced: boolean;
  intercepted: boolean;
  serviceId?: string;
  flowAction?: string;
  bundleVersion: number;
  bundleDigest: string;
  catalogueDigest: string;
  matches: Array<{ ruleId: string; kind: string; count: number; action: string; excepted: boolean }>;
}

export const policyScan = async (agent: GoAgent, dir: string, requests: readonly ScanRequest[]): Promise<ProcessResult & { rows: ScanRow[] }> => {
  const result = await agent.run(["policy-scan", "--data-dir", dir], requests.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const rows = result.code === 0 ? result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as ScanRow) : [];
  return { ...result, rows };
};

export interface AgentRequest {
  host: string;
  text?: string;
  cli?: string;
  bundleId?: string;
}

export interface VerdictLike {
  intercepted: boolean;
  service?: { serviceId: string } | undefined;
  flow?: { action: string; source: string; ruleId?: string | undefined; grantId?: string | undefined; note?: string | undefined } | undefined;
  content?: { action: string; matches: Array<{ rule: { ruleId: string }; match: { kind: string; count: number }; excepted: boolean; grantId?: string | undefined }> } | undefined;
  verdict: string;
  enforced: boolean;
}

export const agentTest = async (agent: GoAgent, dir: string, request: AgentRequest): Promise<VerdictLike> => {
  const args = ["test", "--data-dir", dir, "--host", request.host, "--text", request.text ?? ""];
  if (request.cli !== undefined) args.push("--cli", request.cli);
  if (request.bundleId !== undefined) args.push("--bundle-id", request.bundleId);
  const result = await agent.run(args);
  if (result.code !== 0) throw new Error(`vibtra-guard test --host ${request.host} failed (${result.code}): ${result.stderr}`);
  return JSON.parse(result.stdout) as VerdictLike;
};

export const verdictFacts = (v: VerdictLike) => ({
  verdict: v.verdict,
  intercepted: v.intercepted,
  enforced: v.enforced,
  serviceId: v.service?.serviceId,
  flow: v.flow && { action: v.flow.action, source: v.flow.source, ruleId: v.flow.ruleId, grantId: v.flow.grantId, note: v.flow.note },
  content: v.content && {
    action: v.content.action,
    matches: v.content.matches.map((m) => ({ ruleId: m.rule.ruleId, kind: m.match.kind, count: m.match.count, excepted: m.excepted, grantId: m.grantId })),
  },
});

interface SchemaDef {
  typeName?: string;
  shape?: () => Record<string, unknown>;
  type?: unknown;
  valueType?: unknown;
  innerType?: unknown;
  schema?: unknown;
  options?: readonly unknown[];
}

const LEAF_SCHEMAS = new Set(["ZodString", "ZodNumber", "ZodBoolean", "ZodLiteral", "ZodEnum", "ZodNativeEnum", "ZodNull", "ZodUndefined", "ZodAny", "ZodUnknown", "ZodDate"]);

const isZodSchema = (value: unknown): value is { _def: SchemaDef } =>
  typeof value === "object" && value !== null && "_def" in value && typeof value._def === "object" && value._def !== null && "typeName" in value._def;

export const declaredFields = (schema: unknown, at: readonly string[] = []): Array<{ path: string; key: string }> => {
  if (!isZodSchema(schema)) throw new Error(`declaredFields walks zod schemas only, not ${typeof schema} at ${at.join(".") || "the root"}`);
  const def = schema._def;
  switch (def.typeName) {
    case "ZodObject":
      return Object.entries(def.shape?.() ?? {}).flatMap(([key, child]) => [{ path: [...at, key].join("."), key }, ...declaredFields(child, [...at, key])]);
    case "ZodArray":
      return declaredFields(def.type, [...at, "[]"]);
    case "ZodRecord":
      return declaredFields(def.valueType, [...at, "{}"]);
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault":
      return declaredFields(def.innerType, at);
    case "ZodEffects":
      return declaredFields(def.schema, at);
    case "ZodUnion":
    case "ZodDiscriminatedUnion":
      return (def.options ?? []).flatMap((option) => declaredFields(option, at));
    default:
      if (LEAF_SCHEMAS.has(def.typeName ?? "")) return [];
      throw new Error(`declaredFields cannot walk ${def.typeName ?? "an unknown schema"} at ${at.join(".") || "the root"}`);
  }
};

export const bannedFields = (schema: unknown): string[] =>
  declaredFields(schema)
    .filter(({ key }) => {
      const lower = key.toLowerCase();
      if (GUARD_BANNED_FIELD_NAMES.includes(lower)) return true;
      if (GUARD_CONTENT_NAMED_FIELDS.includes(key)) return false;
      return GUARD_BANNED_FIELD_FRAGMENTS.some((fragment) => lower.includes(fragment));
    })
    .map(({ path: field }) => field);
