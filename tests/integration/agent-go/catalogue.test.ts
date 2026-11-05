import { writeFile } from "node:fs/promises";
import path from "node:path";
import { vectors } from "@vibtra/guard-contract/vectors";
import { describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, contentRule, createProfile, createSigner, jsonLines, jsonObject, runAgentCommand, tempDir, type Json } from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const signer = createSigner();
const TFN_RULE = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });

const decide = async (args: readonly string[], files: { bundle?: Json; catalogue?: Json } = {}): Promise<Json> => {
  const dir = await tempDir(suite.cleanup, "decide");
  const extra: string[] = [];
  for (const [kind, document] of Object.entries(files)) {
    const file = path.join(dir, `${kind}.json`);
    await writeFile(file, JSON.stringify(document));
    extra.push(`--${kind}`, file);
  }
  if (files.bundle === undefined) {
    const file = path.join(dir, "bundle.json");
    await writeFile(file, JSON.stringify(bundleDocument(signer)));
    extra.push("--bundle", file);
  }
  const result = await runAgentCommand(suite.binary(), ["test", ...extra, ...args], { dataDir: path.join(dir, "profile") });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return jsonObject(result.stdout);
};

const serviceOf = (verdict: Json): string | undefined => (verdict.intercepted === true ? String(record(verdict.service).serviceId) : undefined);

const scan = async (rows: readonly Json[], options: { catalogue?: Json; bundle?: Json } = {}): Promise<Json[]> => {
  const profile = await createProfile(suite.cleanup, { signer, ...options });
  const result = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const out = jsonLines(result.stdout);
  expect(out.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  return out;
};

describe("the catalogue decides which hosts the agent intercepts", () => {
  it("matches host patterns exactly as the shared host vectors say", async () => {
    const hosts = vectors.hosts as unknown as { host: string; pattern: string; matches: boolean }[];
    expect(hosts.length).toBeGreaterThan(5);
    for (const item of hosts) {
      const catalogue = catalogueDocument({ services: [{ serviceId: "only", name: "Only", vendor: "Example", category: "chat", domains: [item.pattern], bundleIds: [], cliNames: [], custom: true }] });
      const verdict = await decide(["--host", item.host], { catalogue });
      expect(verdict.intercepted, `${item.host} against ${item.pattern}`).toBe(item.matches);
    }
  });

  it("selects the service the shared flow vectors name, by host, bundle ID and CLI name", async () => {
    const flows = vectors.serviceForFlow as unknown as { host: string; bundleId?: string; cliName?: string; serviceId?: string }[];
    expect(flows.length).toBeGreaterThan(3);
    for (const flow of flows) {
      const verdict = await decide(["--host", flow.host, ...(flow.bundleId === undefined ? [] : ["--bundle-id", flow.bundleId]), ...(flow.cliName === undefined ? [] : ["--cli", flow.cliName])]);
      expect(serviceOf(verdict), JSON.stringify(flow)).toBe(flow.serviceId === "" ? undefined : flow.serviceId);
    }
  });

  it("intercepts every catalogued domain pattern and nothing unrelated", async () => {
    const services = catalogueDocument().services;
    if (!Array.isArray(services)) throw new Error("the seed catalogue has no services");
    const rows: Json[] = [];
    for (const service of services.map(record)) {
      const domains = service.domains;
      if (!Array.isArray(domains)) throw new Error(`${String(service.serviceId)} has no domains`);
      domains.forEach((pattern, index) => rows.push({ id: `${String(service.serviceId)}/${index}`, host: String(pattern).replaceAll("*", "guard-eval") }));
    }
    rows.push({ id: "unrelated", host: "unrelated.example" });
    expect(rows.length).toBeGreaterThan(40);
    const out = await scan(rows);
    for (const row of out.slice(0, -1)) expect(row.intercepted, String(row.id)).toBe(true);
    expect(out.at(-1)?.intercepted).toBe(false);
  });

  it("never widens interception by app identity and picks the most specific shared-host row", async () => {
    expect(serviceOf(await decide(["--host", "unrelated.example", "--bundle-id", "com.openai.codex", "--cli", "codex"]))).toBeUndefined();
    expect(serviceOf(await decide(["--host", "api.anthropic.com"]))).toBe("anthropic-api");
    const out = await scan([
      { id: "codex", host: "chatgpt.com", userAgent: "codex_cli_rs/0.1" },
      { id: "browser", host: "chatgpt.com", userAgent: "Mozilla/5.0 Chrome/155.0" },
      { id: "malformed", host: "chatgpt.com", userAgent: " /// " },
    ]);
    expect(out.map((row) => row.serviceId)).toEqual(["openai-codex", "openai-chatgpt", "openai-chatgpt"]);
  });

  it("does not fall back to the web service for a disabled app on a shared host", async () => {
    const catalogue = catalogueDocument({
      services: [
        { serviceId: "chatgpt", name: "ChatGPT", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true },
        { serviceId: "codex", name: "Codex", vendor: "Example", category: "code", domains: ["chatgpt.com"], bundleIds: ["com.openai.codex"], cliNames: ["codex"], enabled: false, custom: true },
      ],
    });
    expect(serviceOf(await decide(["--host", "chatgpt.com", "--cli", "codex"], { catalogue }))).toBeUndefined();
    expect(serviceOf(await decide(["--host", "chatgpt.com", "--bundle-id", "com.openai.codex"], { catalogue }))).toBeUndefined();
    expect(serviceOf(await decide(["--host", "chatgpt.com"], { catalogue }))).toBe("chatgpt");
  });
});

describe("the policy decides what happens to an intercepted request", () => {
  const text = ["--host", "chatgpt.com", "--text", "TFN 123 456 782"];

  it("blocks in enforce mode, observes in monitor mode, honours a live grant and ignores an expired one", async () => {
    const blocked = await decide(text, { bundle: bundleDocument(signer, { contentRules: [TFN_RULE] }) });
    expect([blocked.verdict, blocked.enforced]).toEqual(["blocked", true]);
    const monitored = await decide(text, { bundle: bundleDocument(signer, { clientMode: "monitor", contentRules: [TFN_RULE] }) });
    expect([monitored.verdict, monitored.enforced]).toEqual(["blocked", false]);
    const grant = (expiresAt: string): Json => ({ grantId: "ggr_00000001", serviceId: "openai-chatgpt", ruleId: TFN_RULE.ruleId, scope: "content", expiresAt });
    const live = await decide(text, { bundle: bundleDocument(signer, { contentRules: [TFN_RULE], exceptions: [grant(new Date(Date.now() + 3_600_000).toISOString())] }) });
    expect(live.verdict).toBe("allowed");
    const expired = await decide(text, { bundle: bundleDocument(signer, { contentRules: [TFN_RULE], exceptions: [grant(new Date(Date.now() - 3_600_000).toISOString())] }) });
    expect(expired.verdict).toBe("blocked");
    const suffix = await decide(["--host", "notchatgpt.com", "--text", "TFN 123 456 782"], { bundle: bundleDocument(signer, { contentRules: [TFN_RULE] }) });
    expect(suffix.intercepted).toBe(false);
  });
});
