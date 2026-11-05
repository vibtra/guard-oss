import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_API_PREFIX, ConsoleGroupDetail } from "@vibtra/console-api";
import { GUARD_API_PREFIX, GUARD_PROTOCOL_VERSION, GUARD_STARTER_CONTENT_RULES } from "@vibtra/guard-contract";
import { REGISTRY_ORIGIN, startRegistry, type ConsoleReply, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, eventId, required } from "./guard-device.ts";
import { capturingStorage, manualClock, persistedVaultAudit, postgresMissing, sqlRows, withHosted, type Storage } from "./server-options.ts";

const MADE_UP_TFN_DIGITS = /123[\s-]?456[\s-]?782|456[\s-]?782/;

type Json = Record<string, any>;

const json = (reply: ConsoleReply): Json => reply.body as Json;

let registry: TestRegistry;
let owner: Person;
let admin: Person;
let member: Person;
let dee: Person;
let financeId: string;
let storage: Storage;

beforeAll(async () => {
  registry = await startRegistry({ domain: "guard-console.example", configure: capturingStorage((captured) => (storage = captured)) });
  ({ owner, admin, member } = registry.people);
  dee = await registry.join("dee");
  const made = await registry.consoleWrite(owner, "POST", "/groups", { name: "Finance" });
  if (made.status !== 201) throw new Error(`creating the Finance group answered ${made.status}: ${made.text.slice(0, 300)}`);
  financeId = ConsoleGroupDetail.parse(made.body).row.id;
  const added = await registry.consoleWrite(owner, "POST", `/groups/${financeId}/members`, { email: member.email });
  if (added.status >= 300) throw new Error(`adding ${member.email} to Finance answered ${added.status}: ${added.text.slice(0, 300)}`);
});

afterAll(async () => {
  await registry?.close();
});

describe("who may call", () => {
  it("refuses a member with admin_only, and refuses a write without the CSRF header and stores nothing", async () => {
    const asMember = await registry.consoleGet(member, "/guard/overview");
    expect(asMember.status).toBe(403);
    expect(json(asMember).code).toBe("admin_only");
    expect((await registry.consoleWrite(dee, "PUT", "/guard/settings", { clientMode: "enforce" })).status).toBe(403);
    const noCsrf = await fetch(`${registry.url}${CONSOLE_API_PREFIX}/guard/devices/enrol-links`, {
      method: "POST",
      headers: { cookie: owner.cookie, origin: REGISTRY_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ personEmail: member.email }),
    });
    expect(noCsrf.status).toBeGreaterThanOrEqual(400);
    expect(await noCsrf.text()).not.toContain("genr_");
    expect(json(await registry.consoleGet(owner, "/guard/devices/enrol-links")).rows).toEqual([]);
    expect((await registry.consoleGet(owner, "/guard/overview")).status).toBe(200);
  });

  it("answers 404 GUARD_OFF on every Guard door when the registry has no vault key", async () => {
    const off = await startRegistry({
      domain: "guard-off.example",
      configure: withHosted(({ vaultKey: _vaultKey, ...hosted }) => hosted),
    });
    try {
      const rules = await off.consoleGet(off.people.owner, "/guard/rules");
      expect([rules.status, json(rules).code]).toEqual([404, "GUARD_OFF"]);
      const enrol = await fetch(`${off.url}${GUARD_API_PREFIX}/enrol`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect([enrol.status, (await enrol.json()).code]).toEqual([404, "GUARD_OFF"]);
      const asks = await fetch(`${off.url}${GUARD_API_PREFIX}/requests/gdev_0123456789abcdef`);
      expect([asks.status, (await asks.json()).code]).toEqual([404, "GUARD_OFF"]);
    } finally {
      await off.close();
    }
  });
});

