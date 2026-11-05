import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectors } from "@vibtra/guard-contract/vectors";
import {
  GUARD_CATALOGUE_SEED,
  GuardCatalogue,
  applyCatalogueOverrides,
  compileGuardBundle,
  defaultGuardSettings,
  emptyGuardRules,
  hostMatchesPattern,
  isInterceptedHost,
  seedCatalogue,
  serviceForFlow,
  serviceForHost,
} from "@vibtra/guard-contract";
import { generateGuardSigningKey, signGuardBundle, signGuardCatalogue } from "@vibtra/guard-contract/signing";
import { DEVICE_ID, ORG_ID, PERSON, agentTest, buildGoAgent, enrolmentFor, policyScan, scratch, storedDevice, writePolicy, type GoAgent, type ScanRow } from "./support.js";

const key = generateGuardSigningKey();
const catalogue = seedCatalogue();

const files = scratch("catalogue");
let agent: GoAgent;
beforeAll(async () => {
  agent = await buildGoAgent(files.dir());
});
afterAll(() => files.dispose());

const profileFor = (effective: GuardCatalogue): string => {
  const bundle = compileGuardBundle({ document: emptyGuardRules(), catalogue: effective, person: { ...PERSON, groupIds: [] }, settings: defaultGuardSettings(), grants: [], orgId: ORG_ID, deviceId: DEVICE_ID, now: new Date() });
  return writePolicy(files.dir(), { device: storedDevice(enrolmentFor(key)), bundle: signGuardBundle(bundle, key), catalogue: signGuardCatalogue(effective, ORG_ID, key) });
};

const agentRows = async (effective: GuardCatalogue, hosts: readonly string[]): Promise<Map<string, ScanRow>> => {
  const scan = await policyScan(
    agent,
    profileFor(effective),
    hosts.map((host, i) => ({ id: `h${i}`, host, contentType: "text/plain", body: "hello" })),
  );
  expect(scan.stderr).toBe("");
  return new Map(scan.rows.map((row) => [hosts[Number(row.id.slice(1))]!, row]));
};

const without = (serviceId: string): GuardCatalogue => ({ ...catalogue, services: catalogue.services.map((s) => (s.serviceId === serviceId ? { ...s, enabled: false } : s)) });

describe("the AI-services catalogue seed", () => {
  it("parses, has unique ids and unique host patterns per row, and is at least thirty real services", () => {
    expect(GuardCatalogue.parse(catalogue)).toEqual(catalogue);
    expect(catalogue.services.length).toBeGreaterThanOrEqual(30);
    const ids = catalogue.services.map((s) => s.serviceId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of catalogue.services) expect(new Set(s.domains).size, s.serviceId).toBe(s.domains.length);
  });

  it("every seed row has a vendor and lower-case domains, and the desktop apps carry their bundle ids or CLI names", () => {
    for (const s of GUARD_CATALOGUE_SEED) {
      expect(s.vendor.length, s.serviceId).toBeGreaterThan(0);
      for (const d of s.domains) expect(d, s.serviceId).toBe(d.toLowerCase());
    }
    expect(catalogue.services.filter((s) => s.bundleIds.length > 0 || s.cliNames.length > 0).length).toBeGreaterThanOrEqual(12);
    expect(catalogue.services.find((s) => s.serviceId === "anthropic-claude")?.bundleIds).toContain("com.anthropic.claudefordesktop");
    expect(catalogue.services.find((s) => s.serviceId === "cursor")?.bundleIds).toContain("com.todesktop.230313mzl4w4u92");
  });
});

