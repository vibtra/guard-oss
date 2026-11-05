import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFixtureJson } from "@vibtra/guard-contract/vectors";
import { describe, expect, it } from "vitest";
import { catalogueDocument, connectFrame, contentRule, encodeBody, protoField, protoNumber, startOrigin, type ContentCoding, type Json } from "./harness.ts";
import { activityRows, local, policyProfile, queuedEvents, rawExchange, record, startRunning, useAgentSuite, viaProxy, viaTunnel } from "./running.ts";

const suite = useAgentSuite();
const PROVIDER_REQUESTS = fileURLToPath(new URL("../../../guard/agent-go/testdata/provider-requests.json", import.meta.url));
const TFN = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });

const echoWithCookies = startOrigin.bind(null, suite.cleanup, (request, response) => {
  response.setHeader("set-cookie", ["a=1", "b=2"]);
  response.setHeader("x-test-encoding", request.headers["content-encoding"] ?? "");
  response.writeHead(200, { "content-type": request.headers["content-type"] ?? "application/octet-stream" });
  response.end(request.body);
});

describe("the proxy decides before the origin sees a byte and forwards allowed bytes unchanged", () => {
  it("blocks a sensitive prompt, preserves binary and oversized bodies, and keeps content out of activity and the queue", async () => {
    const origin = await echoWithCookies();
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
    const blocked = await viaTunnel(agent, { method: "POST", url: "https://chatgpt.com/backend-api/conversation", headers: { "content-type": "application/json" }, body: '{"messages":[{"content":"My TFN is 123 456 782"}]}' });
    expect(blocked.status).toBe(403);
    expect(blocked.json().code).toBe("GUARD_BLOCKED");
    expect(origin.received).toHaveLength(0);

    const raw = Buffer.from([0, 1, 2, 255]);
    const binary = await viaTunnel(agent, { method: "POST", url: "https://chatgpt.com/upload", headers: { "content-type": "application/octet-stream" }, body: raw });
    expect(binary.status).toBe(200);
    expect(binary.body.equals(raw)).toBe(true);
    expect(origin.received[0]?.body.equals(raw)).toBe(true);
    expect(binary.headers["set-cookie"]).toEqual(["a=1", "b=2"]);

    const large = Buffer.alloc(4 * 1024 * 1024 + 100, "A");
    const big = await viaTunnel(agent, { method: "POST", url: "https://chatgpt.com/upload", headers: { "content-type": "text/plain" }, body: large });
    expect(big.status).toBe(200);
    expect(big.body.equals(large)).toBe(true);

    const rows = await activityRows(agent);
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) for (const key of ["text", "body", "prompt", "url"]) expect(Object.keys(row)).not.toContain(key);
    const queued = await queuedEvents(profile.dataDir);
    expect(queued.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(queued)).not.toContain("123 456 782");
  });

  it("asks before a spreadsheet upload leaves, by file type", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: [contentRule("gcr_00000000000000f1", { kind: "file-type", extensions: ["xlsx", "csv"] }, { action: "ask" })] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
    const body = Buffer.concat([
      Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="staff.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n'),
      Buffer.from([0x50, 0x4b, 0, 255]),
      Buffer.from("\r\n--b--\r\n"),
    ]);
    const reply = await viaTunnel(agent, { method: "POST", url: "https://chatgpt.com/upload", headers: { "content-type": "multipart/form-data; boundary=b" }, body });
    expect(reply.status).toBe(403);
    expect([reply.json().action, reply.json().ruleId]).toEqual(["ask", "gcr_00000000000000f1"]);
    expect(origin.received).toHaveLength(0);
  });

  it("forwards an excluded CLI untouched and unrecorded, while the browser on the same host is still blocked", async () => {
    const body = '{"prompt":"TFN 123 456 782"}';
    const origin = await startOrigin(suite.cleanup);
    const catalogue = catalogueDocument({
      version: "loopback-v1",
      services: [
        { serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["127.0.0.1"], bundleIds: [], cliNames: [], custom: true },
        { serviceId: "codex", name: "Codex", vendor: "Example", category: "code", domains: ["127.0.0.1"], bundleIds: [], cliNames: ["codex"], enabled: false, custom: true },
      ],
    });
    const profile = await policyProfile(suite, { bundle: { catalogueVersion: "loopback-v1", contentRules: [TFN] }, catalogue });
    const agent = await startRunning(suite, profile);
    const url = `${origin.url}/backend-api/conversation`;
    const excluded = await viaProxy(agent, { method: "POST", url, headers: { "content-type": "application/json", "user-agent": "codex_cli_rs/0.1" }, body });
    expect(excluded.status).toBe(200);
    expect(excluded.text).toBe(body);
    expect(excluded.headers["x-vibtra-guard"]).toBeUndefined();
    expect(origin.received.map((request) => request.body.toString())).toEqual([body]);
    expect(await activityRows(agent)).toEqual([]);
    expect(await queuedEvents(profile.dataDir)).toEqual([]);

    const browser = await viaProxy(agent, { method: "POST", url, headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 Chrome/155.0" }, body });
    expect(browser.status).toBe(403);
    expect(origin.received).toHaveLength(1);
    expect(await activityRows(agent)).toHaveLength(1);
    expect(await queuedEvents(profile.dataDir)).toHaveLength(1);
  });

  it("stops every positive provider envelope with the matching rule and forwards every negative one unchanged", async () => {
    const cases = readFixtureJson<unknown>(PROVIDER_REQUESTS) as { serviceId: string; host: string; type: string; positive: boolean; contentType: string; body: string }[];
    expect(cases.length).toBeGreaterThan(100);
    const detectors: Json[] = [
      { kind: "au-tfn", requireContext: true },
      { kind: "au-abn" },
      { kind: "au-acn", requireContext: true },
      { kind: "au-medicare", requireContext: true },
      { kind: "card-number" },
      { kind: "secret" },
      { kind: "email-bulk", threshold: 10 },
      { kind: "phone-bulk", threshold: 10 },
    ];
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: detectors.map((detector) => contentRule(String(detector.kind), detector)) } });
    const agent = await startRunning(suite, profile, { upstreamMap: Object.fromEntries(cases.map((item) => [item.host, origin.url])) });
    const named = ["au-tfn", "au-abn", "au-acn", "au-medicare", "card-number", "email-bulk", "phone-bulk"];
    for (const item of cases) {
      const before = origin.received.length;
      const reply = await viaTunnel(agent, { method: "POST", url: `https://${item.host}/guard-eval-provider-envelope`, headers: { "content-type": item.contentType }, body: item.body });
      const label = `${item.serviceId}/${item.type}`;
      if (item.positive) {
        expect([reply.status, reply.json().ruleId, origin.received.length], label).toEqual([403, named.includes(item.type) ? item.type : "secret", before]);
      } else {
        expect([reply.status, reply.text, origin.received.length], label).toEqual([200, item.body, before + 1]);
      }
    }
  });
});

