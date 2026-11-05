import { describe, expect, it } from "vitest";
import { VibtraError } from "@vibtra/registry/src/errors.ts";
import {
  REGISTRY_SCHEMA_VERSION,
  RegistryActor,
  RegistryReceiptRecorded,
  RegistryRecord,
  RegistryToolDeployed,
  parseRegistryLine,
  parseRegistryRecord,
  serializeRegistryRecord,
} from "@vibtra/registry/src/records/ledger.ts";
import type { RegistryRecordType } from "@vibtra/registry/src/records/ledger.ts";
import * as ledger from "@vibtra/registry/src/records/ledger.ts";

type RecordOf<K extends RegistryRecordType> = Extract<RegistryRecord, { type: K }>;

const envelope = {
  schemaVersion: REGISTRY_SCHEMA_VERSION,
  recordedAt: "2026-08-24T03:00:00.000Z",
  orgId: "org-example",
  actor: { email: "ada@example.test", idp: "stub" as const },
  source: "client" as const,
  traceId: "trace-example",
};

const onTool = { ...envelope, toolId: "tool-revenue" };

const samples: { [K in RegistryRecordType]: RecordOf<K> } = {
  "tool.created": { ...onTool, recordId: "rec-created", type: "tool.created", name: "Revenue Dashboard", template: "dashboard" },
  "tool.renamed": {
    ...onTool,
    recordId: "rec-renamed",
    type: "tool.renamed",
    name: "Revenue Overview",
    previousName: "Revenue Dashboard",
  },
  "tool.deployed": {
    ...onTool,
    recordId: "rec-deployed",
    type: "tool.deployed",
    deployId: "dep-1",
    outcome: "LIVE",
    url: "https://revenue.example.test",
    target: "fake-intake",
    audience: { kind: "people", subjects: ["bo@example.test"] },
    connections: ["HR database"],
    grantId: "grant-1",
  },
  "tool.archived": { ...onTool, recordId: "rec-archived", type: "tool.archived", reason: "superseded by revenue-v2" },
  "tool.reverted": {
    ...onTool,
    recordId: "rec-reverted",
    type: "tool.reverted",
    restorePoint: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    replacedPoint: "8a1f3c0e9b2d4a6c8e0f2b4d6a8c0e2f4b6d8a0c",
    fileCount: 3,
  },
  "tool.accessed": {
    ...onTool,
    recordId: "rec-accessed",
    type: "tool.accessed",
    source: "attested",
    actor: { email: "outsider@example.test", idp: "google" },
    email: "outsider@example.test",
    outcome: "refused",
    reason: "You are not in this tool's audience.",
  },
  "tool.owner_changed": {
    ...onTool,
    recordId: "rec-owner-changed",
    type: "tool.owner_changed",
    source: "attested",
    owner: "bo@example.test",
    previousOwner: "ada@example.test",
    reason: "Ada moved to another team",
  },
  "prompt.blocked": {
    ...onTool,
    recordId: "rec-blocked",
    type: "prompt.blocked",
    verdict: "block",
    providerId: "openrouter",
    piiCounts: { email: 2, creditCard: 1 },
    mode: "build",
  },
  "prompt.warned": {
    ...onTool,
    recordId: "rec-warned",
    type: "prompt.warned",
    verdict: "warn",
    providerId: "mock",
    piiCounts: { tfn: 1 },
    mode: "plan",
  },
  "connector.connected": {
    ...envelope,
    recordId: "rec-conn-added",
    type: "connector.connected",
    provider: "sql",
    connectionId: "conn-reporting",
    scopes: ["db:read"],
  },
  "connector.removed": {
    ...envelope,
    recordId: "rec-conn-removed",
    type: "connector.removed",
    provider: "microsoft-entra",
    connectionId: "conn-entra",
    scopes: ["User.Read.All", "Group.Read.All"],
  },
  "connector.rescoped": {
    ...onTool,
    recordId: "rec-conn-rescoped",
    type: "connector.rescoped",
    provider: "sql",
    connectionId: "conn-reporting",
    scopes: ["db:read"],
    previousScopeKind: "people",
    previousSubjectCount: 3,
    scopeKind: "org",
    subjectCount: 0,
  },
  "policy.refused": {
    ...envelope,
    recordId: "rec-policy",
    type: "policy.refused",
    capability: "vendor-docs",
    rule: "vendor-docs-host-not-allowed",
    policySource: "local",
    subject: "docs.example.com",
  },
  "package.requested": {
    ...onTool,
    recordId: "rec-pkg-requested",
    type: "package.requested",
    packageName: "@example/widgets",
    range: "^1.2.3",
    requestId: "pkg-7f3a",
  },
  "package.allowed": {
    ...onTool,
    recordId: "rec-pkg-allowed",
    type: "package.allowed",
    packageName: "@example/widgets",
    range: "1.2.3",
    requestId: "pkg-7f3a",
  },
  "receipt.recorded": {
    ...onTool,
    recordId: "rec-receipt",
    type: "receipt.recorded",
    receiptId: "rcpt-1",
    deployId: "dep-1",
    outcome: "LIVE",
  },
  "agent.paused": { ...onTool, recordId: "rec-agent-paused", type: "agent.paused", triggers: "vendor", reason: "Double-posting" },
  "agent.resumed": { ...onTool, recordId: "rec-agent-resumed", type: "agent.resumed", triggers: "gate-only" },
  "agent.killed": {
    ...onTool,
    recordId: "rec-agent-killed",
    type: "agent.killed",
    triggers: "unconfirmed",
    leasesRevoked: 2,
    leasesUnconfirmed: 1,
    clientDisabled: true,
    reason: "runaway spend",
  },
  "agent.breaker_reset": { ...onTool, recordId: "rec-agent-breaker", type: "agent.breaker_reset", reason: "upstream fixed" },
  "agent.limits_changed": {
    ...onTool,
    recordId: "rec-agent-limits",
    type: "agent.limits_changed",
    change: "set",
    before: { maxRunsPerDay: 100 },
    after: { maxRunsPerDay: 10, maxActionsPerRun: 5, maxSpendUsdPerDay: 2.5 },
    reason: "quiet the weekend",
  },
};

