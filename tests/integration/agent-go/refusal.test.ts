import { createHash } from "node:crypto";
import { validateChannel, validateEnvelope } from "@vibtra/guard-contract/policy";
import { describe, expect, it } from "vitest";
import { catalogueDocument, contentRule, createSigner, startOrigin, type Json } from "./harness.ts";
import { activityRows, decisions, policyProfile, queuedEvents, record, startRunning, useAgentSuite, viaProxy, viaProxyClosing, type PolicyProfileOptions, type Reply } from "./running.ts";

const suite = useAgentSuite();
const TFN = contentRule("gcr_0123456789abcdef", { kind: "au-tfn", requireContext: true }, { name: "Synthetic rule" });
const PROMPT = '{"messages":[{"content":"My TFN is 123 456 782"}]}';
const WORKSPACE = { enabled: true, url: "https://workspace.example/" };
const settings = (changes: Json = {}): Json => ({ requestsEnabled: true, workspaceRedirect: { enabled: false }, snippetPolicy: "redacted", snippetMax: 80, ...changes });

const decisionId = (eventId: string): string => `pd_${createHash("sha256").update(`guard-refusal:${eventId}`).digest("hex").slice(0, 32)}`;

const blockedAgent = async (options: PolicyProfileOptions & { orgId?: string; orgName?: string; orgHandle?: string } = {}) => {
  const signer = { ...createSigner(), ...(options.orgId === undefined ? {} : { orgId: options.orgId }) };
  const profile = await policyProfile(suite, { ...options, signer });
  if (options.orgName !== undefined || options.orgHandle !== undefined) await profile.writeDevice({ ...(options.orgName === undefined ? {} : { orgName: options.orgName }), ...(options.orgHandle === undefined ? {} : { orgHandle: options.orgHandle }) });
  const origin = await startOrigin(suite.cleanup);
  const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
  return { agent, origin, profile };
};

const send = (agent: { proxyPort: number }, headers: Record<string, string> = {}, body: string | Buffer = PROMPT, url = "http://chatgpt.com/backend-api/conversation"): Promise<Reply> =>
  viaProxy(agent, { method: "POST", url, headers: { "content-type": "application/json", accept: "application/json", ...headers }, body });

