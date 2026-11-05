import { createPrivateKey, sign as nodeSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_SIGNATURE_TYP, GuardEnrolRequest, GuardEnrolResponse, GuardRulesDocument, compileGuardBundle, defaultGuardSettings, emptyGuardRules, seedCatalogue } from "@vibtra/guard-contract";
import { digestOf, generateGuardSigningKey, mintDeviceToken, mintEnrolToken, signGuardBundle, signGuardCatalogue, tokenHashOf, verifyGuardBundle, verifyGuardCatalogue } from "@vibtra/guard-contract/signing";
import { DEVICE_ID, ORG_ID, OTHER_DEVICE_ID, PERSON, buildGoAgent, enrolmentFor, policyScan, scratch, storedDevice, writePolicy, type GoAgent } from "./support.js";

const key = generateGuardSigningKey();
const other = generateGuardSigningKey();
const catalogue = seedCatalogue();
const bundle = compileGuardBundle({
  document: emptyGuardRules(),
  catalogue,
  person: { ...PERSON, groupIds: [] },
  settings: defaultGuardSettings(),
  grants: [],
  orgId: ORG_ID,
  deviceId: DEVICE_ID,
  now: new Date("2026-10-16T00:00:00.000Z"),
});
const signed = signGuardBundle(bundle, key);
const signedCatalogue = signGuardCatalogue(catalogue, ORG_ID, key);
const pinned = storedDevice(enrolmentFor(key));
const UNREADABLE_PEM = "-----BEGIN PUBLIC KEY-----\nnot a key\n-----END PUBLIC KEY-----\n";

const files = scratch("signed");
let agent: GoAgent;
beforeAll(async () => {
  agent = await buildGoAgent(files.dir());
});
afterAll(() => files.dispose());

const agentReads = (policy: { device?: unknown; bundle?: unknown; catalogue?: unknown }) =>
  policyScan(agent, writePolicy(files.dir(), { device: policy.device ?? pinned, bundle: policy.bundle ?? signed, catalogue: policy.catalogue ?? signedCatalogue }), [
    { id: "probe", host: "chatgpt.com", contentType: "text/plain", body: "hello" },
  ]);

const BUNDLE_REFUSED = "signed bundle did not verify against the enrolled key";
const CATALOGUE_REFUSED = "signed catalogue did not verify against the enrolled key";