const roundTrip = (record: RegistryRecord) => parseRegistryLine(serializeRegistryRecord(record));

const writeRefusal = (record: unknown): VibtraError => {
  try {
    serializeRegistryRecord(record as RegistryRecord);
  } catch (error) {
    if (error instanceof VibtraError) return error;
    throw error;
  }
  throw new Error("serializeRegistryRecord wrote a record it must refuse");
};

const shapeKeys = (type: RegistryRecordType): string[] => {
  const option = RegistryRecord.options.find((candidate) => candidate.shape.type.value === type);
  if (option === undefined) throw new Error(`the record union has no ${type}`);
  return Object.keys(option.shape).sort();
};

describe("registry records round-trip through one ledger line", () => {
  for (const [type, record] of Object.entries(samples)) {
    it(`round-trips the ${type} sample through serializeRegistryRecord and parseRegistryLine`, () => {
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    });
  }

  it("round-trips a record whose optional fields are all omitted, adding none", () => {
    const minimal: RegistryRecord = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      recordId: "rec-minimal",
      recordedAt: "2026-08-24T03:00:00.000Z",
      orgId: "org-example",
      toolId: "tool-revenue",
      actor: { email: "ada@example.test", idp: "stub" },
      source: "client",
      type: "tool.archived",
    };
    const line = serializeRegistryRecord(minimal);
    expect(JSON.parse(line)).toEqual(minimal);
    expect(parseRegistryLine(line)).toEqual({ kind: "record", record: minimal });
  });

  it("writes exactly one line when a field value contains a newline", () => {
    const record: RegistryRecord = { ...samples["tool.created"], name: "two\nlines" };
    const line = serializeRegistryRecord(record);
    expect(line).not.toContain("\n");
    expect(parseRegistryLine(line)).toEqual({ kind: "record", record });
  });
});

