import { describe, expect, it } from "vitest";
import {
  GuardClientMode,
  GuardDeviceFacts,
  GuardRulesDocument,
  GuardSettings,
  GuardSignaturePayload,
  compileGuardBundle,
  decideRequest,
  defaultGuardSettings,
  effectiveMode,
  modeOrEnforce,
  raiseMode,
  seedCatalogue,
  type GuardBundle,
} from "@vibtra/guard-contract";
import { digestOf, generateGuardSigningKey, signEs256, signGuardBundle, signGuardCatalogue, verifyGuardBundle, type GuardSigner } from "@vibtra/guard-contract/signing";
import { DEVICE_ID, ORG_ID, PERSON } from "./support.js";

const SEVENTY_TWO_HOURS_S = 72 * 60 * 60;
const NOW = new Date("2026-11-23T09:30:00.000Z");
const catalogue = seedCatalogue();
const key = generateGuardSigningKey();

const rules = GuardRulesDocument.parse({
  version: 7,
  defaultAction: "allow",
  serviceRules: [{ ruleId: "gsr_00000001", serviceId: "deepseek", audience: { kind: "org" }, action: "block", enabled: true }],
  contentRules: [{ ruleId: "gcr_00000001", name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", action: "block", audience: { kind: "org" }, enabled: true }],
});

const compile = (protection?: { mode: GuardClientMode; defaultMode: GuardClientMode; revision: number }, settings: GuardSettings = defaultGuardSettings()): GuardBundle =>
  compileGuardBundle({ document: rules, catalogue, person: { ...PERSON, groupIds: [] }, settings, ...(protection === undefined ? {} : { protection }), grants: [], orgId: ORG_ID, deviceId: DEVICE_ID, now: NOW });

const payloadOf = (jws: string): GuardSignaturePayload => GuardSignaturePayload.parse(JSON.parse(Buffer.from(jws.split(".")[1] ?? "", "base64url").toString("utf8")));

describe("protection modes", () => {
  it.each([
    ["off", "off", "off"],
    ["off", "monitor", "monitor"],
    ["off", "enforce", "enforce"],
    ["monitor", "off", "monitor"],
    ["monitor", "monitor", "monitor"],
    ["monitor", "enforce", "enforce"],
    ["enforce", "off", "enforce"],
    ["enforce", "monitor", "enforce"],
    ["enforce", "enforce", "enforce"],
  ] as const)("raiseMode(%s, %s) is %s: the stricter of the two, off < monitor < enforce", (a, b, stricter) => {
    expect(raiseMode(a, b)).toBe(stricter);
  });

  it("parses a known mode as itself and anything else as enforce", () => {
    expect(GuardClientMode.options).toEqual(["off", "monitor", "enforce"]);
    for (const mode of GuardClientMode.options) expect(modeOrEnforce(mode)).toBe(mode);
    for (const unknown of ["strict", "Off", "OFF", " monitor", "", undefined, null, 0, 1, true, {}, ["off"]]) expect(modeOrEnforce(unknown), JSON.stringify(unknown)).toBe("enforce");
  });

  it("resolves a person to their own setting when they have one, even below the default, and to the org default otherwise", () => {
    for (const orgDefault of GuardClientMode.options) {
      expect(effectiveMode(undefined, orgDefault)).toEqual({ mode: orgDefault, source: "default" });
      for (const mode of GuardClientMode.options) expect(effectiveMode({ mode }, orgDefault)).toEqual({ mode, source: "set" });
    }
  });

  it("takes off as an org default and a device's protectionOff capability, and nothing else for either", () => {
    expect(GuardSettings.parse({ clientMode: "off" }).clientMode).toBe("off");
    expect(GuardSettings.safeParse({ clientMode: "paused" }).success).toBe(false);
    const facts = { hostname: "bo-mbp", osVersion: "26.0", agentVersion: "0.2.0" };
    expect(GuardDeviceFacts.parse({ ...facts, capabilities: { surfaceBlocks: 1, protectionOff: 1 } }).capabilities).toEqual({ surfaceBlocks: 1, protectionOff: 1 });
    expect(GuardDeviceFacts.safeParse({ ...facts, capabilities: { protectionOff: 2 } }).success).toBe(false);
    expect(GuardDeviceFacts.safeParse({ ...facts, capabilities: { protectionOff: true } }).success).toBe(false);
  });
});

describe("compileGuardBundle with a person's protection", () => {
  it("compiles the person's mode, the org default and the protection revision into the signed body", () => {
    const bundle = compile({ mode: "enforce", defaultMode: "monitor", revision: 12 });
    expect(bundle).toMatchObject({ clientMode: "enforce", defaultMode: "monitor", protectionRevision: 12 });
    expect(digestOf(compile({ mode: "enforce", defaultMode: "monitor", revision: 13 }))).not.toBe(digestOf(bundle));
    expect(digestOf(compile({ mode: "enforce", defaultMode: "enforce", revision: 12 }))).not.toBe(digestOf(bundle));
    expect(digestOf(compile({ mode: "monitor", defaultMode: "monitor", revision: 12 }))).not.toBe(digestOf(bundle));
  });

  it("compiles a person with no protection given onto the org default at revision 0", () => {
    expect(compile(undefined, GuardSettings.parse({ clientMode: "enforce" }))).toMatchObject({ clientMode: "enforce", defaultMode: "enforce", protectionRevision: 0 });
    expect(compile()).toMatchObject({ clientMode: "monitor", defaultMode: "monitor", protectionRevision: 0 });
  });

  it("intercepts nothing under off, while keeping the rules a raised mode falls back to", () => {
    const off = compile({ mode: "off", defaultMode: "enforce", revision: 3 });
    expect(off.services.deepseek).toEqual({ action: "block", ruleId: "gsr_00000001" });
    expect(off.contentRules.map((rule) => rule.ruleId)).toEqual(["gcr_00000001"]);
    for (const request of [{ host: "chat.deepseek.com" }, { host: "chatgpt.com", text: "my tfn is 123 456 782" }, { host: "chatgpt.com", text: "hello" }, { host: "www.example.com" }]) {
      expect(decideRequest(off, catalogue, request), request.host).toEqual({ intercepted: false, verdict: "not-intercepted", enforced: false });
    }
    const enforce = compile({ mode: "enforce", defaultMode: "enforce", revision: 3 });
    expect(decideRequest(enforce, catalogue, { host: "chat.deepseek.com" })).toMatchObject({ intercepted: true, verdict: "blocked", enforced: true });
    expect(decideRequest(enforce, catalogue, { host: "chatgpt.com", text: "my tfn is 123 456 782" })).toMatchObject({ intercepted: true, verdict: "blocked", enforced: true });
    const monitor = compile({ mode: "monitor", defaultMode: "enforce", revision: 3 });
    expect(decideRequest(monitor, catalogue, { host: "chat.deepseek.com" })).toMatchObject({ intercepted: true, verdict: "blocked", enforced: false });
  });

  it("blocks uninspectable TLS whenever the person's own mode is enforce, whatever the org default", () => {
    const tunnel = GuardSettings.parse({ clientMode: "enforce", unreproducibleTls: "tunnel" });
    expect(compile({ mode: "monitor", defaultMode: "enforce", revision: 1 }, tunnel).settings.unreproducibleTls).toBe("tunnel");
    expect(compile({ mode: "off", defaultMode: "enforce", revision: 1 }, tunnel).settings.unreproducibleTls).toBe("tunnel");
    const monitorOrg = GuardSettings.parse({ clientMode: "monitor", unreproducibleTls: "tunnel" });
    expect(compile({ mode: "enforce", defaultMode: "monitor", revision: 1 }, monitorOrg).settings.unreproducibleTls).toBe("block");
  });
});

describe("a signed policy's expiry", () => {
  const bundle = compile({ mode: "monitor", defaultMode: "monitor", revision: 4 });
  const iat = Math.floor(NOW.getTime() / 1000);

  it("signs validUntil 72 hours after iat into the payload, which the pinned key still verifies", () => {
    const signed = signGuardBundle(bundle, key, NOW);
    expect(payloadOf(signed.signature.jws)).toMatchObject({ kind: "bundle", iat, validUntil: iat + SEVENTY_TWO_HOURS_S });
    expect(verifyGuardBundle(signed, key.publicKeyPem, key.keyId, DEVICE_ID)).toEqual({
      ok: true,
      payload: { kind: "bundle", keyId: key.keyId, iat, validUntil: iat + SEVENTY_TWO_HOURS_S, orgId: ORG_ID, deviceId: DEVICE_ID, version: 7, digest: digestOf(bundle) },
    });
    expect(signed.bundle).toEqual(bundle);
    expect(signed.bundle).not.toHaveProperty("validUntil");
  });

  it("signs the same expiry through a GuardSigner", async () => {
    const signer: GuardSigner = {
      publicKey: async () => ({ keyId: key.keyId, publicKeyPem: key.publicKeyPem }),
      sign: async (_orgId, input) => ({ keyId: key.keyId, signature: signEs256(input(key.keyId), key.privateKeyPem) }),
    };
    const later = new Date(NOW.getTime() + 90_500);
    const signed = await signGuardBundle(bundle, signer, later);
    expect(payloadOf(signed.signature.jws)).toMatchObject({ iat: iat + 90, validUntil: iat + 90 + SEVENTY_TWO_HOURS_S });
    expect(verifyGuardBundle(signed, key.publicKeyPem, key.keyId, DEVICE_ID)).toMatchObject({ ok: true, payload: { validUntil: iat + 90 + SEVENTY_TWO_HOURS_S } });
  });

  it("keeps the body digest the same across signings, so a re-signed policy is not a changed one", () => {
    const first = signGuardBundle(bundle, key, NOW);
    const second = signGuardBundle(bundle, key, new Date(NOW.getTime() + 3_600_000));
    expect(payloadOf(first.signature.jws).digest).toBe(payloadOf(second.signature.jws).digest);
    expect(payloadOf(second.signature.jws).validUntil).toBe((payloadOf(first.signature.jws).validUntil ?? 0) + 3600);
  });

  it("refuses a tampered expiry", () => {
    const signed = signGuardBundle(bundle, key, NOW);
    const [header, body, signature] = signed.signature.jws.split(".");
    const extended = Buffer.from(JSON.stringify({ ...payloadOf(signed.signature.jws), validUntil: iat + 10 * SEVENTY_TWO_HOURS_S })).toString("base64url");
    expect(body).not.toBe(extended);
    expect(verifyGuardBundle({ ...signed, signature: { ...signed.signature, jws: `${header}.${extended}.${signature}` } }, key.publicKeyPem, key.keyId)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("puts no expiry on a signed catalogue", () => {
    expect(payloadOf(signGuardCatalogue(catalogue, ORG_ID, key, NOW).signature.jws)).not.toHaveProperty("validUntil");
  });
});
