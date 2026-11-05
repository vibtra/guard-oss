import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  loadRecording,
  recordedRequestBody,
  responseFrames,
  startFakeUpstream,
  type FakeUpstream,
  type Provider,
  type ReceivedRequest,
  type Recording,
} from "../../fakes/upstream.ts";
import {
  buildAgent,
  requestThroughAgent,
  startAgent,
  type AgentBinary,
  type AgentRequest,
  type AgentResponse,
  type TestAgent,
} from "../../support/agent.ts";
import { createCleanup } from "../../support/cleanup.ts";
import { applyStarterPolicy, guardActivity } from "../../support/guard.ts";
import { isRecord } from "../../support/guards.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";

const MADE_UP_TFN = "123 456 782";
const BLOCKED_SENTENCE = ` My TFN is ${MADE_UP_TFN}, please keep it on file.`;
const LEAK_WINDOW = 16;
const TIMEOUT_MS = 240_000;
const BUILD_TIMEOUT_MS = 600_000;

export interface ProviderSuite {
  readonly provider: Provider;
  readonly serviceId: string;
  readonly allowed: readonly string[];
  readonly blocked: readonly string[];
  readonly exception: string;
}

interface GuardedProvider {
  readonly registry: TestRegistry;
  readonly upstream: FakeUpstream;
  readonly agent: TestAgent;
}

interface Refusal {
  readonly eventId: string;
  readonly ruleId: string;
  readonly body: Record<string, unknown>;
}

const requestFor = (recording: Recording, body: Buffer): AgentRequest => ({
  host: recording.host,
  method: recording.request.method,
  path: recording.request.path,
  headers: recording.request.headers,
  body,
});

const only = <T>(items: readonly T[]): T => {
  expect(items).toHaveLength(1);
  const [item] = items;
  if (item === undefined) throw new Error("expected exactly one item");
  return item;
};

const refusalOf = (response: AgentResponse): Refusal => {
  const text = response.body.toString("utf8");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!isRecord(body) || typeof body.eventId !== "string" || typeof body.ruleId !== "string") {
    throw new Error(`expected a Guard refusal, got ${response.status}: ${text.slice(0, 300)}`);
  }
  return { eventId: body.eventId, ruleId: body.ruleId, body };
};

const expectForwarded = (received: ReceivedRequest, recording: Recording, body: Buffer): void => {
  expect(received.method).toBe(recording.request.method);
  expect(received.path).toBe(recording.request.path);
  expect(received.headers.host?.split(":")[0]).toBe(recording.host);
  for (const [name, value] of Object.entries(recording.request.headers)) expect(received.headers[name], name).toBe(value);
  expect(received.body.toString("utf8")).toBe(body.toString("utf8"));
};

const expectRecordedResponse = (response: AgentResponse, recording: Recording): void => {
  expect(response.status).toBe(recording.response.status);
  expect(response.headers["x-vibtra-guard"]).toBe("allowed");
  for (const [name, value] of Object.entries(recording.response.headers)) expect(response.headers[name], name).toBe(value);
  expect(response.body.toString("utf8")).toBe(Buffer.concat(responseFrames(recording)).toString("utf8"));
};

const stringLeaves = (value: unknown): string[] => {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  return isRecord(value) ? Object.values(value).flatMap(stringLeaves) : [];
};

const bodyTexts = (body: Buffer): string[] => stringLeaves(JSON.parse(body.toString("utf8"))).filter((text) => text.length >= LEAK_WINDOW);

const expectNoBodyText = (records: readonly string[], body: Buffer): void => {
  const fragments = bodyTexts(body).flatMap((text) =>
    Array.from({ length: Math.max(0, text.length - LEAK_WINDOW + 1) }, (_, start) => text.slice(start, start + LEAK_WINDOW)),
  );
  for (const record of records) {
    expect(fragments.filter((fragment) => record.includes(fragment))).toEqual([]);
    expect(record).not.toContain(MADE_UP_TFN);
    expect(record).not.toContain(MADE_UP_TFN.replaceAll(" ", ""));
  }
};