describe("the reader skips what it cannot read and never throws", () => {
  it("classifies an unknown future record type as unknown and keeps the raw value verbatim", () => {
    const future = {
      ...onTool,
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      recordId: "rec-future",
      type: "tool.transferred",
      newOwner: "ops@example.test",
    };
    expect(parseRegistryLine(JSON.stringify(future))).toEqual({
      kind: "unknown",
      type: "tool.transferred",
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      recordId: "rec-future",
      raw: future,
    });
  });

  it("classifies a known type from a newer revision with an unreadable payload as unknown, not malformed", () => {
    const newer = {
      ...onTool,
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      recordId: "rec-v2",
      type: "tool.deployed",
      deploy: { id: "dep-9", outcome: "LIVE" },
    };
    expect(parseRegistryRecord(newer)).toEqual({
      kind: "unknown",
      type: "tool.deployed",
      schemaVersion: REGISTRY_SCHEMA_VERSION + 1,
      recordId: "rec-v2",
      raw: newer,
    });
  });

  it("accepts an unknown additive field at the current revision and strips it", () => {
    const withExtra = { ...samples["tool.created"], futureField: "ignored" };
    expect(parseRegistryLine(JSON.stringify(withExtra))).toEqual({ kind: "record", record: samples["tool.created"] });
  });

  it("reports a corrupt record at the current revision as malformed and names the missing field", () => {
    const result = parseRegistryRecord({ ...onTool, recordId: "rec-bad", type: "tool.deployed" });
    expect(result.kind).toBe("malformed");
    expect(result.kind === "malformed" ? result.detail : "").toContain("deployId");
  });

  it("reports bad JSON, blank lines and values that are not records as malformed", () => {
    for (const line of ["{not json", "", "   ", '"just a string"', "null", "[]"]) {
      expect(parseRegistryLine(line).kind).toBe("malformed");
    }
    for (const value of [null, undefined, 42, { recordId: "x" }, { ...onTool, recordId: "rec-blank-type", type: "" }]) {
      expect(parseRegistryRecord(value).kind).toBe("malformed");
    }
  });

  it("reads a mixed ledger file line by line, keeping the records and skipping the rest", () => {
    const file = [
      serializeRegistryRecord(samples["tool.created"]),
      serializeRegistryRecord(samples["tool.deployed"]),
      JSON.stringify({ ...onTool, recordId: "rec-from-the-future", schemaVersion: 99, type: "org.plan-changed" }),
      "{corrupt line",
      serializeRegistryRecord(samples["tool.archived"]),
    ].join("\n");
    const results = file.split("\n").map((line) => parseRegistryLine(line));
    expect(results.map((result) => result.kind)).toEqual(["record", "record", "unknown", "malformed", "record"]);
    expect(results.flatMap((result) => (result.kind === "record" ? [result.record.recordId] : []))).toEqual([
      "rec-created",
      "rec-deployed",
      "rec-archived",
    ]);
  });
});

describe("the writer refuses what the reader would have to skip", () => {
  it("refuses an invalid record with a VALIDATION error that names the field", () => {
    const refusal = writeRefusal({ ...samples["tool.created"], name: "" });
    expect(refusal.code).toBe("VALIDATION");
    expect(refusal.detail).toContain("name");
  });
});

describe("the ledger vocabulary", () => {
  it("accepts exactly the twenty-one sampled record types and reads each one back as a record", () => {
    const unionTypes = RegistryRecord.options.map((option) => option.shape.type.value);
    expect(unionTypes).toHaveLength(21);
    expect([...unionTypes].sort()).toEqual(Object.keys(samples).sort());
    for (const type of unionTypes) {
      expect(parseRegistryRecord(samples[type]).kind).toBe("record");
    }
  });

  it("never names a record type after a mutation", () => {
    for (const option of RegistryRecord.options) {
      expect(option.shape.type.value).not.toMatch(/\.(update|edit|patch|rewrite)/i);
    }
  });

  it("exports no registry operation that could update or delete a ledger line", () => {
    const operations = Object.entries(ledger)
      .filter(([name, value]) => typeof value === "function" && /registry/i.test(name))
      .map(([name]) => name);
    expect(operations).toEqual(expect.arrayContaining(["parseRegistryLine", "parseRegistryRecord", "serializeRegistryRecord"]));
    expect(operations.filter((name) => /update|delete|mutate|edit|remove|patch/i.test(name))).toEqual([]);
  });

  it("accepts exactly the five actor identity providers, in their written order", () => {
    expect(RegistryActor.shape.idp.options).toEqual(["google", "okta", "stub", "local", "oidc"]);
    for (const idp of RegistryActor.shape.idp.options) {
      const record: RegistryRecord = { ...samples["tool.created"], actor: { email: "ada@example.test", idp } };
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    }
    expect(writeRefusal({ ...samples["tool.created"], actor: { email: "ada@example.test", idp: "github" } }).code).toBe(
      "VALIDATION",
    );
  });

  it("accepts client and attested as the record source on every type and refuses any other source", () => {
    for (const option of RegistryRecord.options) {
      expect(option.shape.source.options).toEqual(["client", "attested"]);
    }
    for (const source of ["client", "attested"] as const) {
      const record: RegistryRecord = { ...samples["tool.created"], source };
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    }
    expect(writeRefusal({ ...samples["tool.created"], source: "server" }).code).toBe("VALIDATION");
    expect(parseRegistryRecord({ ...samples["tool.created"], source: "server" }).kind).toBe("malformed");
  });

  it("shares one terminal outcome vocabulary between deploy and receipt records", () => {
    expect(RegistryReceiptRecorded.shape.outcome.options).toEqual(["LIVE", "FAILED"]);
    expect(RegistryToolDeployed.shape.outcome.options).toEqual(["LIVE", "FAILED"]);
    for (const outcome of RegistryReceiptRecorded.shape.outcome.options) {
      const record: RegistryRecord = { ...samples["receipt.recorded"], outcome };
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    }
    expect(writeRefusal({ ...samples["receipt.recorded"], outcome: "QUEUED" }).code).toBe("VALIDATION");
  });
});

