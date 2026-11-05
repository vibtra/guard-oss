import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { digestOf } from "@vibtra/guard-contract/signing";
import { describe, expect, it } from "vitest";
import {
  bundleDocument,
  catalogueDocument,
  connectFrame,
  contentRule,
  createProfile,
  createSigner,
  encodeBody,
  jsonLines,
  protoField,
  protoNumber,
  runAgentCommand,
  webSocketDeflate,
  webSocketFrame,
  type AgentProfile,
  type Json,
} from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();

const CHAT_CATALOGUE = (version: string): Json => catalogueDocument({ version, services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] });
const TFN = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });

const scanProfile = async (changes: Json = {}, catalogueVersion = "v1"): Promise<AgentProfile> => {
  const signer = createSigner();
  return createProfile(suite.cleanup, { signer, bundle: bundleDocument(signer, { catalogueVersion: "v1", contentRules: [TFN], ...changes }), catalogue: CHAT_CATALOGUE(catalogueVersion) });
};

const scanRaw = (profile: AgentProfile, rows: readonly Json[]) =>
  runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: rows.map((row) => JSON.stringify(row)).join("\n") + "\n" });

const scan = async (profile: AgentProfile, rows: readonly Json[]): Promise<Json[]> => {
  const result = await scanRaw(profile, rows);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const out = jsonLines(result.stdout);
  expect(out).toHaveLength(rows.length);
  return out;
};

const matchesOf = (row: Json): Json[] => (Array.isArray(row.matches) ? row.matches.map(record) : []);
const inspection = (row: Json): Json => record(row.inspection);
const base64 = (bytes: Buffer): string => bytes.toString("base64");

const connectTurn = (text: string): Buffer =>
  Buffer.concat([protoField(1, "550e8400-e29b-41d4-a716-446655440000"), protoField(3, protoField(2, protoField(1, text))), protoNumber(4, 4111111111111111n)]);