describe("the rules", () => {
  it("mints ids and bumps the version on PUT, refuses a stale base with 409, and reads the groups back by name", async () => {
    const page = await registry.consoleGet(owner, "/guard/rules");
    expect(page.status).toBe(200);
    expect(json(page)).toMatchObject({ document: { version: 0, serviceRules: [], contentRules: [] }, clientMode: "monitor", groups: [{ id: financeId, name: "Finance" }] });
    expect((json(page).services as unknown[]).length).toBeGreaterThan(40);
    const document = {
      defaultAction: "allow",
      serviceRules: [
        { serviceId: "deepseek", audience: { kind: "org" }, action: "block", enabled: true, note: "Not approved for company data." },
        { serviceId: "openai-chatgpt", audience: { kind: "groups", groupIds: [financeId] }, action: "ask", enabled: true },
      ],
      contentRules: GUARD_STARTER_CONTENT_RULES.map((rule) => ({ ...rule, services: "*", audience: { kind: "org" }, enabled: true })),
    };
    const put = await registry.consoleWrite(admin, "PUT", "/guard/rules", { baseVersion: 0, document });
    expect(put.status, put.text).toBe(200);
    expect(json(put).document.version).toBe(1);
    expect(json(put).updatedBy).toBe(admin.email);
    for (const rule of json(put).document.serviceRules) expect(rule.ruleId).toMatch(/^gsr_[0-9a-f]{8}$/);
    for (const rule of json(put).document.contentRules) expect(rule.ruleId).toMatch(/^gcr_[0-9a-f]{8}$/);
    const stale = await registry.consoleWrite(owner, "PUT", "/guard/rules", { baseVersion: 0, document });
    expect([stale.status, json(stale).code]).toEqual([409, "STALE_BASE"]);
    const unknown = await registry.consoleWrite(owner, "PUT", "/guard/rules", {
      baseVersion: 1,
      document: { ...document, serviceRules: [{ serviceId: "not-a-service", audience: { kind: "org" }, action: "block", enabled: true }] },
    });
    expect(unknown.status).toBe(400);
    const badGroup = await registry.consoleWrite(owner, "PUT", "/guard/rules", {
      baseVersion: 1,
      document: { ...document, serviceRules: [{ serviceId: "deepseek", audience: { kind: "groups", groupIds: ["team_nope"] }, action: "block", enabled: true }] },
    });
    expect(badGroup.status).toBe(400);
    expect(json(await registry.consoleGet(owner, "/guard/rules")).document.version).toBe(1);
  });

  it("answers would this be blocked: allowed, blocked by the TFN rule, asked, not intercepted, and enforced only in enforce mode", async () => {
    const test = async (body: Json): Promise<Json> => {
      const reply = await registry.consoleWrite(owner, "POST", "/guard/rules/test", body);
      expect(reply.status, reply.text).toBe(200);
      return json(reply);
    };
    expect(await test({ serviceId: "openai-chatgpt", personEmail: dee.email, text: "Summarise this meeting." })).toMatchObject({
      serviceId: "openai-chatgpt",
      serviceName: "ChatGPT",
      intercepted: true,
      verdict: "allowed",
      content: [],
      enforced: false,
    });
    const tfn = await test({ host: "chatgpt.com", personEmail: dee.email, text: "My TFN is 123 456 782, can you check my return?" });
    expect(tfn).toMatchObject({
      verdict: "blocked",
      enforced: false,
      content: [expect.objectContaining({ ruleName: "Tax file numbers", matchType: "au-tfn", count: 1, action: "block", example: "123***782", excepted: false })],
    });
    expect(tfn.explanation).toContain("Tax file numbers");
    expect(tfn.explanation).toContain("monitor mode");
    expect(JSON.stringify(tfn)).not.toMatch(MADE_UP_TFN_DIGITS);
    expect(await test({ serviceId: "openai-chatgpt", personEmail: member.email })).toMatchObject({ verdict: "asked", flow: { action: "ask", source: "rule" } });
    expect(await test({ host: "example.com", text: "123 456 782" })).toMatchObject({ intercepted: false, verdict: "not-intercepted", content: [] });
    expect(await test({ serviceId: "deepseek" })).toMatchObject({ verdict: "blocked", flow: { action: "block", source: "rule" } });
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: "enforce" })).status).toBe(200);
    try {
      expect(await test({ serviceId: "openai-chatgpt", text: "4111 1111 1111 1111" })).toMatchObject({ verdict: "blocked", enforced: true });
    } finally {
      expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: "monitor" })).status).toBe(200);
    }
    expect((await registry.consoleWrite(owner, "POST", "/guard/rules/test", { personEmail: "x@y.example" })).status).toBe(400);
    expect(json(await registry.consoleGet(owner, "/guard/activity")).rows).toEqual([]);
  });
});