describe("host and flow matching, in the contract and in the Go agent", () => {
  it("each host matches each pattern the way the vectors say", async () => {
    for (const v of vectors.hosts) expect(hostMatchesPattern(v.host, v.pattern), `${v.host} ~ ${v.pattern}`).toBe(v.matches);
    for (const pattern of new Set(vectors.hosts.map((v) => v.pattern))) {
      const probe = GuardCatalogue.parse({
        version: "probe-1",
        generatedAt: "2026-10-24T00:00:00.000Z",
        services: [{ serviceId: "custom-probe", name: "Probe", vendor: "Example", category: "api", domains: [pattern] }],
      });
      const cases = vectors.hosts.filter((v) => v.pattern === pattern);
      const rows = await agentRows(probe, cases.map((v) => v.host));
      for (const v of cases) expect(rows.get(v.host)?.intercepted, `agent: ${v.host} ~ ${v.pattern}`).toBe(v.matches);
    }
  });

  it("each host resolves to the service the vectors name, and only catalogued hosts are intercepted", async () => {
    const hosts = [...vectors.serviceForHost.map((v) => v.host), "mail.google.com", "gemini.google.com"];
    const rows = await agentRows(catalogue, hosts);
    for (const v of vectors.serviceForHost) {
      expect(serviceForHost(catalogue, v.host)?.serviceId ?? null, v.host).toBe(v.serviceId);
      expect(rows.get(v.host)?.serviceId ?? null, `agent: ${v.host}`).toBe(v.serviceId);
      expect(rows.get(v.host)?.intercepted, `agent: ${v.host}`).toBe(v.serviceId !== null);
    }
    expect(isInterceptedHost(catalogue, "mail.google.com")).toBe(false);
    expect(isInterceptedHost(catalogue, "gemini.google.com")).toBe(true);
    expect(rows.get("mail.google.com")).toMatchObject({ intercepted: false, verdict: "not-intercepted" });
    expect(rows.get("gemini.google.com")).toMatchObject({ intercepted: true, serviceId: "google-gemini" });
  });

  it("an app's bundle id or CLI name wins over the host the vectors share", async () => {
    const dir = profileFor(catalogue);
    for (const v of vectors.serviceForFlow) {
      expect(serviceForFlow(catalogue, v)?.serviceId, JSON.stringify(v)).toBe(v.serviceId);
      const verdict = await agentTest(agent, dir, { host: v.host, cli: v.cliName, bundleId: v.bundleId });
      expect(verdict.service?.serviceId, `agent: ${JSON.stringify(v)}`).toBe(v.serviceId);
    }
  });

  it("a disabled app identity does not fall back to its shared web host", async () => {
    const off = without("openai-codex");
    expect(serviceForFlow(off, { host: "chatgpt.com", cliName: "codex" })).toBeUndefined();
    expect(serviceForFlow(off, { host: "chatgpt.com", bundleId: "com.openai.codex" })).toBeUndefined();
    expect(serviceForFlow(off, { host: "chatgpt.com" })?.serviceId).toBe("openai-chatgpt");
    const dir = profileFor(off);
    expect(await agentTest(agent, dir, { host: "chatgpt.com", cli: "codex" })).toMatchObject({ intercepted: false, verdict: "not-intercepted" });
    expect(await agentTest(agent, dir, { host: "chatgpt.com", bundleId: "com.openai.codex" })).toMatchObject({ intercepted: false, verdict: "not-intercepted" });
    expect((await agentTest(agent, dir, { host: "chatgpt.com" })).service?.serviceId).toBe("openai-chatgpt");
  });

  it("the Anthropic API is its own row, and switching it off leaves claude.ai intercepted", async () => {
    const claude = catalogue.services.find((s) => s.serviceId === "anthropic-claude");
    const api = catalogue.services.find((s) => s.serviceId === "anthropic-api");
    expect(claude?.domains).toEqual(["claude.ai"]);
    expect(api?.domains).toEqual(["api.anthropic.com", "console.anthropic.com", "statsig.anthropic.com"]);
    expect(api?.category).toBe("api");
    expect(api?.markId).toBe("anthropic");
    const off = without("anthropic-api");
    expect(serviceForHost(off, "api.anthropic.com")).toBeUndefined();
    expect(serviceForHost(off, "claude.ai")?.serviceId).toBe("anthropic-claude");
    const rows = await agentRows(off, ["api.anthropic.com", "claude.ai"]);
    expect(rows.get("api.anthropic.com")).toMatchObject({ intercepted: false, verdict: "not-intercepted" });
    expect(rows.get("claude.ai")).toMatchObject({ intercepted: true, serviceId: "anthropic-claude" });
  });
});

describe("an org's overrides, signed and applied", () => {
  it("a disabled row stops matching, a default moves, a custom row joins, and the version says so", async () => {
    const effective = applyCatalogueOverrides(
      catalogue,
      [
        { serviceId: "deepseek", enabled: false },
        { serviceId: "openai-chatgpt", defaultAction: "ask" },
        {
          serviceId: "custom-acme-llm",
          custom: { serviceId: "custom-acme-llm", name: "Acme LLM", vendor: "Acme", category: "api", domains: ["llm.acme.example"], bundleIds: [], cliNames: [], defaultAction: "allow", enabled: true },
        },
      ],
      3,
      "2026-10-16T01:00:00.000Z",
    );
    expect(effective.version).toBe(`${catalogue.version}+org.3`);
    expect(applyCatalogueOverrides(catalogue, [], 0, "2026-10-16T01:00:00.000Z").version).toBe(catalogue.version);
    expect(serviceForHost(effective, "chat.deepseek.com")).toBeUndefined();
    expect(serviceForHost(effective, "chatgpt.com")?.defaultAction).toBe("ask");
    expect(serviceForHost(effective, "llm.acme.example")).toMatchObject({ serviceId: "custom-acme-llm", custom: true });
    const rows = await agentRows(effective, ["chat.deepseek.com", "chatgpt.com", "llm.acme.example"]);
    expect(rows.get("chat.deepseek.com")).toMatchObject({ intercepted: false, verdict: "not-intercepted" });
    expect(rows.get("chatgpt.com")).toMatchObject({ serviceId: "openai-chatgpt", flowAction: "ask", verdict: "asked" });
    expect(rows.get("llm.acme.example")).toMatchObject({ intercepted: true, serviceId: "custom-acme-llm", verdict: "allowed" });
  });
});