describe("package records", () => {
  it("drops every registry credential or note field a package record is handed", () => {
    const smuggled = {
      registry: "https://npm.example.test",
      registryUrl: "https://npm.example.test",
      npmrc: "//npm.example.test/:_authToken=sk-test-FAKE-npmrc",
      token: "sk-test-FAKE-token",
      auth: "sk-test-FAKE-auth",
      tarball: "https://npm.example.test/widgets-1.2.3.tgz",
      note: "please allow this",
      resolved: "https://npm.example.test/widgets-1.2.3.tgz",
    };
    for (const record of [samples["package.requested"], samples["package.allowed"]]) {
      const withSmuggled = { ...record, ...smuggled };
      const line = serializeRegistryRecord(withSmuggled);
      expect(JSON.parse(line)).toEqual(record);
      expect(line).not.toContain("npm.example.test");
      expect(line).not.toContain("sk-test-FAKE");
      expect(line).not.toContain("please allow this");
      const keys = shapeKeys(record.type);
      expect(keys).toEqual(expect.arrayContaining(["packageName", "range"]));
      for (const banned of Object.keys(smuggled)) {
        expect(keys).not.toContain(banned);
      }
    }
  });

  it("keeps a package request or allowance that names no tool", () => {
    const requested: RegistryRecord = {
      ...envelope,
      recordId: "rec-pkg-requested-no-tool",
      type: "package.requested",
      packageName: "@example/widgets",
      range: "^1.2.3",
      requestId: "pkg-1",
    };
    const allowed: RegistryRecord = {
      ...envelope,
      recordId: "rec-pkg-allowed-no-tool",
      type: "package.allowed",
      packageName: "@example/widgets",
      range: "1.2.3",
    };
    for (const record of [requested, allowed]) {
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    }
    expect(writeRefusal({ ...envelope, recordId: "rec-created-no-tool", type: "tool.created", name: "Untitled" }).code).toBe(
      "VALIDATION",
    );
  });

  it("stores any npm range spelling exactly as written", () => {
    for (const range of ["4.3.3", "^4.3.3", ">=4 <5", "latest", "npm:alias@1.0.0"]) {
      const record: RegistryRecord = { ...samples["package.requested"], recordId: `rec-range-${range}`, range };
      expect(roundTrip(record)).toEqual({ kind: "record", record });
    }
  });
});