describe("compressed and framed HTTP bodies", () => {
  const encode = (layers: readonly ContentCoding[], body: Buffer): Buffer => layers.reduce((wire, layer) => encodeBody(layer, wire), body);

  it("stops a sensitive compressed body and forwards an allowed one with its original bytes and encoding", async () => {
    const origin = await echoWithCookies();
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
    const encodings: ContentCoding[][] = [["gzip"], ["deflate"], ["br"], ["zstd"], ["gzip", "br"]];
    for (const contentType of ["application/json", "application/proto", "application/connect+json"]) {
      for (const layers of encodings) {
        for (const blocked of [true, false]) {
          const text = blocked ? "TFN 123 456 782" : "hello guard";
          let plain: Buffer = Buffer.from(JSON.stringify({ input: text }));
          if (contentType === "application/proto") plain = protoField(1, text);
          if (contentType === "application/connect+json") plain = connectFrame(0, plain);
          const wire = encode(layers, plain);
          const before = origin.received.length;
          const reply = await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/backend-api/codex/responses", headers: { "content-type": contentType, "content-encoding": layers }, body: wire });
          const label = `${contentType}/${layers.join(",")}/${blocked ? "sensitive" : "allowed"}`;
          if (blocked) {
            expect([reply.status, origin.received.length], label).toEqual([403, before]);
          } else {
            expect([reply.status, reply.body.equals(wire), reply.headers["x-test-encoding"], origin.received.length], label).toEqual([200, true, layers.join(", "), before + 1]);
          }
        }
      }
    }
  });

  it("never turns an undecodable body into an empty allowed request; monitor mode forwards and observes it", async () => {
    const cases: { name: string; encoding: string; body?: Buffer; contentType: string }[] = [
      { name: "unknown", encoding: "unknown", body: Buffer.from('{"input":"TFN 123 456 782"}'), contentType: "application/json" },
      { name: "invalid", encoding: "gzip", body: Buffer.from("invalid"), contentType: "application/json" },
      { name: "empty-invalid", encoding: "gzip", contentType: "application/json" },
      { name: "depth", encoding: "gzip,gzip,gzip,gzip", body: Buffer.from("invalid"), contentType: "application/json" },
      { name: "bomb", encoding: "gzip", body: encodeBody("gzip", Buffer.alloc(4 * 1024 * 1024 + 1, "a")), contentType: "application/json" },
      { name: "wire-limit", encoding: "gzip", body: Buffer.alloc(4 * 1024 * 1024 + 1, "a"), contentType: "application/json" },
      { name: "connect-invalid", encoding: "identity", body: Buffer.from([0, 0, 0, 0, 1, 0x7b]), contentType: "application/connect+json" },
      { name: "proto-invalid", encoding: "identity", body: Buffer.from([0xff]), contentType: "application/proto" },
    ];
    for (const mode of ["enforce", "monitor"] as const) {
      const origin = await startOrigin(suite.cleanup, (_request, response) => response.writeHead(200).end());
      const profile = await policyProfile(suite, { bundle: { clientMode: mode } });
      const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
      for (const item of cases) {
        const before = origin.received.length;
        const reply = await viaProxy(agent, {
          method: "POST",
          url: "http://chatgpt.com/backend-api/codex/responses",
          headers: { "content-type": item.contentType, "content-encoding": item.encoding, ...(item.body === undefined ? { "transfer-encoding": "chunked" } : {}) },
          ...(item.body === undefined ? {} : { body: item.body }),
        });
        const [latest] = await activityRows(agent);
        const label = `${mode}/${item.name}`;
        if (mode === "enforce") {
          expect([reply.status, origin.received.length], label).toEqual([403, before]);
          expect([latest?.reason, latest?.ruleName, latest?.matchType, latest?.requestsEnabled], label).toEqual(["http-coverage", "Inspection unavailable", undefined, false]);
        } else {
          expect([reply.status, origin.received.length, latest?.action], label).toEqual([200, before + 1, "observed"]);
        }
      }
    }
  });

  it("answers 408 to a compressed or Connect body that never finishes and forwards no prefix of it", { timeout: 60_000 }, async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url, "claude.ai": origin.url } });
    const unfinished = (target: string, headers: string, body: Buffer): Buffer =>
      Buffer.concat([Buffer.from(`POST ${target} HTTP/1.1\r\nHost: ${new URL(target).host}\r\n${headers}Transfer-Encoding: chunked\r\n\r\n${body.length.toString(16)}\r\n`), body, Buffer.from("\r\n")]);
    const started = Date.now();
    const replies = await Promise.all([
      rawExchange(agent.proxyPort, unfinished("http://chatgpt.com/backend-api/codex/responses", "Content-Type: application/json\r\nContent-Encoding: gzip\r\n", encodeBody("gzip", Buffer.from('{"input":"TFN 123 456 782"}'))), {
        until: (received) => received.includes("\r\n\r\n"),
        timeoutMs: 40_000,
      }),
      rawExchange(agent.proxyPort, unfinished("http://claude.ai/claudeai-rpc/Service/SubmitTurn", "Content-Type: application/connect+proto\r\n", connectFrame(0, protoField(1, "TFN 123 456 782"))), {
        until: (received) => received.includes("\r\n\r\n"),
        timeoutMs: 40_000,
      }),
    ]);
    for (const reply of replies) expect(reply.toString().split("\r\n")[0]).toBe("HTTP/1.1 408 Request Timeout");
    expect(Date.now() - started).toBeLessThan(35_000);
    expect(origin.received).toHaveLength(0);
  });
});