export const describeProvider = (suite: ProviderSuite): void => {
  describe(`${suite.provider} through the Go agent`, () => {
    const cleanup = createCleanup();
    let binary: AgentBinary | undefined;
    beforeAll(async () => {
      binary = await buildAgent();
    }, BUILD_TIMEOUT_MS);
    afterAll(() => binary?.close());
    afterEach(() => cleanup.run());

    const startGuarded = async (recordingName: string, holdStream: boolean): Promise<GuardedProvider> => {
      if (binary === undefined) throw new Error("the agent binary was not built");
      const registry = await startRegistry();
      cleanup.defer(registry.close);
      await applyStarterPolicy(registry);
      const upstream = await startFakeUpstream({ provider: suite.provider, recording: recordingName, holdStream });
      cleanup.defer(upstream.close);
      const agent = await startAgent({ registry, upstreamMap: { [upstream.host]: upstream.url }, binary: binary.path });
      cleanup.defer(agent.close);
      return { registry, upstream, agent };
    };

    it.each(suite.allowed)(
      "forwards an allowed %s request and returns the recorded response unchanged",
      async (name) => {
        const recording = await loadRecording(suite.provider, name);
        const streamed = recording.response.events !== undefined;
        const { registry, upstream, agent } = await startGuarded(name, streamed);
        const body = recordedRequestBody(recording);
        const [firstFrame] = responseFrames(recording);

        const response = await requestThroughAgent(agent, {
          ...requestFor(recording, body),
          onData: (received) => {
            if (firstFrame !== undefined && received.length >= firstFrame.length) upstream.releaseStream();
          },
        });

        expectRecordedResponse(response, recording);
        expectForwarded(only(upstream.received), recording, body);
        expect(only(upstream.sent).releasedByClient).toBe(streamed);
        const local = await agent.activity();
        expect(local.events.filter((event) => event.action === "allowed" && event.serviceId === suite.serviceId)).toHaveLength(1);
        await agent.sync();
        const uploaded = await guardActivity(registry, agent.deviceId);
        expect(uploaded.rows.some((row) => row.action === "allowed" && row.serviceId === suite.serviceId)).toBe(true);
        expectNoBodyText([local.text, uploaded.text], body);
      },
      TIMEOUT_MS,
    );

    it.each(suite.blocked)(
      "refuses a %s request that carries a made-up TFN before it reaches the upstream",
      async (name) => {
        const recording = await loadRecording(suite.provider, name);
        const { registry, upstream, agent } = await startGuarded(name, false);
        const prompt = `${recording.request.prompt}${BLOCKED_SENTENCE}`;

        const body = recordedRequestBody(recording, prompt);
        const response = await requestThroughAgent(agent, requestFor(recording, body));

        expect(response.status).toBe(403);
        const refusal = refusalOf(response);
        expect(refusal.body).toMatchObject({
          code: "GUARD_BLOCKED",
          action: "block",
          service: suite.serviceId,
          policy: { decision: "deny", reasons: [{ code: "GUARD_CONTENT_BLOCKED" }] },
        });
        expect(response.headers["x-vibtra-guard"]).toBe(`blocked; event=${refusal.eventId}`);
        expect(upstream.received).toEqual([]);
        const local = await agent.activity();
        expect(local.events.find((event) => event.eventId === refusal.eventId)).toMatchObject({
          action: "blocked",
          kind: "content",
          matchType: "au-tfn",
          serviceId: suite.serviceId,
          ruleId: refusal.ruleId,
        });
        await agent.sync();
        const uploaded = await guardActivity(registry, agent.deviceId);
        expect(uploaded.rows.find((row) => row.eventId === refusal.eventId)).toMatchObject({
          action: "blocked",
          matchType: "au-tfn",
          serviceId: suite.serviceId,
          ruleId: refusal.ruleId,
        });
        expectNoBodyText([local.text, uploaded.text], body);
      },
      TIMEOUT_MS,
    );

    it(
      `lets a refused ${suite.exception} request through once an admin approves the person's exception request`,
      async () => {
        const recording = await loadRecording(suite.provider, suite.exception);
        const { registry, upstream, agent } = await startGuarded(suite.exception, false);
        const prompt = `${recording.request.prompt}${BLOCKED_SENTENCE}`;
        const body = recordedRequestBody(recording, prompt);

        const refused = await requestThroughAgent(agent, requestFor(recording, body));
        expect(refused.status).toBe(403);
        const refusal = refusalOf(refused);
        expect(upstream.received).toEqual([]);

        const requestId = await agent.requestException(refusal.eventId, "Made-up reason: the tax note belongs to a fictional training example.");
        const approved = await registry.consoleWrite(registry.people.admin, "POST", `/policy-requests/${requestId}/approve`, { grant: { days: 1 } });
        expect(approved.status, approved.text).toBe(200);
        await agent.waitForException(refusal.eventId);

        const retried = await requestThroughAgent(agent, requestFor(recording, body));

        expectRecordedResponse(retried, recording);
        expectForwarded(only(upstream.received), recording, body);
        const local = await agent.activity();
        expect(local.events.find((event) => event.eventId === refusal.eventId)).toMatchObject({ action: "blocked", matchType: "au-tfn" });
        expect(local.events.find((event) => event.action === "allowed")).toMatchObject({
          kind: "content",
          matchType: "au-tfn",
          ruleId: refusal.ruleId,
          serviceId: suite.serviceId,
        });
        await agent.sync();
        const uploaded = await guardActivity(registry, agent.deviceId);
        expect(uploaded.rows.find((row) => row.eventId === refusal.eventId)).toMatchObject({ action: "blocked" });
        expect(uploaded.rows.find((row) => row.action === "requested")).toMatchObject({ requestId, serviceId: suite.serviceId });
        expect(uploaded.rows.find((row) => row.action === "allowed")).toMatchObject({ matchType: "au-tfn", ruleId: refusal.ruleId });
        expectNoBodyText([local.text, uploaded.text], body);
      },
      TIMEOUT_MS,
    );
  });
};
