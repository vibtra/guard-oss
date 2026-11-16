import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import { GUARD_API_PREFIX, GUARD_PROTOCOL_VERSION } from "@vibtra/guard-contract";
import { toVibtraError } from "@vibtra/registry/src/errors.ts";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, eventId, preflightBody } from "./guard-device.ts";

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = "made-up-secret-fragment";

let registry: TestRegistry;
const written: string[] = [];

const lines = (): Record<string, unknown>[] =>
  written.flatMap((chunk) => chunk.split("\n")).filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as Record<string, unknown>);
const completion = (requestId: string | null): Record<string, unknown> | undefined => lines().find((line) => line.msg === "request" && line.request_id === requestId);
const settled = async (requestId: string | null): Promise<Record<string, unknown>> => {
  for (let i = 0; i < 50; i += 1) {
    const line = completion(requestId);
    if (line !== undefined) return line;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no completion line for ${requestId}`);
};

beforeAll(async () => {
  registry = await startRegistry({
    domain: "telemetry.example",
    configure: (options) => ({ ...options, logger: { stream: { write: (line: string) => void written.push(line) }, level: "debug" } }),
  });
});

afterAll(async () => {
  await registry?.close();
});

describe("registry request telemetry", () => {
  it("adopts a safe incoming x-request-id, echoes it, and mints a UUIDv7 for an unsafe one", async () => {
    const adopted = await fetch(`${registry.url}/healthz`, { headers: { "x-request-id": "client-trace-0001" } });
    expect(adopted.headers.get("x-request-id")).toBe("client-trace-0001");
    expect(await settled("client-trace-0001")).toMatchObject({ route: "/healthz", status: 200, method: "GET" });

    const minted = await fetch(`${registry.url}/healthz`, { headers: { "x-request-id": "no spaces allowed here" } });
    expect(minted.headers.get("x-request-id")).toMatch(UUID_V7);
    const plain = await fetch(`${registry.url}/healthz`);
    expect(plain.headers.get("x-request-id")).toMatch(UUID_V7);
    expect(plain.headers.get("x-request-id")).not.toBe(minted.headers.get("x-request-id"));
  });

  it("puts the request id in traceId on error bodies and in the header on every refusal", async () => {
    for (const [path, init] of [
      [`${GUARD_API_PREFIX}/preflight/gdev_unknown`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
      [`${CONSOLE_API_PREFIX}/guard/overview`, {}],
      [`${GUARD_API_PREFIX}/no-such-door?token=abc`, {}],
    ] as const) {
      const reply = await fetch(`${registry.url}${path}`, init);
      expect(reply.status, path).toBeGreaterThanOrEqual(400);
      const body = (await reply.json()) as { traceId?: unknown };
      expect(body.traceId, path).toBe(reply.headers.get("x-request-id"));
    }
    const boundary = await fetch(`${registry.url}/not/part/of/guard`);
    expect([boundary.status, boundary.headers.get("x-request-id")]).toEqual([404, expect.stringMatching(UUID_V7)]);
    const refused = lines().find((line) => line.msg === "guard request refused");
    expect(refused).toMatchObject({ code: "GUARD_TOKEN_INVALID", status: 401 });
    expect(JSON.stringify(lines())).not.toContain("token=abc");
  });

  it("answers an unreadable body with a generic 500 that carries no internal message, and logs the cause once", async () => {
    const reply = await fetch(`${registry.url}${GUARD_API_PREFIX}/enrol`, { method: "POST", headers: { "content-type": "application/json" }, body: `{"${SECRET}": ` });
    const text = await reply.text();
    expect(reply.status).toBe(500);
    expect(JSON.parse(text)).toEqual({ code: "INTERNAL", message: "Something went wrong", traceId: reply.headers.get("x-request-id") });
    expect(text).not.toContain(SECRET);
    const traceId = reply.headers.get("x-request-id");
    expect(lines().filter((line) => line.request_id === traceId && line.level === 50)).toHaveLength(1);

    const wrapped = toVibtraError(new Error(`could not parse ${SECRET}`), "VALIDATION").toJSON();
    expect(JSON.stringify(wrapped)).not.toContain(SECRET);
    expect(toVibtraError(new Error(SECRET)).cause).toBeInstanceOf(Error);
  });

  it("writes one completion line per Guard sync call with the route pattern, org and device, plus decision lines", async () => {
    const { owner, member } = registry.people;
    const laptop = await enrolDevice(registry, owner, member, "member-telemetry");
    const before = written.length;
    const reply = await fetch(`${registry.url}${GUARD_API_PREFIX}/preflight/${laptop.deviceId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${laptop.token}`, "content-type": "application/json" },
      body: JSON.stringify(preflightBody("member-telemetry")),
    });
    expect(reply.status).toBe(200);
    const line = await settled(reply.headers.get("x-request-id"));
    expect(line).toMatchObject({ level: 30, route: `${GUARD_API_PREFIX}/preflight/:deviceId`, status: 200, org_id: laptop.enrol.orgId, device_id: laptop.deviceId });
    expect(typeof line.duration_ms).toBe("number");
    expect(typeof line.bytes).toBe("number");
    expect(lines().filter((l) => l.msg === "request" && l.request_id === line.request_id)).toHaveLength(1);
    expect(lines().find((l) => l.msg === "guard preflight" && l.request_id === line.request_id)).toMatchObject({ level: 30, rules_changed: true });
    expect(lines().some((l) => l.msg === "step" && l.step === "authenticate" && l.request_id === line.request_id)).toBe(true);

    const upload = await agentDoor(registry, "POST", `/eventupload/${laptop.deviceId}`, laptop.token, {
      protocol: GUARD_PROTOCOL_VERSION,
      events: [{ eventId: eventId(), occurredAt: new Date().toISOString(), kind: "content", action: "blocked", serviceId: "openai-chatgpt", ruleId: "gcr_00000000000000a1", snippet: `au-tfn ${SECRET}` }],
    });
    expect(upload.status, upload.text).toBe(200);
    const decision = lines().find((l) => l.msg === "guard eventupload");
    expect(decision).toMatchObject({ accepted: 1, rejected: 0, actions: { blocked: 1 }, rule_ids: ["gcr_00000000000000a1"] });

    const logged = written.slice(before).join("");
    for (const secret of [laptop.token, SECRET, member.email]) expect(logged).not.toContain(secret);
  });
});