describe("the overview and activity", () => {
  it("counts what the laptops uploaded, pages newest first by cursor, and filters by a literal substring", async () => {
    const memberLaptop = await enrolDevice(registry, owner, member, "member-mbp");
    const deeLaptop = await enrolDevice(registry, owner, dee, "dee-mbp");
    const now = Date.now();
    const at = (hours: number) => new Date(now - hours * 3_600_000).toISOString();
    const ev = (fields: Json) => ({ eventId: eventId(), kind: "flow", host: "chatgpt.com", ...fields });
    const memberEvents = [
      ev({ occurredAt: at(1), action: "observed", serviceId: "openai-chatgpt", app: { name: "Google Chrome", bundleId: "com.google.Chrome" }, bytes: 1200 }),
      ev({ occurredAt: at(2), action: "blocked", kind: "content", serviceId: "openai-chatgpt", app: { name: "Google Chrome" }, ruleKind: "content", matchType: "au-tfn", matchCount: 1, snippet: "123***782", bytes: 300 }),
      ev({ occurredAt: at(30), action: "allowed", serviceId: "anthropic-claude", host: "claude.ai", app: { name: "Claude", bundleId: "com.anthropic.claudefordesktop" } }),
    ];
    const deeEvents = [
      ev({ occurredAt: at(3), action: "blocked", serviceId: "deepseek", host: "chat.deepseek.com", app: { name: "Safari" }, ruleKind: "service" }),
      ev({ occurredAt: at(50), action: "asked", serviceId: "openai-chatgpt", app: { name: "50%_off Browser" }, ruleKind: "service" }),
      ev({ occurredAt: at(24 * 20), action: "observed", serviceId: "google-gemini", host: "gemini.google.com" }),
    ];
    for (const [laptop, events] of [[memberLaptop, memberEvents], [deeLaptop, deeEvents]] as const) {
      const up = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events });
      expect(up.body).toEqual({ accepted: 3, rejected: [] });
    }
    const replay = await agentDoor(registry, "POST", `/eventupload/${deeLaptop.deviceId}`, deeLaptop.token, { protocol: GUARD_PROTOCOL_VERSION, events: deeEvents });
    expect(replay.body).toEqual({ accepted: 3, rejected: [] });

    const week = json(await registry.consoleGet(owner, "/guard/overview?days=7"));
    expect(week.windowDays).toBe(7);
    expect(week.totals).toMatchObject({ people: 2, devices: 2, quietDevices: 0, services: 3, events: 5, blocked: 2, asked: 1, openRequests: 0 });
    expect(week.trend).toHaveLength(7);
    expect((week.trend as Array<{ events: number }>).reduce((sum, day) => sum + day.events, 0)).toBe(5);
    expect((week.services as Json[]).find((row) => row.serviceId === "openai-chatgpt")).toMatchObject({ name: "ChatGPT", people: 2, devices: 2, events: 3, blocked: 1, bytes: 1500 });
    expect(week.topApps[0]).toMatchObject({ app: "Google Chrome", events: 2 });
    expect(week.recent).toHaveLength(5);
    expect(week.noDevicesYet).toBe(false);
    expect(json(await registry.consoleGet(owner, "/guard/overview?days=30")).totals.events).toBe(6);
    expect((await registry.consoleGet(owner, "/guard/overview?days=9")).status).toBe(400);

    const first = json(await registry.consoleGet(owner, "/guard/activity?limit=4"));
    expect(first.rows).toHaveLength(4);
    expect(first.nextCursor).toBeDefined();
    const second = json(await registry.consoleGet(owner, `/guard/activity?limit=4&cursor=${encodeURIComponent(first.nextCursor)}`));
    expect(second.rows).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    const ids = [...first.rows, ...second.rows].map((row: { eventId: string }) => row.eventId);
    expect(new Set(ids).size).toBe(6);
    const times = [...first.rows, ...second.rows].map((row: { occurredAt: string }) => row.occurredAt);
    expect(times).toEqual([...times].sort().reverse());
    const rowsFor = async (query: string): Promise<Json[]> => json(await registry.consoleGet(owner, `/guard/activity?${query}`)).rows;
    expect(await rowsFor("q=SAFARI")).toHaveLength(1);
    expect((await rowsFor(`q=${encodeURIComponent("%_off")}`)).map((row) => row.app?.name)).toEqual(["50%_off Browser"]);
    expect(await rowsFor(`q=${encodeURIComponent("_%")}`)).toEqual([]);
    expect(await rowsFor("q=%25")).toHaveLength(1);
    expect(await rowsFor("action=blocked")).toHaveLength(2);
    expect(await rowsFor(`personUserId=${dee.userId}`)).toHaveLength(3);
    expect((await registry.consoleGet(owner, "/guard/activity?cursor=nonsense")).status).toBe(400);

    const outsider = await registry.join("olive", "guard-console-other.example");
    const foreign = await registry.consoleGet(outsider, "/guard/activity");
    expect(foreign.status, foreign.text).toBe(200);
    expect(json(foreign).rows).toEqual([]);
  });
});

