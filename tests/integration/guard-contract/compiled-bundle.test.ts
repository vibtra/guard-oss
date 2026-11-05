import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GuardBundle,
  GuardRulesDocument,
  canonicalJson,
  compileGuardBundle,
  decideContent,
  decideRequest,
  defaultGuardSettings,
  seedCatalogue,
  type GuardCatalogue,
  type GuardGrantLike,
  type GuardPerson,
  type GuardRulesDocumentInput,
  type GuardService,
  GuardSettings,
} from "@vibtra/guard-contract";
import { digestOf, generateGuardSigningKey, signGuardBundle, signGuardCatalogue } from "@vibtra/guard-contract/signing";
import { DEVICE_ID, ORG_ID, agentTest, buildGoAgent, enrolmentFor, policyScan, scratch, storedDevice, verdictFacts, writePolicy, type AgentRequest, type GoAgent } from "./support.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const inAWeek = new Date(NOW.getTime() + 7 * DAY).toISOString();
const lastWeek = new Date(NOW.getTime() - 7 * DAY).toISOString();
const TEXT = "tfn 123 456 782, card 4242424242424242, project falcon";

const key = generateGuardSigningKey();
const catalogue = seedCatalogue();
const ada: GuardPerson = { userId: "u_ada", email: "Ada@Fernwood.example", groupIds: ["grp_finance"] };
const bo: GuardPerson = { userId: "u_bo", email: "bo@fernwood.example", groupIds: ["grp_eng"] };
const cy: GuardPerson = { userId: "u_cy", email: "cy@fernwood.example", groupIds: ["grp_finance"] };