describe("Connect RPC through the HTTPS proxy", () => {
  it("blocks card and key prompts before the origin and forwards an allowed frame byte for byte", async () => {
    const origin = await startOrigin(suite.cleanup);
    const rules = ["card-number", "secret"].map((kind, index) => contentRule(`gcr_00000000000000d${index}`, { kind }));
    const profile = await policyProfile(suite, { bundle: { contentRules: rules } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "claude.ai": origin.url } });
    const url = "https://claude.ai/claudeai-rpc/ExampleService/SubmitTurn";
    const card = protoField(1, protoField(2, "Guard test: payment card number 4111 1111 1111 1111."));
    const key = protoField(1, "-----BEGIN PRIVATE KEY-----\nGUARD_SYNTHETIC_NOT_A_KEY");
    for (const [contentType, encoding, body] of [
      ["application/connect+proto", "", connectFrame(0, card)],
      ["application/connect+proto", "gzip", connectFrame(1, encodeBody("gzip", card))],
      ["application/proto", "", key],
    ] as const) {
      const reply = await viaTunnel(agent, { method: "POST", url, headers: { "content-type": contentType, ...(encoding === "" ? {} : { "connect-content-encoding": encoding }) }, body });
      expect([reply.status, origin.received.length]).toEqual([403, 0]);
    }
    const wire = connectFrame(1, encodeBody("gzip", Buffer.concat([protoField(1, "Write a friendly greeting."), protoNumber(2, 4111111111111111n)])));
    const allowed = await viaTunnel(agent, { method: "POST", url, headers: { "content-type": "application/connect+proto", "connect-content-encoding": "gzip" }, body: wire });
    expect(allowed.status).toBe(200);
    expect(allowed.body.equals(wire)).toBe(true);
    expect(origin.received[0]?.body.equals(wire)).toBe(true);
    const queued = JSON.stringify(await queuedEvents(profile.dataDir));
    expect(queued).not.toContain("4111 1111 1111 1111");
    expect(queued).not.toContain("GUARD_SYNTHETIC_NOT_A_KEY");
  });
});