describe("TLS coverage failures", () => {
  it("name the TLS bucket in the activity rows and the top blocks, and count against the service", async () => {
    const own = await startRegistry({ domain: "guard-tls-coverage.example" });
    try {
      const { owner: ownOwner, member: ownMember } = own.people;
      const laptop = await enrolDevice(own, ownOwner, ownMember, "cy-tls-coverage");
      const now = new Date().toISOString();
      const upload = async (events: Json[]) => (await agentDoor(own, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events })).body;
      const replay = ["tls-client-hello-unreproducible", "upstream-replay-failed"].map((reason) => ({ eventId: eventId(), occurredAt: now, kind: "flow", action: "blocked", serviceId: "openai-chatgpt", host: "chatgpt.com", reason }));
      expect(await upload(replay)).toEqual({ accepted: 2, rejected: [] });
      const activity = json(await own.consoleGet(ownOwner, "/guard/activity")).rows as Json[];
      expect(activity).toHaveLength(2);
      for (const row of activity) expect(row.ruleName).toBe("Inspection unavailable (TLS)");
      const overview = json(await own.consoleGet(ownOwner, "/guard/overview?days=7"));
      expect(overview.topBlocks).toEqual([expect.objectContaining({ ruleName: "Inspection unavailable (TLS)", count: 2 })]);
      expect(overview.services).toEqual(expect.arrayContaining([expect.objectContaining({ serviceId: "openai-chatgpt", events: 2, blocked: 2 })]));
      const unnamed = [
        { eventId: eventId(), occurredAt: now, kind: "flow", action: "blocked", host: "203.0.113.1", port: 443, reason: "tls-address-without-sni" },
        { eventId: eventId(), occurredAt: now, kind: "flow", action: "blocked", host: "unknown", port: 443, reason: "tls-client-hello-unparseable" },
      ];
      expect(await upload(unnamed)).toEqual({ accepted: 2, rejected: [] });
      expect(json(await own.consoleGet(ownOwner, "/guard/activity")).rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ host: "203.0.113.1", reason: "tls-address-without-sni", ruleName: "Inspection unavailable (TLS)" }),
          expect.objectContaining({ host: "unknown", reason: "tls-client-hello-unparseable", ruleName: "Inspection unavailable (TLS)" }),
        ]),
      );
    } finally {
      await own.close();
    }
  });
});

