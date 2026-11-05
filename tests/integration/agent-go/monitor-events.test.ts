import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GuardEvent } from "@vibtra/guard-contract";
import { catalogueDocument, contentRule, createSigner, runAgentCommand, startFakeRegistry, startOrigin, type Json, type RegistryHandler } from "./harness.ts";
import { activityRows, local, policyProfile, queuedEvents, record, startRunning, useAgentSuite, viaProxy } from "./running.ts";

const suite = useAgentSuite();
const TFN = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });
const SHEET = contentRule("gcr_00000000000000a2", { kind: "file-type", extensions: ["xlsx"] }, { action: "ask" });
const LOOPBACK = catalogueDocument({
  version: "loopback-v1",
  services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["127.0.0.1"], bundleIds: [], cliNames: [], custom: true }],
});
const UNKNOWN_WOULD_ACTION = "(root): Unrecognized key(s) in object: 'wouldAction'";

const sendThree = async (clientMode: "monitor" | "enforce"): Promise<{ queued: Json[]; activity: Json[]; today: unknown }> => {
  const origin = await startOrigin(suite.cleanup);
  const profile = await policyProfile(suite, { bundle: { clientMode, catalogueVersion: "loopback-v1", contentRules: [TFN, SHEET] }, catalogue: LOOPBACK });
  const agent = await startRunning(suite, profile);
  const url = `${origin.url}/backend-api/conversation`;
  await viaProxy(agent, { method: "POST", url, headers: { "content-type": "application/json" }, body: '{"prompt":"TFN 123 456 782"}' });
  const sheet = Buffer.concat([
    Buffer.from('--b\r\nContent-Disposition: form-data; name="file"; filename="staff.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n'),
    Buffer.from([0x50, 0x4b, 0, 255]),
    Buffer.from("\r\n--b--\r\n"),
  ]);
  await viaProxy(agent, { method: "POST", url, headers: { "content-type": "multipart/form-data; boundary=b" }, body: sheet });
  await viaProxy(agent, { method: "POST", url, headers: { "content-type": "application/json" }, body: '{"prompt":"hello"}' });
  return { queued: await queuedEvents(profile.dataDir), activity: await activityRows(agent), today: (await local(agent, "/status")).json().today };
};

describe("a Monitor event says what Enforce would have done", () => {
  it("queues observed with wouldAction blocked or asked in Monitor, nothing extra when allowed, and no wouldAction in Enforce", async () => {
    const monitor = await sendThree("monitor");
    expect(monitor.queued.map((event) => [event.action, event.ruleId, event.wouldAction])).toEqual([
      ["observed", TFN.ruleId, "blocked"],
      ["observed", SHEET.ruleId, "asked"],
      ["observed", undefined, undefined],
    ]);
    expect("wouldAction" in record(monitor.queued[2])).toBe(false);
    expect(monitor.activity.map((row) => [row.wouldAction, row.enforced])).toEqual([
      [undefined, false],
      ["asked", false],
      ["blocked", false],
    ]);
    expect(monitor.today).toEqual({ observed: 3, wouldBlocked: 1, wouldAsked: 1 });
    for (const event of monitor.queued) expect(GuardEvent.safeParse(event).success, JSON.stringify(event)).toBe(true);

    const enforce = await sendThree("enforce");
    expect(enforce.queued.map((event) => [event.action, event.ruleId])).toEqual([
      ["blocked", TFN.ruleId],
      ["asked", SHEET.ruleId],
      ["allowed", undefined],
    ]);
    expect(enforce.today).toEqual({ blocked: 1, asked: 1, allowed: 1 });
    for (const event of [...enforce.queued, ...enforce.activity]) expect(Object.keys(event)).not.toContain("wouldAction");
  });
});

describe("an older registry that rejects wouldAction", () => {
  const queuedRig = async (events: Json[]) => {
    const signer = createSigner();
    const registry = await startFakeRegistry(suite.cleanup, signer);
    const profile = await policyProfile(suite, { signer, serverUrl: registry.url, bundle: { clientMode: "monitor" } });
    await writeFile(path.join(profile.dataDir, "events.jsonl"), events.map((event) => `${JSON.stringify(event)}\n`).join(""), { mode: 0o600 });
    const uploads = (): Json[][] => registry.calls.filter((call) => call.door === "eventupload").map((call) => (record(call.body).events as unknown[]).map(record));
    return { registry, profile, uploads };
  };
  const event = (eventId: string, changes: Json = {}): Json => ({ eventId, occurredAt: new Date().toISOString(), kind: "content", action: "observed", ruleKind: "content", ruleId: TFN.ruleId, ...changes });
  const strictOld =
    (reason: string): RegistryHandler =>
    (call) => {
      if (call.door !== "eventupload") return undefined;
      const events = (record(call.body).events as unknown[]).map(record);
      const rejected = events.filter((item) => "wouldAction" in item).map((item) => ({ eventId: item.eventId, reason }));
      return { status: 200, body: { accepted: events.length - rejected.length, rejected } };
    };

  it("matches the error a strict older registry really returns", () => {
    const legacy = GuardEvent.omit({ wouldAction: true }).safeParse(event("gev_00000000000000b0", { wouldAction: "blocked" }));
    if (legacy.success) throw new Error("the legacy strict schema accepted wouldAction");
    expect(legacy.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ")).toBe(UNKNOWN_WOULD_ACTION);
  });

  it("resends a refused event once without wouldAction in the same sync and empties the queue", async () => {
    const would = event("gev_00000000000000b1", { wouldAction: "blocked" });
    const plain = event("gev_00000000000000b2");
    const rig = await queuedRig([would, plain]);
    rig.registry.override(strictOld(UNKNOWN_WOULD_ACTION));
    const result = await runAgentCommand(suite.binary(), ["sync"], { dataDir: rig.profile.dataDir });
    expect(result.code, result.stderr).toBe(0);
    const { wouldAction: _dropped, ...legacy } = would;
    expect(rig.uploads()).toEqual([[would, plain], [legacy]]);
    expect(await queuedEvents(rig.profile.dataDir)).toEqual([]);
  });

  it("does not resend an event refused for any other reason", async () => {
    const rig = await queuedRig([event("gev_00000000000000b3", { wouldAction: "blocked" })]);
    rig.registry.override(strictOld(`${UNKNOWN_WOULD_ACTION}; ruleId: Invalid`));
    expect((await runAgentCommand(suite.binary(), ["sync"], { dataDir: rig.profile.dataDir })).code).toBe(0);
    expect(rig.uploads()).toHaveLength(1);
    expect(await queuedEvents(rig.profile.dataDir)).toEqual([]);
  });
});