describe("local inspection facts", () => {
  it("labels requests with fixed categories, route shapes and media types, never the raw path", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite);
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url, "claude.ai": origin.url } });
    const cases: [string, string, string, string, Record<string, string>][] = [
      ["chatgpt.com", "POST", "/backend-api/conversation", "conversation", {}],
      ["chatgpt.com", "POST", "/backend-api/conversation/private-id", "unclassified", {}],
      ["chatgpt.com", "POST", "/ces/v1/t", "background", {}],
      ["claude.ai", "POST", "/backend-api/conversation", "unclassified", {}],
      ["chatgpt.com", "GET", "/c/private-id", "navigation-or-fetch", {}],
    ];
    for (const [host, method, requestPath, category] of cases) {
      await viaProxy(agent, { method, url: `http://${host}${requestPath}`, headers: { "content-type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
      const [latest] = await activityRows(agent);
      expect(record(latest?.inspection).requestCategory, `${method} ${host}${requestPath}`).toBe(category);
    }
    await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/api/private-user-id/events/private-token", headers: { "content-type": "application/x-private-customer-value; boundary=private" }, body: "x" });
    const [privateRow] = await activityRows(agent);
    expect(record(privateRow?.inspection).routeShape).toBe("/api/_/events/_");
    expect(record(privateRow?.inspection).mediaType).toBe("other");
    await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/api/envelope", headers: { "content-type": "application/x-sentry-envelope; charset=utf-8" }, body: "x" });
    const [sentryRow] = await activityRows(agent);
    expect(record(sentryRow?.inspection).mediaType).toBe("application/x-sentry-envelope");
    const everything = JSON.stringify(await activityRows(agent));
    for (const secret of ["private-id", "private-user-id", "private-token", "x-private-customer-value", "boundary=private"]) expect(everything).not.toContain(secret);
  });

  it("keeps match diagnostics as fixed categories in local activity and out of the event queue", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: [contentRule("gcr_00000000000000e1", { kind: "card-number" })] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
    const value = "4111111111111111";
    const reply = await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/backend-api/conversation", headers: { "content-type": "application/json" }, body: JSON.stringify({ "private-customer-field": value }) });
    expect(reply.status).toBe(403);
    const [row] = await activityRows(agent);
    const diagnostics = record(row?.inspection).matchDiagnostics;
    expect(Array.isArray(diagnostics)).toBe(true);
    expect(record(Array.isArray(diagnostics) ? diagnostics[0] : undefined)).toMatchObject({ detector: "card-number", view: "primary", fieldClass: "other", spanShape: "integer", spanLength: value.length, candidateDigits: 16, wholeSpan: true });
    expect(JSON.stringify(row)).not.toContain(value);
    expect(JSON.stringify(row)).not.toContain("private-customer-field");
    const queued = JSON.stringify(await queuedEvents(profile.dataDir));
    expect(queued).toContain("card-number");
    for (const absent of ["diagnostic", "fieldClass", value]) expect(queued).not.toContain(absent);
  });

  it("warns about a context-free numeric rule without changing it", async () => {
    const legacy = contentRule("gcr_00000000000000b1", { kind: "au-medicare" }, { name: "Medicare" });
    const contextual = contentRule("gcr_00000000000000b2", { kind: "au-medicare", requireContext: true }, { name: "Medicare" });
    for (const [rule, warnings] of [
      [legacy, 1],
      [contextual, 0],
    ] as const) {
      const agent = await startRunning(suite, await policyProfile(suite, { bundle: { contentRules: [rule] } }));
      const policy = (await local(agent, "/policy")).json();
      expect(policy.warnings).toHaveLength(warnings);
      const [shown] = Array.isArray(policy.contentRules) ? policy.contentRules.map(record) : [];
      expect(record(shown?.detectorConfiguration).requireContext).toBe(rule.detector && record(rule.detector).requireContext);
    }
  });

  it("writes an opt-in, time-limited route capture without queries, cookies or bodies", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite);
    const agent = await startRunning(suite, profile, { upstreamMap: { "claude.ai": origin.url } });
    const out = path.join(profile.dataDir, "route-capture.jsonl");
    const send = () =>
      viaTunnel(agent, {
        method: "POST",
        url: "https://claude.ai/api/organizations/0b1c2d3e-1111-2222-3333-444455556666/x?secret=q",
        headers: { "content-type": "application/json; charset=utf-8", cookie: "session=never-logged" },
        body: '{"prompt":"never-logged"}',
      });
    const exists = async (): Promise<boolean> => stat(out).then(() => true, () => false);
    await send();
    expect(await exists()).toBe(false);
    for (const until of ["not-a-time", new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() + 48 * 3_600_000).toISOString()]) {
      await writeFile(path.join(profile.dataDir, "route-capture"), until.replace(/\.\d{3}Z$/, "Z"), { mode: 0o600 });
      await send();
      expect(await exists(), until).toBe(false);
    }
    await writeFile(path.join(profile.dataDir, "route-capture"), new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"), { mode: 0o600 });
    await send();
    const line = await readFile(out, "utf8");
    for (const want of ['"path":"/api/organizations/{id}/x"', '"contentType":"application/json"', '"host":"claude.ai"', '"method":"POST"']) expect(line).toContain(want);
    for (const never of ["never-logged", "secret", "0b1c2d3e"]) expect(line).not.toContain(never);
    expect((await stat(out)).mode & 0o777).toBe(0o600);
    const shapes: Record<string, string> = {
      "/api/organizations/0b1c2d3e-1111-2222-3333-444455556666/chat_conversations/9f8e7d6c-aaaa-bbbb-cccc-ddddeeeeffff/completion": "/api/organizations/{id}/chat_conversations/{id}/completion",
      "/backend-api/conversation": "/backend-api/conversation",
      "/backend-api/f/conversation": "/backend-api/f/conversation",
      "/v1/messages": "/v1/messages",
      "/x/1234567/y": "/x/{id}/y",
    };
    for (const requestPath of Object.keys(shapes)) await viaTunnel(agent, { method: "POST", url: `https://claude.ai${requestPath}`, headers: { "content-type": "application/json" }, body: "{}" });
    const captured = (await readFile(out, "utf8")).trim().split("\n").slice(1).map((row) => record(JSON.parse(row)).path);
    expect(captured).toEqual(Object.values(shapes));
  });
});