describe("documents the contract signs, verified by the contract and by the Go agent", () => {
  it("the agent accepts the signed bundle and catalogue and reports the contract's digests", async () => {
    expect(verifyGuardBundle(signed, key.publicKeyPem, key.keyId, DEVICE_ID)).toEqual({
      ok: true,
      payload: { kind: "bundle", keyId: key.keyId, iat: expect.any(Number), orgId: ORG_ID, deviceId: DEVICE_ID, version: 0, digest: digestOf(bundle) },
    });
    expect(verifyGuardCatalogue(signedCatalogue, key.publicKeyPem, key.keyId)).toEqual({
      ok: true,
      payload: { kind: "catalogue", keyId: key.keyId, iat: expect.any(Number), orgId: ORG_ID, version: catalogue.version, digest: digestOf(catalogue) },
    });
    expect(signed.signature.jws.split(".")).toHaveLength(3);
    const scan = await agentReads({});
    expect(scan.stderr).toBe("");
    expect(scan.code).toBe(0);
    expect(scan.rows).toEqual([expect.objectContaining({ id: "probe", bundleVersion: 0, bundleDigest: digestOf(bundle), catalogueDigest: digestOf(catalogue) })]);
  });

  const tampered = { ...signed, bundle: { ...signed.bundle, defaultAction: "block" as const } };
  const wrongKind = { bundle, signature: signedCatalogue.signature };
  const twoSegments = { bundle, signature: { ...signed.signature, jws: "a.b" } };
  it.each([
    { name: "a tampered document", reason: "digest-mismatch", verdict: () => verifyGuardBundle(tampered, key.publicKeyPem, key.keyId), policy: { bundle: tampered } },
    {
      name: "a pinned public key that is another key's",
      reason: "bad-signature",
      verdict: () => verifyGuardBundle(signed, other.publicKeyPem, key.keyId),
      policy: { device: storedDevice(enrolmentFor({ keyId: key.keyId, publicKeyPem: other.publicKeyPem })) },
    },
    { name: "a pinned key id that is another key's", reason: "wrong-key", verdict: () => verifyGuardBundle(signed, other.publicKeyPem, other.keyId), policy: { device: storedDevice(enrolmentFor(other)) } },
    {
      name: "a bundle compiled for another device",
      reason: "wrong-device",
      verdict: () => verifyGuardBundle(signed, key.publicKeyPem, key.keyId, OTHER_DEVICE_ID),
      policy: { device: storedDevice(enrolmentFor(key, OTHER_DEVICE_ID)) },
    },
    { name: "a catalogue signature over a bundle", reason: "wrong-kind", verdict: () => verifyGuardBundle(wrongKind, key.publicKeyPem, key.keyId), policy: { bundle: wrongKind } },
    { name: "a JWS of two segments", reason: "malformed", verdict: () => verifyGuardBundle(twoSegments, key.publicKeyPem, key.keyId), policy: { bundle: twoSegments } },
  ])("$name: the contract answers $reason and the agent refuses it", async ({ reason, verdict, policy }) => {
    expect(verdict()).toEqual({ ok: false, reason });
    const scan = await agentReads(policy);
    expect(scan.code).toBe(1);
    expect(scan.stderr).toContain(BUNDLE_REFUSED);
  });

  it("a pinned key that cannot be read is a refusal on both sides, never a crash", async () => {
    expect(verifyGuardBundle(signed, UNREADABLE_PEM, key.keyId)).toEqual({ ok: false, reason: "bad-signature" });
    expect(verifyGuardCatalogue(signedCatalogue, "", key.keyId)).toEqual({ ok: false, reason: "bad-signature" });
    const scan = await agentReads({ device: { ...pinned, signing: { keyId: key.keyId, alg: "ES256", publicKeyPem: UNREADABLE_PEM } } });
    expect(scan.code).toBe(1);
    expect(scan.stderr).toContain(BUNDLE_REFUSED);
  });

  it("the catalogue signature binds the document and the org", async () => {
    const moved = { ...signedCatalogue, catalogue: { ...signedCatalogue.catalogue, version: "2099-01-01" } };
    expect(verifyGuardCatalogue(moved, key.publicKeyPem, key.keyId)).toEqual({ ok: false, reason: "digest-mismatch" });
    const movedScan = await agentReads({ catalogue: moved });
    expect(movedScan.code).toBe(1);
    expect(movedScan.stderr).toContain(CATALOGUE_REFUSED);
    const elsewhere = signGuardCatalogue(catalogue, "org_elsewhere", key);
    expect(verifyGuardCatalogue(elsewhere, key.publicKeyPem, key.keyId)).toMatchObject({ ok: true, payload: { orgId: "org_elsewhere" } });
    const elsewhereScan = await agentReads({ catalogue: elsewhere });
    expect(elsewhereScan.code).toBe(1);
    expect(elsewhereScan.stderr).toContain(CATALOGUE_REFUSED);
  });

  it("the canonical digest is the agent's: key order, absent fields and escaped text do not move it", async () => {
    expect(digestOf({ b: 1, a: [{ y: "x", x: undefined }] })).toBe(digestOf({ a: [{ y: "x" }], b: 1 }));
    expect(() => digestOf({ n: 1.5 })).toThrow(/integers only/);
    const awkward = 'quote " backslash \\ newline \n tab \t bell \u0007 accents éü emoji 😀 separator \u2028 end';
    const document = GuardRulesDocument.parse({
      version: 7,
      defaultAction: "allow",
      serviceRules: [{ ruleId: "gsr_00000001", serviceId: "cursor", audience: { kind: "org" }, action: "block", note: awkward }],
      contentRules: [{ ruleId: "gcr_00000001", name: 'Ünïcode "rule"\t1', detector: { kind: "keyword", keywords: [awkward] }, services: "*", audience: { kind: "org" }, action: "ask" }],
    });
    const compiled = compileGuardBundle({ document, catalogue, person: { ...PERSON, groupIds: [] }, settings: defaultGuardSettings(), grants: [], orgId: ORG_ID, deviceId: DEVICE_ID, now: new Date() });
    const withAbsentField = signGuardBundle({ ...compiled, surfaceBlocks: undefined }, key);
    expect(withAbsentField.bundle).toHaveProperty("surfaceBlocks", undefined);
    const reversed = (value: unknown): unknown =>
      Array.isArray(value)
        ? value.map(reversed)
        : value !== null && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reversed(v)]))
          : value;
    const scan = await agentReads({ bundle: reversed(withAbsentField) });
    expect(scan.stderr).toBe("");
    expect(scan.rows.map((row) => row.bundleDigest)).toEqual([digestOf(compiled)]);
    expect(digestOf(withAbsentField.bundle)).toBe(digestOf(compiled));
  });
});