describe("the JSON refusal names the reason and a next step Guard can keep", () => {
  it("gives each kind of block its own code and next step", async () => {
    const cases: { name: string; options: PolicyProfileOptions; headers?: Record<string, string>; body?: Buffer; code: string; next: string; steps?: number; policy?: string }[] = [
      { name: "content", options: { bundle: { contentRules: [TFN] } }, code: "GUARD_CONTENT_BLOCKED", next: "Remove or replace", policy: TFN.ruleId as string },
      { name: "service", options: { bundle: { services: { "openai-chatgpt": { action: "block" } } } }, code: "GUARD_SERVICE_BLOCKED", next: "request access", policy: "guard.services" },
      { name: "ask", options: { bundle: { contentRules: [{ ...TFN, action: "ask" }] } }, code: "GUARD_APPROVAL_REQUIRED", next: "retry only after approval is applied", policy: TFN.ruleId as string },
      { name: "requests disabled", options: { bundle: { services: { "openai-chatgpt": { action: "block" } }, settings: settings({ requestsEnabled: false }) } }, code: "GUARD_SERVICE_BLOCKED", next: "access requests are disabled" },
      {
        name: "HTTP coverage",
        options: { bundle: { settings: settings({ workspaceRedirect: WORKSPACE }) } },
        headers: { "content-encoding": "gzip" },
        body: Buffer.from("invalid"),
        code: "GUARD_INSPECTION_UNAVAILABLE",
        next: "inspection coverage",
        steps: 1,
        policy: "guard.inspection",
      },
    ];
    for (const item of cases) {
      const { agent, origin, profile } = await blockedAgent({ ...item.options, orgId: "org_fernwood" });
      const reply = await send(agent, item.headers, item.body);
      expect([reply.status, origin.received.length], item.name).toEqual([403, 0]);
      const body = reply.json();
      const policy = record(body.policy);
      const reasons = Array.isArray(policy.reasons) ? policy.reasons.map(record) : [];
      const next = Array.isArray(policy.next) ? policy.next.map(record) : [];
      expect([policy.decision, policy.version, reasons[0]?.code], item.name).toEqual(["deny", "vibtra.policy/v1", item.code]);
      expect(String(next[0]?.text), item.name).toContain(item.next);
      if (item.steps !== undefined) expect(next, item.name).toHaveLength(item.steps);
      if (item.policy !== undefined) expect(record(Array.isArray(policy.policies) ? policy.policies[0] : undefined).id, item.name).toBe(item.policy);
      const eventId = String(body.eventId);
      const [event] = (await queuedEvents(profile.dataDir)).filter((queued) => queued.eventId === eventId);
      expect([policy.orgId, policy.time, policy.id, reply.headers["x-vibtra-policy-decision"]], item.name).toEqual(["org_fernwood", event?.occurredAt, decisionId(eventId), decisionId(eventId)]);
    }
  });

  it("keeps the existing Guard fields and adds the policy envelope for JSON clients, and serves HTML to browsers", async () => {
    const { agent } = await blockedAgent({ bundle: { contentRules: [{ ...TFN, action: "ask" }], settings: settings({ workspaceRedirect: WORKSPACE }) } });
    for (const accept of ["application/json", "*/*", "text/html"]) {
      const reply = await send(agent, { accept, origin: "https://chatgpt.com" });
      expect([reply.status, reply.headers["cache-control"]], accept).toEqual([403, "no-store"]);
      expect(reply.headers["x-vibtra-guard"], accept).toMatch(/^blocked; event=gev_[0-9a-f]{16}$/);
      const decision = reply.headers["x-vibtra-policy-decision"];
      expect(decision, accept).toMatch(/^pd_[0-9a-f]{32}$/);
      if (accept === "text/html") {
        expect(reply.headers["content-type"]).toContain("text/html");
        expect(reply.text).toContain("<form");
        expect(reply.text).toContain("Ask IT for access");
        continue;
      }
      const body = reply.json();
      for (const key of ["code", "eventId", "action", "blockPage", "requestsEnabled", "service", "message", "ruleId", "workspace", "error", "reason", "policy"]) expect(body[key], `${accept} ${key}`).toBeDefined();
      const policy = record(body.policy);
      expect([policy.id, body.reason, body.action, body.code], accept).toEqual([decision, policy.message, "ask", "GUARD_BLOCKED"]);
      expect(String(body.error)).toMatch(/^vibtra: blocked/);
      expect(reply.headers["access-control-expose-headers"]).toContain("x-vibtra-policy-decision");
      expect(reply.headers["access-control-allow-origin"]).toBe("https://chatgpt.com");
    }
  });

  it("passes the canonical vibtra.policy/v1 validators for every refusal kind", async () => {
    const variants: [string, PolicyProfileOptions, Record<string, string>, string | Buffer][] = [
      ["content", { bundle: { contentRules: [TFN] } }, {}, PROMPT],
      ["service", { bundle: { services: { "openai-chatgpt": { action: "block" } } } }, {}, PROMPT],
      ["ask", { bundle: { contentRules: [{ ...TFN, action: "ask" }] } }, {}, PROMPT],
      ["coverage", {}, { "content-encoding": "gzip" }, Buffer.from("invalid")],
    ];
    for (const [name, options, headers, body] of variants) {
      const { agent } = await blockedAgent({ ...options, orgId: "org_fernwood" });
      const reply = await send(agent, headers, body);
      const json = reply.json();
      const envelope = validateEnvelope(json.policy);
      expect(envelope.ok, `${name}: ${JSON.stringify(envelope)}`).toBe(true);
      const channel = validateChannel("http", {
        status: reply.status,
        headers: { "content-type": String(reply.headers["content-type"]), "x-vibtra-policy-decision": String(reply.headers["x-vibtra-policy-decision"]) },
        body: { error: json.error, reason: json.reason, policy: json.policy },
      });
      expect(channel.ok, `${name}: ${JSON.stringify(channel)}`).toBe(true);
    }
  });

  it("copies no request, rule, note, workspace or unsafe organisation text into the envelope", async () => {
    const secret = "private-4111111111111111-Bearer-abcdef123456";
    const catalogue = catalogueDocument({ services: [{ serviceId: "chat", name: secret, vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
    const { agent } = await blockedAgent({
      orgId: "sk-ant-private-synthetic-value",
      catalogue,
      bundle: { contentRules: [contentRule(`gcr_${secret}`, { kind: "au-tfn", requireContext: true }, { name: secret, note: secret })], settings: settings({ workspaceRedirect: { enabled: true, url: `https://user:password@private.example/?token=${secret}` } }) },
    });
    const reply = await send(agent, {}, PROMPT, `http://${secret}.chatgpt.com/${secret}`);
    expect(reply.status).toBe(403);
    const policy = record(reply.json().policy);
    const raw = JSON.stringify(policy);
    for (const value of [secret, "password", "private.example", "sk-ant-", "Bearer", "4111111111111111"]) expect(raw, value).not.toContain(value);
    expect(policy.orgId).toBe("org_unknown");
    expect(record(Array.isArray(policy.policies) ? policy.policies[0] : undefined).id).toBe("guard.content");
  });

  it("keeps an opaque registry organisation ID and refuses unsafe ones", async () => {
    for (const [orgId, expected] of [
      ["pDMe00nOedzBdzGpKPSRKpkxkYRyBmNk", "pDMe00nOedzBdzGpKPSRKpkxkYRyBmNk"],
      ["short", "org_unknown"],
      ["has space in it here", "org_unknown"],
      ["sk-ant-private-synthetic-value", "org_unknown"],
    ]) {
      const { agent } = await blockedAgent({ orgId, bundle: { services: { "openai-chatgpt": { action: "block" } } } });
      expect(record((await send(agent)).json().policy).orgId, orgId).toBe(expected);
    }
  });

  it("delivers the refusal to a client that announces Connection: close and is still sending a large body", async () => {
    const { agent, origin } = await blockedAgent({ bundle: { services: { "openai-chatgpt": { action: "block" } } } });
    const large = Buffer.alloc(32 * 1024 * 1024, "A");
    for (const round of [1, 2, 3, 4, 5]) {
      const reply = await viaProxyClosing(agent, { method: "POST", url: "http://chatgpt.com/backend-api/conversation", headers: { "content-type": "application/json", accept: "application/json" }, body: large });
      expect([reply.status, reply.json().code], `round ${round}`).toEqual([403, "GUARD_BLOCKED"]);
    }
    expect(origin.received).toHaveLength(0);
  });

  it("refuses a blocked WebSocket handshake with the HTTP envelope", async () => {
    const { agent } = await blockedAgent({ bundle: { services: { "openai-chatgpt": { action: "block" } } } });
    const reply = await viaProxy(agent, { method: "GET", url: "http://chatgpt.com/ws", headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } });
    expect(reply.status).toBe(403);
    expect(reply.text).toContain("vibtra.policy/v1");
  });
});

describe("the block page and the desktop notice", () => {
  it("renders the HTML page only for a top-level navigation and streams a notice for everything else", async () => {
    const { agent } = await blockedAgent({ bundle: { services: { "openai-chatgpt": { action: "block" } } } });
    const stream = await decisions(agent);
    suite.cleanup.defer(async () => stream.close());
    const cases: [string, string, string, string, string][] = [
      ["top-level navigation", "text/html,application/xhtml+xml", "navigate", "document", "page"],
      ["navigation without dest", "text/html", "navigate", "", "page"],
      ["iframe navigation", "text/html", "navigate", "iframe", "notice"],
      ["fetch asking for HTML", "text/html", "cors", "empty", "notice"],
      ["fetch JSON", "application/json", "cors", "empty", "notice"],
      ["SSE", "text/event-stream", "cors", "empty", "notice"],
      ["WebSocket handshake", "", "websocket", "websocket", "notice"],
      ["native client", "*/*", "", "", "notice"],
      ["command line asking for HTML", "text/html", "", "", "notice"],
    ];
    for (const [index, [name, accept, mode, dest, delivery]] of cases.entries()) {
      const headers: Record<string, string> = { accept, "user-agent": `case${index}/1.0` };
      if (mode !== "") headers["sec-fetch-mode"] = mode;
      if (dest !== "") headers["sec-fetch-dest"] = dest;
      const reply = await viaProxy(agent, { method: "GET", url: "http://chatgpt.com/", headers });
      expect(reply.status, name).toBe(403);
      expect((await stream.next("decision")).delivery, name).toBe(delivery);
    }
  });

  it("names the organisation and rule, gives a truthful next step and carries no request detail", async () => {
    const cases: { name: string; options: PolicyProfileOptions; headers?: Record<string, string>; body?: Buffer; rule: string; next: string; form: boolean }[] = [
      { name: "content", options: { bundle: { contentRules: [TFN] } }, rule: "Synthetic rule", next: "Remove or replace the matched data", form: true },
      { name: "service, requests on", options: { bundle: { services: { "openai-chatgpt": { action: "block" } } } }, rule: "Service policy", next: "Request access below", form: true },
      { name: "service, requests off", options: { bundle: { services: { "openai-chatgpt": { action: "block" } }, settings: settings({ requestsEnabled: false }) } }, rule: "Service policy", next: "Access requests are turned off", form: false },
      { name: "ask", options: { bundle: { services: { "openai-chatgpt": { action: "ask" } } } }, rule: "Service policy", next: "Request access below", form: true },
      { name: "coverage", options: {}, headers: { "content-encoding": "gzip" }, body: Buffer.from("invalid"), rule: "Inspection unavailable", next: "coverage before you try again", form: false },
    ];
    for (const item of cases) {
      const { agent } = await blockedAgent({ ...item.options, orgName: "Fernwood Health" });
      const reply = await send(agent, { accept: "text/html", ...item.headers }, item.body ?? '{"q":"tfn 123 456 782"}', "http://chatgpt.com/c/secret-path?q=prompt");
      expect([reply.status, String(reply.headers["content-type"]).includes("text/html")], item.name).toEqual([403, true]);
      for (const want of ["<dt>Organisation</dt><dd>Fernwood Health</dd>", `<dt>Rule</dt><dd>${item.rule}</dd>`, "What to do next", item.next]) expect(reply.text, `${item.name}: ${want}`).toContain(want);
      expect(reply.text.includes("<form"), item.name).toBe(item.form);
      for (const secret of ["123 456 782", "secret-path", "q=prompt", "chatgpt.com"]) expect(reply.text, `${item.name}: ${secret}`).not.toContain(secret);
    }
    const { agent } = await blockedAgent({ orgName: "", orgHandle: "", bundle: { services: { "openai-chatgpt": { action: "block" } } } });
    const page = await send(agent, { accept: "text/html" });
    expect(page.text).toContain("<dd>Your organisation</dd>");
    expect(page.text).toContain("<dd>Service policy</dd>");
  });

  it("streams the delivery with the decision and keeps the prompt out of it and out of the block page link", async () => {
    const { agent, origin } = await blockedAgent({ bundle: { contentRules: [TFN] } });
    const stream = await decisions(agent);
    suite.cleanup.defer(async () => stream.close());
    const url = "http://chatgpt.com/backend-api/conversation?draft=secret";
    const navigation = await send(agent, { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "first/1.0" }, PROMPT, url);
    const first = await stream.next("decision");
    expect([navigation.status, navigation.text.includes("What to do next"), first.delivery]).toEqual([403, true, "page"]);
    expect(record(first.inspection).blockDelivery).toBeUndefined();
    const fetched = await send(agent, { accept: "application/json", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "user-agent": "second/1.0" }, PROMPT, url);
    const second = await stream.next("decision");
    expect([fetched.status, fetched.json().code, second.delivery]).toEqual([403, "GUARD_BLOCKED", "notice"]);
    expect(fetched.json().blockPage).toBe(`${agent.localUrl}/blocked/${String(second.eventId)}`);
    for (const message of [first, second]) {
      expect(JSON.stringify(message)).not.toContain("123 456 782");
      expect(JSON.stringify(message)).not.toContain("draft=secret");
    }
    expect(origin.received).toHaveLength(0);
  });

  it("turns a burst of retries into one notice, blocks every retry before the origin and logs no request detail", async () => {
    const { agent, origin } = await blockedAgent({ bundle: { contentRules: [TFN] } });
    const stream = await decisions(agent);
    suite.cleanup.defer(async () => stream.close());
    const url = "http://chatgpt.com/backend-api/conversation?draft=secret";
    const retry = { accept: "application/json", "sec-fetch-mode": "cors", "sec-fetch-dest": "empty", "user-agent": "retrying/1.0" };
    const replies: Reply[] = [];
    for (let attempt = 0; attempt < 6; attempt++) replies.push(await send(agent, retry, PROMPT, url));
    expect(replies.map((reply) => reply.status)).toEqual([403, 403, 403, 403, 403, 403]);
    const first = await stream.next("decision");
    expect(first.delivery).toBe("notice");
    const navigation = await send(agent, { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document", "user-agent": "retrying/1.0" }, PROMPT, url);
    expect(navigation.status).toBe(403);
    const rows = await activityRows(agent);
    expect(rows).toHaveLength(7);
    expect(rows.filter((row) => row.coalesced === true)).toHaveLength(6);
    expect(origin.received).toHaveLength(0);
    const allowed = await send(agent, { "user-agent": "retrying/1.0" }, '{"messages":[{"content":"hello"}]}', url);
    expect(allowed.status).toBe(200);
    const marker = await stream.next("decision");
    expect([marker.action, Object.keys(marker).includes("delivery")]).toEqual(["allowed", false]);
    expect(stream.messages.filter((message) => message.name === "decision")).toHaveLength(2);
    for (const reply of replies) expect(String(reply.json().blockPage)).toMatch(/\/blocked\/[A-Za-z0-9_-]+$/);
    for (const secret of ["123 456 782", "draft=secret", "backend-api", "My TFN"]) expect(agent.log(), secret).not.toContain(secret);
  });

  it("asks for no notice for an allowed request or a monitor-mode block", async () => {
    for (const options of [{}, { bundle: { clientMode: "monitor", contentRules: [TFN] } }] satisfies PolicyProfileOptions[]) {
      const { agent } = await blockedAgent(options);
      const stream = await decisions(agent);
      suite.cleanup.defer(async () => stream.close());
      const reply = await send(agent, { accept: "text/html", "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" });
      expect(reply.status).toBe(200);
      const decision = await stream.next("decision");
      expect(decision.enforced === false || decision.action === "allowed").toBe(true);
      expect(Object.keys(decision)).not.toContain("delivery");
      expect((await activityRows(agent)).length).toBe(1);
    }
  });
});