const doc = (over: Partial<GuardRulesDocumentInput> = {}): GuardRulesDocument =>
  GuardRulesDocument.parse({
    version: 3,
    defaultAction: "allow",
    serviceRules: [
      { ruleId: "gsr_00000001", serviceId: "*", audience: { kind: "org" }, action: "allow" },
      { ruleId: "gsr_00000002", serviceId: "deepseek", audience: { kind: "org" }, action: "block", note: "Not approved for company data." },
      { ruleId: "gsr_00000003", serviceId: "openai-chatgpt", audience: { kind: "groups", groupIds: ["grp_finance"] }, action: "ask" },
      { ruleId: "gsr_00000004", serviceId: "openai-chatgpt", audience: { kind: "people", emails: ["ada@fernwood.example"] }, action: "block" },
    ],
    contentRules: [
      { ruleId: "gcr_00000001", name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", audience: { kind: "org" }, action: "block" },
      { ruleId: "gcr_00000002", name: "Cards to ChatGPT", detector: { kind: "card-number" }, services: ["openai-chatgpt"], audience: { kind: "org" }, action: "ask" },
      { ruleId: "gcr_00000003", name: "Project words", detector: { kind: "keyword", keywords: ["falcon"] }, services: "*", audience: { kind: "groups", groupIds: ["grp_eng"] }, action: "allow" },
    ],
    ...over,
  });

const withRows = (patches: Record<string, Partial<GuardService>>): GuardCatalogue => ({
  ...catalogue,
  services: catalogue.services.map((s) => ({ ...s, ...patches[s.serviceId] })),
});

const files = scratch("compiled");
let agent: GoAgent;
beforeAll(async () => {
  agent = await buildGoAgent(files.dir());
});
afterAll(() => files.dispose());

interface Applied {
  bundle: GuardBundle;
  catalogue: GuardCatalogue;
  dir: string;
}

const apply = (person: GuardPerson, options: { document?: GuardRulesDocument; grants?: readonly GuardGrantLike[]; settings?: GuardSettings; catalogue?: GuardCatalogue; now?: Date } = {}): Applied => {
  const effective = options.catalogue ?? catalogue;
  const bundle = compileGuardBundle({
    document: options.document ?? doc(),
    catalogue: effective,
    person,
    settings: options.settings ?? defaultGuardSettings(),
    grants: options.grants ?? [],
    orgId: ORG_ID,
    deviceId: DEVICE_ID,
    now: options.now ?? NOW,
  });
  const dir = writePolicy(files.dir(), { device: storedDevice(enrolmentFor(key)), bundle: signGuardBundle(bundle, key), catalogue: signGuardCatalogue(effective, ORG_ID, key) });
  return { bundle, catalogue: effective, dir };
};

const decide = async (applied: Applied, request: AgentRequest) => {
  const agentSays = verdictFacts(await agentTest(agent, applied.dir, request));
  const contractSays = verdictFacts(decideRequest(applied.bundle, applied.catalogue, { host: request.host, cliName: request.cli, bundleId: request.bundleId, text: request.text }));
  expect(agentSays).toEqual(contractSays);
  return agentSays;
};

const agentDigest = async (applied: Applied): Promise<string | undefined> => {
  const scan = await policyScan(agent, applied.dir, [{ id: "probe", host: "chatgpt.com", contentType: "text/plain", body: "hello" }]);
  expect(scan.stderr).toBe("");
  return scan.rows[0]?.bundleDigest;
};

describe("compileGuardBundle: one person's signed document, applied by the Go agent", () => {
  it("the signed bundle carries the person's decisions, never the org's group or address lists", async () => {
    const applied = apply(ada);
    expect(GuardBundle.parse(applied.bundle)).toEqual(applied.bundle);
    const wire = JSON.stringify(signGuardBundle(applied.bundle, key));
    for (const leak of ["grp_finance", "groupIds", "emails"]) expect(wire).not.toContain(leak);
    expect(applied.bundle.person.email).toBe("ada@fernwood.example");
    expect(await agentDigest(applied)).toBe(digestOf(applied.bundle));
  });

  it("the most specific service rule wins: people over groups over org, a named service over `*`", async () => {
    expect((await decide(apply(ada), { host: "chatgpt.com" })).flow).toEqual({ action: "block", source: "rule", ruleId: "gsr_00000004" });
    expect((await decide(apply(cy), { host: "chatgpt.com" })).flow).toEqual({ action: "ask", source: "rule", ruleId: "gsr_00000003" });
    expect((await decide(apply(bo), { host: "chatgpt.com" })).flow).toEqual({ action: "allow", source: "rule", ruleId: "gsr_00000001" });
    expect((await decide(apply(bo), { host: "chat.deepseek.com" })).flow).toEqual({ action: "block", source: "rule", ruleId: "gsr_00000002", note: "Not approved for company data." });
  });

  it("among equally specific rules the later one wins", async () => {
    const document = doc({
      serviceRules: [
        { ruleId: "gsr_00000011", serviceId: "cursor", audience: { kind: "org" }, action: "block" },
        { ruleId: "gsr_00000012", serviceId: "cursor", audience: { kind: "org" }, action: "allow" },
      ],
    });
    expect((await decide(apply(bo, { document }), { host: "cursor.com" })).flow).toEqual({ action: "allow", source: "rule", ruleId: "gsr_00000012" });
  });

  it("a disabled rule, a rule for somebody else and a disabled catalogue row do not reach the agent", async () => {
    const disabledRule = apply(bo, { document: doc({ serviceRules: [{ ruleId: "gsr_00000021", serviceId: "cursor", audience: { kind: "org" }, action: "block", enabled: false }] }) });
    expect(disabledRule.bundle.services.cursor).toBeUndefined();
    expect((await decide(disabledRule, { host: "cursor.com" })).flow).toEqual({ action: "allow", source: "default" });
    expect(apply(bo).bundle.contentRules.map((r) => r.ruleId)).toEqual(["gcr_00000001", "gcr_00000002", "gcr_00000003"]);
    expect(apply(ada).bundle.contentRules.map((r) => r.ruleId)).toEqual(["gcr_00000001", "gcr_00000002"]);
    expect((await decide(apply(ada), { host: "claude.ai", text: "project falcon" })).content).toEqual({ action: "allow", matches: [] });
    expect((await decide(apply(bo), { host: "claude.ai", text: "project falcon" })).content).toEqual({ action: "allow", matches: [{ ruleId: "gcr_00000003", kind: "keyword", count: 1, excepted: false }] });
    const offRow = apply(bo, { catalogue: withRows({ deepseek: { enabled: false } }) });
    expect(offRow.bundle.services.deepseek).toBeUndefined();
    expect(await decide(offRow, { host: "chat.deepseek.com", text: "tfn 123 456 782" })).toEqual({ verdict: "not-intercepted", intercepted: false, enforced: false });
  });

  it("a catalogue row's own default beats the document default when they differ, and adds nothing when they agree", async () => {
    const strict = apply(bo, { document: doc({ serviceRules: [] }), catalogue: withRows({ poe: { defaultAction: "block" } }) });
    expect(strict.bundle.services.poe).toEqual({ action: "block" });
    expect(strict.bundle.services.cursor).toBeUndefined();
    expect((await decide(strict, { host: "poe.com" })).flow).toEqual({ action: "block", source: "default" });
    expect((await decide(strict, { host: "cursor.com" })).flow).toEqual({ action: "allow", source: "default" });
    const same = apply(bo, {
      document: doc({ serviceRules: [], contentRules: [{ ruleId: "gcr_00000041", name: "Off", detector: { kind: "au-tfn" }, services: "*", audience: { kind: "org" }, action: "block", enabled: false }] }),
      catalogue: withRows({ poe: { defaultAction: "allow" } }),
    });
    expect(same.bundle.services.poe).toBeUndefined();
    expect(same.bundle.contentRules).toEqual([]);
    expect(await decide(same, { host: "poe.com", text: "tfn 123 456 782" })).toMatchObject({ verdict: "allowed", flow: { action: "allow", source: "default" }, content: { action: "allow", matches: [] } });
  });

  it("a content rule naming only disabled rows is dropped; one naming some keeps only the enabled ones", async () => {
    const document = doc({
      contentRules: [
        { ruleId: "gcr_00000031", name: "Only disabled", detector: { kind: "au-tfn" }, services: ["deepseek", "poe"], audience: { kind: "org" }, action: "block" },
        { ruleId: "gcr_00000032", name: "Mixed", detector: { kind: "au-tfn" }, services: ["deepseek", "openai-chatgpt"], audience: { kind: "org" }, action: "ask" },
        { ruleId: "gcr_00000033", name: "Unknown", detector: { kind: "au-tfn" }, services: ["not-in-the-catalogue"], audience: { kind: "org" }, action: "block" },
      ],
    });
    const applied = apply(bo, { document, catalogue: withRows({ deepseek: { enabled: false }, poe: { enabled: false } }) });
    expect(applied.bundle.contentRules.map((r) => [r.ruleId, r.services])).toEqual([["gcr_00000032", ["openai-chatgpt"]]]);
    expect((await decide(applied, { host: "chatgpt.com", text: "tfn 123 456 782" })).content).toEqual({ action: "ask", matches: [{ ruleId: "gcr_00000032", kind: "au-tfn", count: 1, excepted: false }] });
  });

  it("a people audience matches the address case- and space-insensitively", async () => {
    const document = doc({ serviceRules: [{ ruleId: "gsr_00000051", serviceId: "cursor", audience: { kind: "people", emails: ["  BO@fernwood.EXAMPLE "] }, action: "block" }] });
    expect((await decide(apply(bo, { document }), { host: "cursor.com" })).flow).toEqual({ action: "block", source: "rule", ruleId: "gsr_00000051" });
    expect(apply(ada, { document }).bundle.services.cursor).toBeUndefined();
  });

  it("the bundle carries the redirect URL only when set, and the snippet policy, and the agent verifies it", async () => {
    const applied = apply(bo, { settings: { ...defaultGuardSettings(), snippetPolicy: "none", workspaceRedirect: { enabled: true, url: "https://vibtra.example/fernwood" } } });
    expect(applied.bundle.settings).toEqual({ requestsEnabled: true, unreproducibleTls: "block", workspaceRedirect: { enabled: true, url: "https://vibtra.example/fernwood" }, snippetPolicy: "none", snippetMax: 80 });
    expect(apply(bo).bundle.settings.workspaceRedirect).toEqual({ enabled: false });
    expect(await agentDigest(applied)).toBe(digestOf(applied.bundle));
  });

  it("uninspectable TLS defaults to block, refuses an unknown choice, compiles the monitor preference and always blocks in enforce, and the agent verifies it", async () => {
    expect(defaultGuardSettings().unreproducibleTls).toBe("block");
    expect(GuardSettings.safeParse({ unreproducibleTls: "allow" }).success).toBe(false);
    expect(apply(ada).bundle.settings.unreproducibleTls).toBe("block");
    for (const clientMode of ["monitor", "enforce"] as const) {
      const applied = apply(ada, { settings: { ...defaultGuardSettings(), clientMode, unreproducibleTls: "tunnel" } });
      expect(GuardBundle.parse(applied.bundle).settings.unreproducibleTls).toBe(clientMode === "monitor" ? "tunnel" : "block");
      expect(await agentDigest(applied)).toBe(digestOf(applied.bundle));
    }
  });

  it("only explicit surface blocks are compiled, a bundle without any keeps the legacy shape, and the agent verifies both", async () => {
    const base = apply(ada);
    expect(base.bundle).not.toHaveProperty("surfaceBlocks");
    expect(apply(ada, { document: doc({ surfaceBlocks: { "claude-web": false } }) }).bundle).toEqual(base.bundle);
    const blocked = apply(ada, { document: doc({ surfaceBlocks: { "claude-web": true, "claude-macos": false, "chatgpt-macos": true } }) });
    expect(blocked.bundle.surfaceBlocks).toEqual({ "claude-web": true, "chatgpt-macos": true });
    const { surfaceBlocks: _blocks, ...rest } = blocked.bundle;
    expect(rest).toEqual(base.bundle);
    expect(GuardRulesDocument.safeParse({ ...doc(), surfaceBlocks: { "codex-macos": true } }).success).toBe(false);
    expect(GuardRulesDocument.safeParse({ ...doc(), surfaceBlocks: { "claude-web": "block" } }).success).toBe(false);
    expect(await agentDigest(base)).toBe(digestOf(base.bundle));
    expect(await agentDigest(blocked)).toBe(digestOf(blocked.bundle));
  });

  it("is canonical-JSON safe and deterministic, and the agent hashes it to the same digest", async () => {
    const first = apply(ada);
    expect(canonicalJson(first.bundle)).toBe(canonicalJson(apply(ada).bundle));
    expect(canonicalJson(first.bundle).startsWith(`{"bundleVersion":3,"catalogueVersion":${JSON.stringify(catalogue.version)},`)).toBe(true);
    expect(await agentDigest(first)).toBe(digestOf(first.bundle));
  });
});

describe("grants become exceptions the agent honours", () => {
  it("live grants become exceptions for this person or the org; expired, revoked and other people's do not", async () => {
    const grants: GuardGrantLike[] = [
      { id: "pgr_a", scope: "user", userId: "u_ada", subject: { serviceId: "openai-chatgpt" }, expiresAt: inAWeek },
      { id: "pgr_b", scope: "user", userId: "u_ada", subject: { serviceId: "openai-chatgpt", ruleId: "gcr_00000001" }, expiresAt: lastWeek },
      { id: "pgr_c", scope: "user", userId: "u_bo", subject: { serviceId: "cursor" } },
      { id: "pgr_d", scope: "org", subject: { serviceId: "deepseek", ruleId: "gcr_00000001" } },
      { id: "pgr_e", scope: "org", subject: { serviceId: "poe" }, revokedAt: lastWeek },
    ];
    const forAda = apply(ada, { grants });
    expect(forAda.bundle.exceptions.map((e) => e.grantId)).toEqual(["pgr_a", "pgr_d"]);
    expect(apply(bo, { grants }).bundle.exceptions.map((e) => e.grantId)).toEqual(["pgr_c", "pgr_d"]);
    expect((await decide(forAda, { host: "chatgpt.com" })).flow).toEqual({ action: "allow", source: "exception", grantId: "pgr_a" });
  });

  it("flow: an exception beats a rule, and a rule beats the default", async () => {
    const excepted = apply(ada, { grants: [{ id: "pgr_a", scope: "user", userId: "u_ada", subject: { serviceId: "openai-chatgpt" } }] });
    expect((await decide(excepted, { host: "chatgpt.com" })).flow).toEqual({ action: "allow", source: "exception", grantId: "pgr_a" });
    expect((await decide(excepted, { host: "chat.deepseek.com" })).flow).toEqual({ action: "block", source: "rule", ruleId: "gsr_00000002", note: "Not approved for company data." });
    const bare = apply(bo, { document: doc({ serviceRules: [], defaultAction: "ask" }) });
    expect((await decide(bare, { host: "cursor.com" })).flow).toEqual({ action: "ask", source: "default" });
  });

  it("an exception carrying a ruleId never excepts the flow", async () => {
    const applied = apply(bo, { grants: [{ id: "pgr_r", scope: "user", userId: "u_bo", subject: { serviceId: "deepseek", ruleId: "gcr_00000001" } }] });
    expect(applied.bundle.exceptions).toEqual([{ grantId: "pgr_r", scope: "user", serviceId: "deepseek", ruleId: "gcr_00000001" }]);
    expect(await decide(applied, { host: "chat.deepseek.com", text: "tfn 123 456 782" })).toMatchObject({ verdict: "blocked", flow: { action: "block", source: "rule", ruleId: "gsr_00000002" } });
  });

  it("an org grant applies to every person; a user grant only to its own person", async () => {
    const grants: GuardGrantLike[] = [
      { id: "pgr_o", scope: "org", subject: { serviceId: "deepseek" }, expiresAt: inAWeek },
      { id: "pgr_u", scope: "user", userId: "u_somebody", subject: { serviceId: "cursor" } },
    ];
    for (const person of [ada, bo, { userId: "u_new", email: "new@fernwood.example", groupIds: [] }]) {
      const applied = apply(person, { grants });
      expect(applied.bundle.exceptions).toEqual([{ grantId: "pgr_o", scope: "org", serviceId: "deepseek", expiresAt: inAWeek }]);
      expect((await decide(applied, { host: "chat.deepseek.com" })).flow).toEqual({ action: "allow", source: "exception", grantId: "pgr_o" });
    }
  });

  it("a grant expiring exactly at compile time is not live; one a millisecond later is", () => {
    const grant = (expiresAt: string): GuardGrantLike[] => [{ id: "pgr_n", scope: "user", userId: "u_bo", subject: { serviceId: "deepseek" }, expiresAt }];
    expect(apply(bo, { grants: grant(NOW.toISOString()) }).bundle.exceptions).toEqual([]);
    expect(apply(bo, { grants: grant(new Date(NOW.getTime() + 1).toISOString()) }).bundle.exceptions.map((e) => e.grantId)).toEqual(["pgr_n"]);
  });
});

describe("decideRequest and the agent agree on one request", () => {
  it("content: the strongest non-excepted action wins; excepted and allow-only matches are still reported", async () => {
    const chat = await decide(apply(bo), { host: "chatgpt.com", text: TEXT });
    expect(chat.verdict).toBe("blocked");
    expect(chat.content).toEqual({
      action: "block",
      matches: [
        { ruleId: "gcr_00000001", kind: "au-tfn", count: 1, excepted: false },
        { ruleId: "gcr_00000002", kind: "card-number", count: 1, excepted: false },
        { ruleId: "gcr_00000003", kind: "keyword", count: 1, excepted: false },
      ],
    });
    expect(decideContent(apply(bo).bundle, { serviceId: "openai-chatgpt" }, { text: TEXT }).decidedBy?.ruleId).toBe("gcr_00000001");
    expect((await decide(apply(bo), { host: "claude.ai", text: TEXT })).content?.matches.map((m) => m.ruleId)).toEqual(["gcr_00000001", "gcr_00000003"]);
    const excepted = apply(bo, { grants: [{ id: "pgr_x", scope: "user", userId: "u_bo", subject: { serviceId: "openai-chatgpt", ruleId: "gcr_00000001" } }] });
    const asked = await decide(excepted, { host: "chatgpt.com", text: TEXT });
    expect(asked.verdict).toBe("asked");
    expect(asked.content?.matches[0]).toEqual({ ruleId: "gcr_00000001", kind: "au-tfn", count: 1, excepted: true, grantId: "pgr_x" });
  });

  it("a host outside the catalogue is not intercepted, a blocked flow runs no detectors, and monitor or enforce is said", async () => {
    const monitor = apply(bo);
    expect(await decide(monitor, { host: "www.google.com", text: "tfn 123 456 782" })).toEqual({ verdict: "not-intercepted", intercepted: false, enforced: false });
    const blocked = await decide(monitor, { host: "chat.deepseek.com", text: "tfn 123 456 782" });
    expect(blocked).toMatchObject({ verdict: "blocked", intercepted: true, enforced: false });
    expect(blocked.content).toBeUndefined();
    const enforce = apply(bo, { settings: { ...defaultGuardSettings(), clientMode: "enforce" } });
    expect(await decide(enforce, { host: "chatgpt.com", text: "tfn 123 456 782" })).toMatchObject({ verdict: "blocked", enforced: true });
    expect(await decide(enforce, { host: "chatgpt.com", text: "hello" })).toMatchObject({ verdict: "allowed", enforced: true });
    expect((await decide(enforce, { host: "chatgpt.com", cli: "codex", text: "hello" })).serviceId).toBe("openai-codex");
  });
});