describe("every forged JWS is refused by both verifiers, and the contract says why", () => {
  const [, goodBody, goodSignature] = signed.signature.jws.split(".") as [string, string, string];
  const goodPayload = JSON.parse(Buffer.from(goodBody, "base64url").toString("utf8")) as Record<string, unknown>;
  const b64 = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
  const forge = (header: string, payload: string, signer = key): string =>
    `${header}.${payload}.${nodeSign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(signer.privateKeyPem), dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
  const header = (fields: Record<string, unknown>): string => b64({ alg: "ES256", typ: GUARD_SIGNATURE_TYP, kid: key.keyId, ...fields });
  const envelope = (jws: string, keyId = key.keyId) => ({ bundle, signature: { ...signed.signature, keyId, jws } });

  it.each([
    { name: "a header that is not JSON", jws: forge(b64("not json{"), goodBody), reason: "malformed" },
    { name: "a payload that is not JSON", jws: forge(header({}), b64("{nope")), reason: "malformed" },
    { name: "a payload that is JSON but not the payload's shape", jws: forge(header({}), b64({ kind: "bundle" })), reason: "malformed" },
    { name: "alg none and no signature", jws: `${header({ alg: "none" })}.${goodBody}.`, reason: "malformed" },
    { name: "alg HS256", jws: forge(header({ alg: "HS256" }), goodBody), reason: "malformed" },
    { name: "alg RS256", jws: forge(header({ alg: "RS256" }), goodBody), reason: "malformed" },
    { name: "another typ", jws: forge(header({ typ: "JWT" }), goodBody), reason: "malformed" },
    { name: "no typ", jws: forge(b64({ alg: "ES256", kid: key.keyId }), goodBody), reason: "malformed" },
    { name: "a header kid that is another key's", jws: forge(header({ kid: other.keyId }), goodBody), reason: "wrong-key" },
    { name: "a payload keyId that is another key's", jws: forge(header({}), b64({ ...goodPayload, keyId: other.keyId })), reason: "wrong-key" },
    { name: "an envelope keyId that is another key's", jws: signed.signature.jws, keyId: other.keyId, reason: "wrong-key" },
    { name: "a signature of the wrong length", jws: `${header({})}.${goodBody}.${Buffer.alloc(10, 1).toString("base64url")}`, reason: "bad-signature" },
    { name: "an empty signature", jws: `${header({})}.${goodBody}.`, reason: "bad-signature" },
    { name: "a signature by another private key", jws: forge(header({}), goodBody, other), reason: "bad-signature" },
    { name: "a signature over another header", jws: `${header({ x: 1 })}.${goodBody}.${goodSignature}`, reason: "bad-signature" },
    { name: "four segments", jws: `${signed.signature.jws}.x`, reason: "malformed" },
  ])("$name: the contract answers $reason and the agent refuses it", async ({ jws, keyId, reason }) => {
    const forged = envelope(jws, keyId);
    expect(verifyGuardBundle(forged, key.publicKeyPem, key.keyId)).toEqual({ ok: false, reason });
    const scan = await agentReads({ bundle: forged });
    expect(scan.code).toBe(1);
    expect(scan.stderr).toContain(BUNDLE_REFUSED);
  });

  it("the same segments re-signed by the pinned key are accepted by both", async () => {
    const resigned = envelope(forge(header({}), goodBody));
    expect(verifyGuardBundle(resigned, key.publicKeyPem, key.keyId)).toMatchObject({ ok: true });
    const scan = await agentReads({ bundle: resigned });
    expect(scan.code).toBe(0);
    expect(scan.rows.map((row) => row.bundleDigest)).toEqual([digestOf(bundle)]);
  });
});

describe("tokens", () => {
  it("minted tokens have the grammars the sync doors accept, and the stored hash is not the token", () => {
    const enrolToken = mintEnrolToken();
    const deviceToken = mintDeviceToken();
    expect(enrolToken).toMatch(/^genr_[0-9a-f]{32}$/);
    expect(deviceToken).toMatch(/^gdt_[0-9a-f]{48}$/);
    expect(mintEnrolToken()).not.toBe(enrolToken);
    const ca = { fingerprintSha256: "a".repeat(64), subject: "Vibtra Guard CA (example-host)", notAfter: "2036-10-24T00:00:00.000Z" };
    const device = { hostname: "example-host", osVersion: "26.6", agentVersion: "0.1.0" };
    expect(GuardEnrolRequest.safeParse({ protocol: 1, enrolToken, device, ca }).success).toBe(true);
    expect(GuardEnrolRequest.safeParse({ protocol: 1, enrolToken: deviceToken, device, ca }).success).toBe(false);
    expect(GuardEnrolResponse.safeParse({ ...enrolmentFor(key), deviceToken }).success).toBe(true);
    expect(GuardEnrolResponse.safeParse({ ...enrolmentFor(key), deviceToken: enrolToken }).success).toBe(false);
    const hash = tokenHashOf(deviceToken);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(tokenHashOf(deviceToken));
    expect(hash).not.toBe(tokenHashOf(mintDeviceToken()));
    expect(hash).not.toContain(deviceToken.slice(4, 20));
  });
});
