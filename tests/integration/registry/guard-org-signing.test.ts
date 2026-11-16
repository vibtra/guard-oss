import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GuardPreflightResponse, GuardRuleDownloadResponse, GuardSettingsPage, GuardSigningKeyResponse } from "@vibtra/guard-contract";
import { signGuardBundle, verifyGuardBundle, verifyGuardCatalogue } from "@vibtra/guard-contract/signing";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";

let registry: TestRegistry;
let ownerA: Person;
let ownerB: Person;
let a1: EnrolledDevice;
let a2: EnrolledDevice;
let b1: EnrolledDevice;
let b2: EnrolledDevice;

const signingDoor = async (laptop: EnrolledDevice) => {
  const reply = await agentDoor(registry, "GET", `/signing/${laptop.deviceId}`, laptop.token);
  expect(reply.status, reply.text).toBe(200);
  return GuardSigningKeyResponse.parse(reply.body).signing;
};

const download = async (laptop: EnrolledDevice) => {
  const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
  expect(reply.status, reply.text).toBe(200);
  const body = GuardRuleDownloadResponse.parse(reply.body);
  return { bundle: required(body.bundle, "a bundle on a first download"), catalogue: required(body.catalogue, "a catalogue on a first download") };
};

beforeAll(async () => {
  registry = await startRegistry({ domain: "org-a.example" });
  ownerA = registry.people.owner;
  ownerB = await registry.join("bee", "org-b.example");
  [a1, a2, b1, b2] = await Promise.all([
    enrolDevice(registry, ownerA, ownerA, "owner-a-mbp"),
    enrolDevice(registry, ownerA, registry.people.member, "member-a-mbp"),
    enrolDevice(registry, ownerB, ownerB, "bee-mbp"),
    enrolDevice(registry, ownerB, ownerB, "bee-mini"),
  ]);
});

afterAll(async () => {
  await registry?.close();
});

describe("per-organisation policy-signing keys", () => {
  it("gives each org its own key, and every device of an org that org's key from enrol, the signing door, preflight and the console", async () => {
    expect(a1.enrol.orgId).not.toBe(b1.enrol.orgId);
    expect(a2.enrol.signing).toEqual(a1.enrol.signing);
    expect(b2.enrol.signing).toEqual(b1.enrol.signing);
    expect(b1.enrol.signing.keyId).not.toBe(a1.enrol.signing.keyId);
    expect(b1.enrol.signing.publicKeyPem).not.toBe(a1.enrol.signing.publicKeyPem);

    for (const laptop of [a1, a2, b1, b2]) {
      expect(await signingDoor(laptop)).toEqual(laptop.enrol.signing);
      const preflight = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("laptop-mbp"));
      expect(preflight.status, preflight.text).toBe(200);
      expect(GuardPreflightResponse.parse(preflight.body).signingKeyId).toBe(laptop.enrol.signing.keyId);
    }
    for (const [owner, laptop] of [[ownerA, a1], [ownerB, b1]] as const) {
      const page = await registry.consoleGet(owner, "/guard/settings");
      expect(page.status, page.text).toBe(200);
      expect(GuardSettingsPage.parse(page.body).signingKeyId).toBe(laptop.enrol.signing.keyId);
    }
  });

  it("signs each org's bundle and catalogue with that org's key, which the other org's pinned key refuses", async () => {
    const [fromA, fromB] = await Promise.all([download(a1), download(b1)]);
    const keyA = a1.enrol.signing;
    const keyB = b1.enrol.signing;
    expect(verifyGuardBundle(fromA.bundle, keyA.publicKeyPem, keyA.keyId, a1.deviceId)).toMatchObject({ ok: true, payload: { orgId: a1.enrol.orgId } });
    expect(verifyGuardBundle(fromB.bundle, keyB.publicKeyPem, keyB.keyId, b1.deviceId)).toMatchObject({ ok: true, payload: { orgId: b1.enrol.orgId } });
    expect(verifyGuardCatalogue(fromA.catalogue, keyA.publicKeyPem, keyA.keyId)).toMatchObject({ ok: true, payload: { orgId: a1.enrol.orgId } });
    expect(verifyGuardCatalogue(fromB.catalogue, keyB.publicKeyPem, keyB.keyId)).toMatchObject({ ok: true, payload: { orgId: b1.enrol.orgId } });
    expect(verifyGuardBundle(fromA.bundle, keyB.publicKeyPem, keyB.keyId)).toMatchObject({ ok: false, reason: "wrong-key" });
    expect(verifyGuardCatalogue(fromA.catalogue, keyB.publicKeyPem, keyB.keyId)).toMatchObject({ ok: false, reason: "wrong-key" });
  });

  it("refuses a bundle that names org B but was signed with org A's private key, even under org B's key id", async () => {
    const guard = required(registry.server.guard, "the guard service");
    const privateA = await guard.signingKey(a1.enrol.orgId);
    expect(privateA.keyId).toBe(a1.enrol.signing.keyId);
    const keyB = b1.enrol.signing;
    const { bundle } = (await download(b1)).bundle;
    expect(bundle.orgId).toBe(b1.enrol.orgId);

    const honest = signGuardBundle(bundle, privateA);
    expect(verifyGuardBundle(honest, keyB.publicKeyPem, keyB.keyId, b1.deviceId)).toMatchObject({ ok: false, reason: "wrong-key" });
    const forged = signGuardBundle(bundle, { ...privateA, keyId: keyB.keyId });
    expect(verifyGuardBundle(forged, keyB.publicKeyPem, keyB.keyId, b1.deviceId)).toMatchObject({ ok: false, reason: "bad-signature" });
  });
});