describe("devices, services and settings", () => {
  it("reports the quiet setting, adds a custom service, switches a seed row off and deletes only custom rows", async () => {
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { quietAfterMinutes: 5 })).status).toBe(200);
    const devices = json(await registry.consoleGet(owner, "/guard/devices"));
    expect(devices.quietAfterMinutes).toBe(5);
    expect(devices.serverUrl).toBe(REGISTRY_ORIGIN);
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { quietAfterMinutes: 1440 })).status).toBe(200);

    const service = { slug: "acme-gpt", name: "Acme GPT", vendor: "Acme", category: "chat", domains: ["gpt.acme-internal.example"], bundleIds: [], cliNames: [], defaultAction: "block" };
    const added = await registry.consoleWrite(owner, "POST", "/guard/services", service);
    expect(added.status, added.text).toBe(201);
    expect(json(added)).toMatchObject({ serviceId: "custom-acme-gpt", custom: true, enabled: true, defaultAction: "block", events30d: 0 });
    expect((await registry.consoleWrite(owner, "POST", "/guard/services", { ...service, name: "Again", domains: ["x.example"] })).status).toBe(409);
    const off = await registry.consoleWrite(owner, "PUT", "/guard/services/perplexity", { enabled: false });
    expect(json(off)).toMatchObject({ serviceId: "perplexity", enabled: false });
    expect(json(await registry.consoleGet(owner, "/guard/services")).catalogueVersion).toMatch(/\+org\.2$/);
    expect(json(await registry.consoleWrite(owner, "POST", "/guard/rules/test", { host: "www.perplexity.ai" })).verdict).toBe("not-intercepted");
    expect(json(await registry.consoleWrite(owner, "POST", "/guard/rules/test", { host: "gpt.acme-internal.example" }))).toMatchObject({ verdict: "blocked", flow: { source: "default" } });
    expect((await registry.consoleWrite(owner, "DELETE", "/guard/services/perplexity")).status).toBe(409);
    const gone = await registry.consoleWrite(owner, "DELETE", "/guard/services/custom-acme-gpt");
    expect(gone.status).toBe(200);
    expect((json(gone).rows as Array<{ serviceId: string }>).some((row) => row.serviceId === "custom-acme-gpt")).toBe(false);
    expect((await registry.consoleWrite(owner, "PUT", "/guard/services/no-such", { enabled: false })).status).toBe(404);
  });

  it("takes a partial settings PUT, needs a URL for the redirect, and renders the notice with the organisation's name", async () => {
    const page = await registry.consoleGet(owner, "/guard/settings");
    expect(page.status).toBe(200);
    expect(json(page).settings).toMatchObject({ requestsEnabled: true, snippetPolicy: "redacted", workspaceRedirect: { enabled: false } });
    expect(json(page).signingKeyId).toMatch(/^gk_[0-9a-f]{8}$/);
    expect(json(page).staffNoticeRendered).not.toContain("{{orgName}}");
    expect(json(page).staffNoticeRendered).toContain(owner.email);
    expect((await registry.consoleWrite(owner, "PUT", "/guard/settings", { workspaceRedirect: { enabled: true } })).status).toBe(400);
    const on = await registry.consoleWrite(owner, "PUT", "/guard/settings", {
      workspaceRedirect: { enabled: true, url: "https://vibtra.example/acme/workboxes" },
      staffNotice: { template: "Notice for {{orgName}}." },
    });
    expect(on.status, on.text).toBe(200);
    expect(json(on).settings.workspaceRedirect).toEqual({ enabled: true, url: "https://vibtra.example/acme/workboxes" });
    expect(json(on).settings.staffNotice.updatedBy).toBe(owner.email);
    expect(json(on).staffNoticeRendered).toMatch(/^Notice for .+\.$/);
    expect(json(on).settings.requestsEnabled).toBe(true);
  });

  it("leaves an audit line for every kind of Guard write, the Guard event first, and no token or matched text", async () => {
    const guard = (await persistedVaultAudit(storage)).filter((row) => row.event === "policy.changed" && String(row.detail ?? "").startsWith("guard."));
    const kinds = new Set(guard.map((row) => String(row.detail).split(":")[0]));
    for (const kind of ["guard.rules.changed", "guard.settings.changed", "guard.device.enrolled", "guard.enrol_link.minted", "guard.service.changed"]) {
      expect(kinds.has(kind), kind).toBe(true);
    }
    expect(guard.find((row) => String(row.detail).startsWith("guard.rules.changed"))?.actorKind).toBe("admin");
    expect(guard.find((row) => String(row.detail).startsWith("guard.device.enrolled"))?.actorKind).toBe("door");
    expect(JSON.stringify(guard)).not.toMatch(/genr_|gdt_|123 456 782/);
  });
});

