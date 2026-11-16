import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDocument, contentRule, createProfile, createSigner, jsonLines, jsonObject, runAgentCommand, signEnvelope, startFakeRegistry, startOrigin, waitUntil, type Json } from "./harness.ts";
import { local, policyProfile, queuedEvents, record, startRunning, useAgentSuite, viaTunnel } from "./running.ts";

const suite = useAgentSuite();
const TFN = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PROMPT = '{"messages":[{"content":"My TFN is 123 456 782"}]}';
const SECRET_HEADER = "Bearer sk-made-up-telemetry-token";
const SECRET_QUERY = "made-up-query-value";

const logText = async (dataDir: string): Promise<string> => {
  try {
    return await readFile(path.join(dataDir, "logs", "vibtra-guard.log"), "utf8");
  } catch {
    return "";
  }
};
const logLines = async (dataDir: string): Promise<Json[]> => jsonLines(await logText(dataDir));
const completions = (lines: Json[], requestId: unknown): Json[] => lines.filter((line) => line.msg === "request" && line.request_id === requestId);

const blockedPrompt = async (agent: Parameters<typeof viaTunnel>[0]) =>
  viaTunnel(agent, {
    method: "POST",
    url: `https://chatgpt.com/backend-api/conversation?token=${SECRET_QUERY}`,
    headers: { "content-type": "application/json", authorization: SECRET_HEADER, cookie: "session=made-up-cookie" },
    body: PROMPT,
  });

describe("request telemetry", () => {
  it("writes one completion line per proxied request, tied to the decision event by a UUIDv7, with no content even at debug", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url }, env: { VIBTRA_LOG_LEVEL: "debug" } });

    const blocked = await blockedPrompt(agent);
    expect(blocked.status).toBe(403);
    const event = (await queuedEvents(profile.dataDir)).find((row) => row.action === "blocked");
    expect(event?.requestId).toMatch(UUID_V7);

    const lines = await waitUntil("the completion line", async () => {
      const all = await logLines(profile.dataDir);
      return completions(all, event?.requestId).length > 0 ? all : undefined;
    });
    const done = completions(lines, event?.requestId);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ level: "INFO", host: "chatgpt.com", route: "/_/conversation", method: "POST", verdict: "blocked", rule_id: "gcr_00000000000000a1", status: 403, intercepted: true });
    expect(typeof done[0]?.duration_ms).toBe("number");
    expect(typeof done[0]?.bytes).toBe("number");
    expect(lines.some((line) => line.level === "DEBUG" && line.msg === "step" && line.step === "engine_evaluate" && line.request_id === event?.requestId)).toBe(true);

    const text = await logText(profile.dataDir);
    for (const secret of ["123 456 782", "123456782", "My TFN", SECRET_QUERY, "sk-made-up-telemetry-token", "made-up-cookie", "person@example.test"]) expect(text).not.toContain(secret);
  });

  it("logs no step lines at the default level, and the local API flips the level at runtime for local callers only", async () => {
    const origin = await startOrigin(suite.cleanup);
    const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });

    expect((await blockedPrompt(agent)).status).toBe(403);
    await waitUntil("the first completion line", async () => ((await logLines(profile.dataDir)).some((line) => line.msg === "request") ? true : undefined));
    expect((await logLines(profile.dataDir)).filter((line) => line.level === "DEBUG")).toEqual([]);

    const refused = await local(agent, "/debug/level", { method: "POST", headers: { origin: "https://example.test", "content-type": "application/json" }, body: JSON.stringify({ level: "debug" }) });
    expect(refused.status).toBe(403);
    expect((await local(agent, "/debug/level")).json()).toEqual({ level: "info" });

    const flipped = await local(agent, "/debug/level", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ level: "debug" }) });
    expect([flipped.status, flipped.json()]).toEqual([200, { level: "debug" }]);
    expect((await blockedPrompt(agent)).status).toBe(403);
    await waitUntil("a step line after the flip", async () => ((await logLines(profile.dataDir)).some((line) => line.msg === "step") ? true : undefined));
  });

  it("logs a reload signature failure at ERROR and reports it in health", async () => {
    const signer = createSigner();
    const profile = await createProfile(suite.cleanup, { signer });
    const forger = { ...createSigner(), orgId: signer.orgId, deviceId: signer.deviceId, keyId: signer.keyId };
    await profile.writeFile("bundle.json", JSON.stringify(signEnvelope(forger, "bundle", bundleDocument(signer))));

    const result = await runAgentCommand(suite.binary(), ["status", "--local", "127.0.0.1:9"], { dataDir: profile.dataDir });
    expect(result.code, result.stderr).toBe(0);
    const status = jsonObject(result.stdout);
    expect(status.bundleVersion).toBeUndefined();
    expect(record(status.policyLoad)).toEqual({ reason: "policy-verify-failed" });

    const failures = (await logLines(profile.dataDir)).filter((line) => line.level === "ERROR" && line.reason === "policy-verify-failed");
    expect(failures).toHaveLength(1);
    expect(String(failures[0]?.error)).toContain("did not verify");
  });

  it("sends one X-Request-Id per sync cycle and logs the cycle once with each step", async () => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await createProfile(suite.cleanup, { signer, serverUrl: registry.url });

    const result = await runAgentCommand(suite.binary(), ["sync"], { dataDir: profile.dataDir });
    expect(result.code, result.stderr).toBe(0);
    const ids = new Set(registry.calls.map((call) => call.headers["x-request-id"]));
    expect(ids.size).toBe(1);
    const [syncId] = [...ids];
    expect(syncId).toMatch(UUID_V7);

    const cycles = (await logLines(profile.dataDir)).filter((line) => line.msg === "sync cycle");
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toMatchObject({ level: "INFO", sync_id: syncId, outcome: "ok" });
    expect(Object.keys(record(cycles[0]?.steps))).toEqual(expect.arrayContaining(["preflight", "ruledownload", "postflight"]));
  });
});