describe("policy-scan checks the signed policy before it answers", () => {
  it("refuses a tampered bundle and a signed pair whose versions differ, with no output", async () => {
    const tampered = await scanProfile();
    const file = path.join(tampered.dataDir, "bundle.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"enforce"', '"monitor"'));
    const mismatched = await scanProfile({}, "v2");
    for (const [profile, expected] of [
      [tampered, "did not verify"],
      [mismatched, "policy/catalogue changed"],
    ] as const) {
      const result = await scanRaw(profile, [{}]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(expected);
      expect(result.stdout).toBe("");
    }
  });

  it("reports a declared encoding it cannot decode as a coverage block, and leaves the profile untouched", async () => {
    const profile = await scanProfile();
    const names = (await readdir(profile.dataDir)).sort();
    const before = await Promise.all(names.map((name) => readFile(path.join(profile.dataDir, name))));
    const rows = await scan(
      profile,
      ["identity", "gzip"].map((encoding) => ({ id: encoding, host: "chatgpt.com", contentType: "application/json", contentEncoding: encoding, body: '{"prompt":"TFN 123 456 782"}' })),
    );
    expect(rows.map((row) => [row.verdict, row.inspectable, matchesOf(row).length])).toEqual([
      ["blocked", true, 1],
      ["blocked", false, 0],
    ]);
    const bundle = record(JSON.parse(await readFile(path.join(profile.dataDir, "bundle.json"), "utf8")));
    const catalogue = record(JSON.parse(await readFile(path.join(profile.dataDir, "catalogue.json"), "utf8")));
    for (const row of rows) {
      expect(row.bundleDigest).toBe(digestOf(bundle.bundle));
      expect(row.catalogueDigest).toBe(digestOf(catalogue.catalogue));
    }
    expect((await readdir(profile.dataDir)).sort()).toEqual(names);
    const after = await Promise.all(names.map((name) => readFile(path.join(profile.dataDir, name))));
    after.forEach((content, index) => expect(content.equals(before[index] ?? Buffer.alloc(0)), names[index]).toBe(true));
  });

  it("reports service and content grants so they do not count as gating", async () => {
    const profile = await scanProfile({
      services: { chat: { action: "block" } },
      exceptions: [
        { grantId: "service-grant", serviceId: "chat", scope: "service" },
        { grantId: "content-grant", serviceId: "chat", ruleId: TFN.ruleId, scope: "content" },
      ],
    });
    const [row] = await scan(profile, [{ id: "granted", host: "chatgpt.com", contentType: "application/json", body: '{"prompt":"TFN 123 456 782"}' }]);
    expect(row?.verdict).toBe("allowed");
    expect(row?.flowAction).toBe("allow");
    expect(row?.gatingKinds).toEqual([]);
    expect(row === undefined ? [] : matchesOf(row).map((match) => match.excepted)).toEqual([true]);
  });

  it("decides compressed HTTP bodies the same way the proxy does", async () => {
    const profile = await scanProfile();
    const rows = await scan(profile, [
      { id: "zstd", host: "chatgpt.com", contentType: "application/json", contentEncoding: "zstd", bodyBase64: base64(encodeBody("zstd", Buffer.from('{"input":"TFN 123 456 782"}'))) },
      { id: "unknown", host: "chatgpt.com", contentType: "application/json", contentEncoding: "unknown", bodyBase64: base64(Buffer.from("opaque")) },
    ]);
    for (const row of rows) expect([row.id, row.verdict, row.enforced]).toEqual([row.id, "blocked", true]);
    expect(matchesOf(rows[0] ?? {}).map((match) => match.kind)).toEqual(["au-tfn"]);
  });

  it("extracts Connect and WebSocket bodies the same way the proxy does", async () => {
    const profile = await scanProfile();
    const wire = webSocketFrame(1, (await webSocketDeflate(['{"message":"TFN 123 456 782"}']))[0] ?? Buffer.alloc(0), { compressed: true });
    const [connect, socket] = await scan(profile, [
      { id: "native-rpc", host: "chatgpt.com", contentType: "application/connect+proto", bodyBase64: base64(connectFrame(0, protoField(1, "TFN 123 456 782"))) },
      { id: "ws", host: "chatgpt.com", transport: "websocket", websocketExtensions: "permessage-deflate", bodyBase64: base64(wire) },
    ]);
    expect([connect?.verdict, connect?.inspectable, connect && inspection(connect).format]).toEqual(["blocked", true, "connect-protobuf"]);
    expect([socket?.verdict, socket?.inspectable, socket && inspection(socket).transport]).toEqual(["blocked", true, "websocket-message"]);
  });
});

describe("Connect and protobuf bodies", () => {
  const rules = [
    contentRule("gcr_00000000000000c1", { kind: "card-number", requireContext: true }),
    contentRule("gcr_00000000000000c2", { kind: "secret", requireContext: true }),
    contentRule("gcr_00000000000000c3", { kind: "au-medicare", requireContext: true }),
  ];
  const kindsOf = (row: Json): unknown[] => matchesOf(row).map((match) => [match.kind, match.count]);

  it("reads text fields of a SubmitTurn-shaped message and never numeric fields", async () => {
    const profile = await scanProfile({ contentRules: rules });
    const cases: [string, string, unknown[]][] = [
      ["card", "Use card 4111111111111111", [["card-number", 1]]],
      ["key", "-----BEGIN PRIVATE KEY-----\nsynthetic\n-----END PRIVATE KEY-----", [["secret", 1]]],
      ["benign", "Please summarize this note", []],
      ["medicare", "Medicare 2123456701", [["au-medicare", 1]]],
    ];
    const rows = await scan(
      profile,
      cases.map(([id, text]) => ({ id, host: "chatgpt.com", contentType: "application/connect+proto", bodyBase64: base64(connectFrame(0, connectTurn(text))) })),
    );
    rows.forEach((row, index) => {
      const [id, , expected] = cases[index] ?? [];
      expect(kindsOf(row), id).toEqual(expected);
      expect([inspection(row).frames, inspection(row).textParts], id).toEqual([1, 2]);
    });
  });

  it("decodes gzip and brotli at the Connect frame and the HTTP layer, for protobuf and JSON", async () => {
    const profile = await scanProfile({ contentRules: rules });
    const proto = connectTurn("Card 4111111111111111");
    const json = Buffer.from('{"messages":[{"content":"Card 4111111111111111"}]}');
    const rows: Json[] = [];
    for (const coding of ["gzip", "br"] as const) {
      rows.push(
        { id: `${coding}/frame`, contentType: "application/connect+proto", connectContentEncoding: coding, bodyBase64: base64(connectFrame(1, encodeBody(coding, proto))) },
        { id: `${coding}/http-framed`, contentType: "application/connect+proto", contentEncoding: coding, bodyBase64: base64(encodeBody(coding, connectFrame(0, proto))) },
        { id: `${coding}/http-proto`, contentType: "application/proto", contentEncoding: coding, bodyBase64: base64(encodeBody(coding, proto)) },
        { id: `${coding}/frame-json`, contentType: "application/connect+json", connectContentEncoding: coding, bodyBase64: base64(connectFrame(1, encodeBody(coding, json))) },
      );
    }
    const out = await scan(
      profile,
      rows.map((row) => ({ ...row, host: "chatgpt.com" })),
    );
    for (const row of out) expect(kindsOf(row), String(row.id)).toEqual([["card-number", 1]]);
  });

  it("keeps fields apart and reports opaque bytes as partial coverage", async () => {
    const profile = await scanProfile({ contentRules: rules });
    const [opaque, split] = await scan(profile, [
      { id: "opaque", host: "chatgpt.com", contentType: "application/proto", bodyBase64: base64(Buffer.concat([protoField(1, "Medicare"), protoField(2, "2123456701"), protoField(3, Buffer.from([0xff, 0xfe, 0xfd]))])) },
      { id: "split", host: "chatgpt.com", contentType: "application/connect+proto", bodyBase64: base64(connectFrame(0, Buffer.concat([protoField(1, "Card 41111111"), protoField(2, "11111111")]))) },
    ]);
    expect(opaque && [inspection(opaque).state, inspection(opaque).opaqueFields, inspection(opaque).textParts]).toEqual(["partial", 1, 2]);
    expect(opaque && kindsOf(opaque)).toEqual([]);
    expect(split && kindsOf(split)).toEqual([]);
  });

  it("never reports a malformed or unsupported body as inspected", async () => {
    const profile = await scanProfile({ contentRules: rules });
    const cases: Json[] = [
      { id: "truncated header", contentType: "application/connect+proto", bytes: Buffer.from([0, 0]) },
      { id: "truncated frame", contentType: "application/connect+proto", bytes: Buffer.from([0, 0, 0, 0, 100]) },
      { id: "reserved flag", contentType: "application/connect+proto", bytes: connectFrame(4, Buffer.alloc(0)) },
      { id: "request end stream", contentType: "application/connect+proto", bytes: connectFrame(2, Buffer.from("{}")) },
      { id: "compression missing", contentType: "application/connect+proto", bytes: connectFrame(1, Buffer.from([1])) },
      { id: "unknown compression", contentType: "application/connect+proto", connectContentEncoding: "zstd", bytes: connectFrame(1, Buffer.from([1])) },
      { id: "broken gzip", contentType: "application/connect+proto", connectContentEncoding: "gzip", bytes: connectFrame(1, Buffer.from([1])) },
      { id: "bad protobuf tag", contentType: "application/proto", bytes: Buffer.from([0]) },
      { id: "invalid wire type", contentType: "application/proto", bytes: Buffer.from([15]) },
      { id: "truncated fixed", contentType: "application/proto", bytes: Buffer.from([9, 1]) },
      { id: "invalid JSON", contentType: "application/connect+json", bytes: connectFrame(0, Buffer.from('{"prompt":')) },
      { id: "undecodable HTTP encoding", contentType: "application/proto", contentEncoding: "zstd", bytes: Buffer.from([8, 1]) },
    ];
    const rows = await scan(
      profile,
      cases.map(({ bytes, ...row }) => ({ ...row, host: "chatgpt.com", bodyBase64: base64(Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0)) })),
    );
    for (const row of rows) {
      expect([inspection(row).state, inspection(row).coverageFailure, row.inspectable, row.verdict], String(row.id)).toEqual(["flow-only", true, false, "blocked"]);
      expect(inspection(row).textParts, String(row.id)).toBe(0);
    }
  });

  it("stops at the decoded size, frame count and nesting depth bounds", async () => {
    const profile = await scanProfile({ contentRules: rules });
    let deep = protoField(1, "hello".repeat(10));
    for (let depth = 0; depth < 34; depth += 1) deep = protoField(1, deep);
    const rows = await scan(profile, [
      { id: "bomb", contentType: "application/connect+proto", connectContentEncoding: "gzip", bodyBase64: base64(connectFrame(1, encodeBody("gzip", Buffer.alloc(4 * 1024 * 1024 + 1, "x")))) },
      { id: "frames", contentType: "application/connect+proto", bodyBase64: base64(Buffer.concat(Array.from({ length: 257 }, () => connectFrame(0, Buffer.from([8, 1]))))) },
      { id: "depth", contentType: "application/proto", bodyBase64: base64(deep) },
    ].map((row) => ({ ...row, host: "chatgpt.com" })));
    expect(rows.map((row) => [inspection(row).state, inspection(row).reason])).toEqual([
      ["flow-only", "decoded-body-too-large"],
      ["flow-only", "connect-frame-limit"],
      ["flow-only", "protobuf-depth-limit"],
    ]);
  });

  it("answers every arbitrary Connect or WebSocket body with one row and never crashes", async () => {
    const profile = await scanProfile({ contentRules: rules });
    let seed = 0x2545f491;
    const random = (): number => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return seed >>> 0;
    };
    const bodies = [Buffer.from([0, 0, 0, 0, 2, 8, 1]), Buffer.from([255]), connectFrame(0, connectTurn("hello")), webSocketFrame(1, '{"message":"hello"}'), webSocketFrame(1, "partial", { fin: false }), Buffer.from([0x81, 0xff, 0xff, 0xff])];
    for (let index = 0; index < 400; index += 1) bodies.push(Buffer.from(Array.from({ length: random() % 64 }, () => random() & 0xff)));
    const rows = bodies.flatMap((body, index) => [
      { id: `connect/${index}`, host: "chatgpt.com", contentType: "application/connect+proto", bodyBase64: base64(body) },
      { id: `ws/${index}`, host: "chatgpt.com", transport: "websocket", websocketExtensions: "permessage-deflate", bodyBase64: base64(body) },
    ]);
    const out = await scan(profile, rows);
    expect(out.map((row) => row.id)).toEqual(rows.map((row) => row.id));
  });
});