describe("console edges on a clock", () => {
  const clock = manualClock();
  let edges: TestRegistry;

  beforeAll(async () => {
    edges = await startRegistry({ domain: "guard-console-edges.example", configure: (options) => ({ ...options, clock }) });
  });

  afterAll(async () => {
    await edges?.close();
  });

  it("names a `*` service rule 'Every AI service → …', and an unknown rule id has no name and the top blocks fall back to the id", async () => {
    const { owner: edgeOwner, member: edgeMember } = edges.people;
    const put = await edges.consoleWrite(edgeOwner, "PUT", "/guard/rules", {
      baseVersion: 0,
      document: { defaultAction: "allow", serviceRules: [{ serviceId: "*", audience: { kind: "org" }, action: "block", enabled: true }], contentRules: [] },
    });
    expect(put.status, put.text).toBe(200);
    const star: string = json(put).document.serviceRules[0].ruleId;
    const laptop = await enrolDevice(edges, edgeOwner, edgeMember, "member-names");
    const occurredAt = clock.now().toISOString();
    const up = await agentDoor(edges, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [
        { eventId: eventId(), occurredAt, kind: "flow", action: "blocked", serviceId: "deepseek", ruleId: star, ruleKind: "service" },
        { eventId: eventId(), occurredAt, kind: "flow", action: "blocked", serviceId: "deepseek", ruleId: "gsr_deadbeef", ruleKind: "service" },
      ],
    });
    expect(up.body).toEqual({ accepted: 2, rejected: [] });
    const rows = json(await edges.consoleGet(edgeOwner, `/guard/activity?deviceId=${laptop.deviceId}`)).rows as Json[];
    expect(rows.find((row) => row.ruleId === star)?.ruleName).toBe("Every AI service → block");
    expect(rows.find((row) => row.ruleId === "gsr_deadbeef")).not.toHaveProperty("ruleName");
    const top = json(await edges.consoleGet(edgeOwner, "/guard/overview?days=7")).topBlocks;
    expect(top).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ruleId: star, ruleName: "Every AI service → block", kind: "service", count: 1 }),
        expect.objectContaining({ ruleId: "gsr_deadbeef", ruleName: "gsr_deadbeef", kind: "service", count: 1 }),
      ]),
    );
  });

  it("finds a host for a custom service whose domains are all wildcards, each `*` read as one label", async () => {
    const { owner: edgeOwner } = edges.people;
    const made = await edges.consoleWrite(edgeOwner, "POST", "/guard/services", {
      slug: "wild",
      name: "Wild AI",
      vendor: "Wild",
      category: "chat",
      domains: ["*.wild-ai.example"],
      bundleIds: [],
      cliNames: [],
      defaultAction: "block",
    });
    expect(made.status, made.text).toBe(201);
    const tested = json(await edges.consoleWrite(edgeOwner, "POST", "/guard/rules/test", { serviceId: "custom-wild" }));
    expect(tested).toMatchObject({ intercepted: true, verdict: "blocked", serviceId: "custom-wild", serviceName: "Wild AI" });
    expect(tested.explanation).toContain("Wild AI");
  });
});