describe("connector.rescoped records", () => {
  it("carries kinds and counts and has no field that could hold a subject", () => {
    expect(shapeKeys("connector.rescoped")).toEqual(
      [
        "schemaVersion",
        "recordId",
        "recordedAt",
        "orgId",
        "toolId",
        "actor",
        "source",
        "traceId",
        "type",
        "provider",
        "connectionId",
        "scopes",
        "scopeKind",
        "subjectCount",
        "previousScopeKind",
        "previousSubjectCount",
      ].sort(),
    );
    const subject = "subject@example.test";
    const withSubjects = {
      ...samples["connector.rescoped"],
      subjects: [subject],
      emails: [subject],
      toolIds: ["tool-other"],
      groupIds: ["group-finance"],
      scopeSubjects: [subject],
    };
    const line = serializeRegistryRecord(withSubjects);
    expect(JSON.parse(line)).toEqual(samples["connector.rescoped"]);
    expect(line).not.toContain(subject);
  });

  it("refuses a negative subject count and accepts zero", () => {
    const zero: RegistryRecord = { ...samples["connector.rescoped"], subjectCount: 0, previousSubjectCount: 0 };
    expect(roundTrip(zero)).toEqual({ kind: "record", record: zero });
    expect(writeRefusal({ ...samples["connector.rescoped"], subjectCount: -1 }).code).toBe("VALIDATION");
    expect(writeRefusal({ ...samples["connector.rescoped"], previousSubjectCount: -1 }).code).toBe("VALIDATION");
    expect(parseRegistryRecord({ ...samples["connector.rescoped"], subjectCount: -1 }).kind).toBe("malformed");
  });

  it("accepts a scope kind this build has never heard of", () => {
    const future: RegistryRecord = {
      ...samples["connector.rescoped"],
      recordId: "rec-future-kind",
      scopeKind: "regions",
      subjectCount: 2,
    };
    expect(roundTrip(future)).toEqual({ kind: "record", record: future });
  });
});

describe("prompt-policy records", () => {
  it("round-trips a prompt record written before any tool exists", () => {
    const record: RegistryRecord = {
      ...envelope,
      recordId: "rec-pretool",
      type: "prompt.blocked",
      verdict: "block",
      providerId: "openrouter",
      piiCounts: { email: 1 },
      mode: "build",
    };
    expect(roundTrip(record)).toEqual({ kind: "record", record });
  });

  it("refuses a verdict that contradicts the record type", () => {
    expect(writeRefusal({ ...samples["prompt.warned"], verdict: "block" }).code).toBe("VALIDATION");
    expect(writeRefusal({ ...samples["prompt.blocked"], verdict: "warn" }).code).toBe("VALIDATION");
  });

  it("refuses a zero count because a detector kind appears only when it fired", () => {
    expect(writeRefusal({ ...samples["prompt.blocked"], piiCounts: { email: 0 } }).code).toBe("VALIDATION");
    expect(writeRefusal({ ...samples["prompt.warned"], piiCounts: { tfn: 1, email: 0 } }).code).toBe("VALIDATION");
  });

  it("accepts detector kinds this build has never heard of", () => {
    const record: RegistryRecord = {
      ...samples["prompt.warned"],
      recordId: "rec-future-detector",
      piiCounts: { "passport-number": 2 },
    };
    expect(roundTrip(record)).toEqual({ kind: "record", record });
  });

  it("accepts plan and build as the mode of both prompt records and refuses any other surface", () => {
    for (const type of ["prompt.blocked", "prompt.warned"] as const) {
      for (const mode of ["plan", "build"] as const) {
        const record: RegistryRecord = { ...samples[type], mode };
        expect(roundTrip(record)).toEqual({ kind: "record", record });
      }
      expect(writeRefusal({ ...samples[type], mode: "chat" }).code).toBe("VALIDATION");
      expect(parseRegistryRecord({ ...samples[type], mode: "chat" }).kind).toBe("malformed");
    }
  });

  it("carries counts by detector kind and no field that could hold prompt content", () => {
    expect(shapeKeys("prompt.blocked")).toEqual(
      [
        "schemaVersion",
        "recordId",
        "recordedAt",
        "orgId",
        "toolId",
        "actor",
        "source",
        "traceId",
        "type",
        "verdict",
        "providerId",
        "piiCounts",
        "mode",
      ].sort(),
    );
    const content = "PROMPT-CONTENT my address is ada@example.com";
    const withContent = {
      ...samples["prompt.blocked"],
      prompt: content,
      text: content,
      detail: content,
      message: content,
      notes: content,
    };
    const line = serializeRegistryRecord(withContent);
    expect(JSON.parse(line)).toEqual(samples["prompt.blocked"]);
    expect(line).not.toContain("PROMPT-CONTENT");
  });
});
