import { describe, expect, it } from "vitest";
import { GUARD_SNIPPET_MAX, GuardAskBody, GuardAskSubject, GuardEvent, GuardEventRow, redactMatch } from "@vibtra/guard-contract";
import { bannedFields, declaredFields } from "./support.js";

const event = {
  eventId: "gev_0123456789abcdef",
  occurredAt: "2026-10-17T00:00:00.000Z",
  kind: "content",
  action: "blocked",
  serviceId: "chatgpt",
  host: "chatgpt.com",
  port: 443,
  method: "POST",
  pathHint: "/backend-api",
  app: { bundleId: "com.google.Chrome", name: "Google Chrome", cli: "claude", pid: 42 },
  ruleId: "gcr_0123abcd",
  ruleKind: "content",
  matchType: "au-tfn",
  matchCount: 1,
  snippet: "TFN 123***782",
  bytes: 512,
  requestId: "gsr_0123abcd",
  bundleVersion: 3,
} as const;

const subject = { serviceId: "chatgpt", deviceId: "gdev_0123456789abcdef", ruleId: "gcr_0123abcd", matchType: "au-tfn", app: "Google Chrome" } as const;

describe("GuardEvent: the event is metadata, never content", () => {
  it("parses the full metadata row unchanged", () => {
    expect(GuardEvent.parse(event)).toEqual(event);
  });

  it("parses the minimal agent event, every optional field absent", () => {
    const minimal = { eventId: event.eventId, occurredAt: event.occurredAt, kind: "agent", action: "observed", reason: "started" };
    expect(GuardEvent.parse(minimal)).toEqual(minimal);
  });

  it("parses a content event that carries only its match facts, with no host and no service", () => {
    const facts = { eventId: event.eventId, occurredAt: event.occurredAt, kind: "content", action: "blocked", pathHint: "/backend-api", snippet: "TFN 123***782", matchType: "au-tfn", matchCount: 1 };
    expect(GuardEvent.parse(facts)).toEqual(facts);
  });

  it.each(["body", "url", "query", "prompt", "content", "headers", "path"])("refuses a top-level %s key", (key) => {
    expect(GuardEvent.safeParse({ ...event, [key]: "anything" }).success).toBe(false);
  });

  it.each(["path", "argv", "cwd"])("refuses app.%s: a CLI is its basename only, never a path", (key) => {
    expect(GuardEvent.safeParse({ ...event, app: { ...event.app, [key]: "/Users/ada/bin/claude" } }).success).toBe(false);
  });

  it("bounds pathHint at 40 characters, the first segment and not a URL", () => {
    expect(GuardEvent.safeParse({ ...event, pathHint: `/${"a".repeat(39)}` }).success).toBe(true);
    expect(GuardEvent.safeParse({ ...event, pathHint: `/${"a".repeat(40)}` }).success).toBe(false);
  });

  it("carries what a Monitor event would have done: blocked or asked, nothing else", () => {
    const observed = { ...event, action: "observed" } as const;
    for (const wouldAction of ["blocked", "asked"] as const) expect(GuardEvent.parse({ ...observed, wouldAction })).toEqual({ ...observed, wouldAction });
    for (const wouldAction of ["allowed", "observed", ""]) expect(GuardEvent.safeParse({ ...observed, wouldAction }).success, wouldAction).toBe(false);
  });

  it(`bounds the snippet at GUARD_SNIPPET_MAX (${GUARD_SNIPPET_MAX}) characters`, () => {
    expect(GuardEvent.safeParse({ ...event, snippet: "x".repeat(GUARD_SNIPPET_MAX) }).success).toBe(true);
    expect(GuardEvent.safeParse({ ...event, snippet: "x".repeat(GUARD_SNIPPET_MAX + 1) }).success).toBe(false);
  });

  it.each([
    { eventId: "gev_XYZ" },
    { kind: "prompt" },
    { action: "uploaded" },
    { port: 0 },
    { port: 65_536 },
    { method: "post" },
    { ruleKind: "other" },
    { matchType: "not-a-detector" },
    { matchCount: -1 },
    { bytes: 1.5 },
    { serviceId: "Has Spaces" },
    { reason: "r".repeat(61) },
  ])("refuses %j: ids, enums and numbers stay inside their grammars", (bad) => {
    expect(GuardEvent.safeParse({ ...event, ...bad }).success).toBe(false);
  });

  it("the console row adds the registry's facts and is strict too", () => {
    const row = { ...event, deviceId: "gdev_0123456789abcdef", person: { userId: "u1", email: "ada@fernwood.example" }, receivedAt: event.occurredAt };
    expect(GuardEventRow.parse(row)).toEqual(row);
    expect(GuardEventRow.safeParse({ ...row, body: "x" }).success).toBe(false);
    expect(GuardEventRow.safeParse({ ...row, person: { ...row.person, password: "x" } }).success).toBe(false);
  });

  it("declares no field a body, a prompt or a URL query could travel in, at any depth", () => {
    expect(declaredFields(GuardEvent).map((f) => f.path)).toEqual(expect.arrayContaining(["app.cli", "snippet", "pathHint"]));
    expect(bannedFields(GuardEvent)).toEqual([]);
    expect(bannedFields(GuardEventRow)).toEqual([]);
    expect(bannedFields(GuardEventRow.extend({ requestBody: GuardEventRow.shape.host }))).toEqual(["requestBody"]);
  });
});

describe("GuardAskSubject and GuardAskBody: the ask carries facts, never the person's text", () => {
  it("the subject parses the facts the desk shows, and declares no content field", () => {
    expect(GuardAskSubject.parse(subject)).toEqual(subject);
    expect(bannedFields(GuardAskSubject)).toEqual([]);
  });

  it.each(["text", "body", "prompt", "url", "snippet"])("the subject refuses a %s key", (key) => {
    expect(GuardAskSubject.safeParse({ ...subject, [key]: "anything" }).success).toBe(false);
  });

  it("the agent's ask body carries a note of at most 280 characters and nothing else", () => {
    expect(GuardAskBody.safeParse({ serviceId: "openai-chatgpt", ruleId: "gcr_00000001", note: "I need it for the audit" }).success).toBe(true);
    expect(GuardAskBody.safeParse({ serviceId: "chatgpt", note: "n".repeat(280) }).success).toBe(true);
    expect(GuardAskBody.safeParse({ serviceId: "chatgpt", note: "n".repeat(281) }).success).toBe(false);
    expect(GuardAskBody.safeParse({ serviceId: "chatgpt", text: "the pasted content" }).success).toBe(false);
  });
});

describe("redactMatch: the snippet keeps three and three", () => {
  it.each([
    ["123456782", "123***782"],
    ["123 456 782", "123***782"],
    ["123-456-782", "123***782"],
    ["1234567", "123*567"],
    ["123456", "******"],
    ["", ""],
  ])("%j → %j", (value, redacted) => {
    expect(redactMatch(value)).toBe(redacted);
  });
});