describe("quiet laptops on a clock", () => {
  const clock = manualClock();
  let quietRegistry: TestRegistry;

  beforeAll(async () => {
    quietRegistry = await startRegistry({ domain: "guard-console-quiet.example", configure: (options) => ({ ...options, clock }) });
  });

  afterAll(async () => {
    await quietRegistry?.close();
  });

  it("counts a laptop quiet from enrolment once it is silent past the setting, wakes it on a sync, and never counts a revoked one", async () => {
    const { owner: quietOwner, admin: quietAdmin, member: quietMember } = quietRegistry.people;
    expect((await quietRegistry.consoleWrite(quietOwner, "PUT", "/guard/settings", { quietAfterMinutes: 30 })).status).toBe(200);
    const laptop = await enrolDevice(quietRegistry, quietOwner, quietMember, "member-quiet");
    const row = async (): Promise<Json> => {
      const page = json(await quietRegistry.consoleGet(quietOwner, "/guard/devices"));
      return (page.rows as Json[]).find((device) => device.deviceId === laptop.deviceId) ?? {};
    };
    const quietCount = async (): Promise<number> => json(await quietRegistry.consoleGet(quietOwner, "/guard/overview?days=7")).totals.quietDevices;
    expect(await row()).toMatchObject({ quiet: false });
    expect(await quietCount()).toBe(0);
    clock.advance(29 * 60_000 + 59_999);
    expect((await row()).quiet).toBe(false);
    expect(await quietCount()).toBe(0);
    clock.advance(2);
    expect(await row()).toMatchObject({ quiet: true, quietForMinutes: 30 });
    expect(await quietCount()).toBe(1);
    const post = await agentDoor(quietRegistry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      bundleVersion: 0,
      catalogueVersion: "x",
      rulesReceived: 0,
      rulesProcessed: 0,
      clientMode: "monitor",
    });
    expect(post.status, post.text).toBe(200);
    expect((await row()).quiet).toBe(false);
    expect(await quietCount()).toBe(0);
    clock.advance(31 * 60_000);
    expect(await quietCount()).toBe(1);
    const revoked = await quietRegistry.consoleWrite(quietAdmin, "POST", `/guard/devices/${laptop.deviceId}/revoke`, {});
    expect(revoked.status, revoked.text).toBe(200);
    expect(await row()).toMatchObject({ status: "revoked", quiet: false });
    expect(await quietCount()).toBe(0);
    const firstRevoke = json(revoked);
    expect(firstRevoke).toMatchObject({ status: "revoked", revokedBy: quietAdmin.email, revokedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) });
    clock.advance(60_000);
    const again = await quietRegistry.consoleWrite(quietOwner, "POST", `/guard/devices/${laptop.deviceId}/revoke`, {});
    expect(again.status, again.text).toBe(200);
    expect(json(again)).toMatchObject({ status: "revoked", revokedBy: quietAdmin.email, revokedAt: firstRevoke.revokedAt });
  });
});

describe("what Monitor would have blocked", () => {
  let wouldRegistry: TestRegistry;
  let wouldStorage: Storage | undefined;

  beforeAll(async () => {
    wouldRegistry = await startRegistry({ domain: "guard-console-would.example", configure: capturingStorage((captured) => (wouldStorage = captured)) });
  });

  afterAll(async () => {
    await wouldRegistry?.close();
  });

  it("counts a would-block on the card, top rules, services and trend in Monitor only, and keeps Enforce counting what was blocked", async () => {
    const { owner: wouldOwner, member: wouldMember } = wouldRegistry.people;
    const mode = async (clientMode: "monitor" | "enforce"): Promise<void> => {
      expect((await wouldRegistry.consoleWrite(wouldOwner, "PUT", "/guard/settings", { clientMode })).status).toBe(200);
    };
    const overview = async (): Promise<Json> => json(await wouldRegistry.consoleGet(wouldOwner, "/guard/overview?days=7"));
    const trendBlocked = (page: Json): number => (page.trend as Array<{ blocked: number }>).reduce((sum, day) => sum + day.blocked, 0);
    const chatgpt = (page: Json): Json | undefined => (page.services as Json[]).find((row) => row.serviceId === "openai-chatgpt");
    const laptop = await enrolDevice(wouldRegistry, wouldOwner, wouldMember, "member-would");
    const upload = (events: Json[]) => agentDoor(wouldRegistry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION, events });
    const at = new Date().toISOString();
    const content = { kind: "content", serviceId: "openai-chatgpt", host: "chatgpt.com", ruleKind: "content", ruleId: "gcr_00000000000000a1", occurredAt: at };
    const wouldBlock = { ...content, eventId: eventId(), action: "observed", wouldAction: "blocked" };
    const wouldAsk = { ...content, eventId: eventId(), action: "observed", wouldAction: "asked", ruleId: "gcr_00000000000000a2" };
    const plain = { eventId: eventId(), kind: "flow", action: "observed", serviceId: "openai-chatgpt", host: "chatgpt.com", occurredAt: at };

    await mode("monitor");
    expect((await upload([wouldBlock, wouldAsk, plain])).body).toEqual({ accepted: 3, rejected: [] });
    const monitored = await overview();
    expect(monitored.clientMode).toBe("monitor");
    expect(monitored.totals).toMatchObject({ events: 3, blocked: 1, asked: 0 });
    expect(chatgpt(monitored)).toMatchObject({ events: 3, blocked: 1 });
    expect(trendBlocked(monitored)).toBe(1);
    expect([...(monitored.topBlocks as Json[])].sort((a, b) => String(a.ruleId).localeCompare(String(b.ruleId)))).toEqual([
      { ruleId: "gcr_00000000000000a1", ruleName: "gcr_00000000000000a1", kind: "content", count: 1 },
      { ruleId: "gcr_00000000000000a2", ruleName: "gcr_00000000000000a2", kind: "content", count: 1 },
    ]);

    await mode("enforce");
    const enforced = await overview();
    expect(enforced.totals).toMatchObject({ events: 3, blocked: 0, asked: 0 });
    expect(chatgpt(enforced)).toMatchObject({ blocked: 0 });
    expect(trendBlocked(enforced)).toBe(0);
    expect(enforced.topBlocks).toEqual([]);
    const blocked = { ...content, eventId: eventId(), action: "blocked", wouldAction: "blocked" };
    expect((await upload([blocked])).body).toEqual({ accepted: 1, rejected: [] });
    expect((await overview()).totals).toMatchObject({ events: 4, blocked: 1, asked: 0 });

    const rows = json(await wouldRegistry.consoleGet(wouldOwner, "/guard/activity")).rows as Json[];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(Object.keys(row)).not.toContain("wouldAction");
    if (!postgresMissing()) {
      const databaseUrl = required(required(wouldStorage, "the captured storage").databaseUrl, "a database URL");
      expect(await sqlRows(databaseUrl, "SELECT event_id, would_action FROM guard_events WHERE event_id = ANY($1) ORDER BY event_id", [[wouldBlock.eventId, wouldAsk.eventId, plain.eventId, blocked.eventId]])).toEqual(
        [
          { event_id: wouldBlock.eventId, would_action: "blocked" },
          { event_id: wouldAsk.eventId, would_action: "asked" },
          { event_id: plain.eventId, would_action: null },
          { event_id: blocked.eventId, would_action: null },
        ].sort((a, b) => a.event_id.localeCompare(b.event_id)),
      );
    }
  });
});
