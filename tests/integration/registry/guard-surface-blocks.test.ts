import { describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GuardRuleDownloadResponse, type GuardSurfaceId, type SignedGuardBundle } from "@vibtra/guard-contract";
import { digestOf, verifyGuardBundle } from "@vibtra/guard-contract/signing";
import { startRegistry, type TestRegistry } from "../../support/registry.ts";
import { CA, agentDoor, enrolDevice, facts, mintEnrolLink, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { capturingStorage, postgresMissing, sqlRows, type Storage } from "./server-options.ts";

type Json = Record<string, any>;

const RULES = { defaultAction: "allow", serviceRules: [], contentRules: [] };
const BOTH_WEB = { "claude-web": true, "chatgpt-web": true };

const claimSurfaces = (registry: TestRegistry, laptop: EnrolledDevice, hostname: string, surfaces: GuardSurfaceId[], extra: Json = {}) =>
  agentDoor(
    registry,
    "POST",
    `/preflight/${laptop.deviceId}`,
    laptop.token,
    preflightBody(hostname, { ...extra, device: facts(hostname, { capabilities: { surfaceBlocks: 1 }, supportedSurfaceBlocks: surfaces }) }),
  );

const putRules = (registry: TestRegistry, baseVersion: number, document: Json) =>
  registry.consoleWrite(registry.people.owner, "PUT", "/guard/rules", { baseVersion, document });

const setService = (registry: TestRegistry, serviceId: string, enabled: boolean) =>
  registry.consoleWrite(registry.people.owner, "PUT", `/guard/services/${serviceId}`, { enabled });

describe("surface blocks", () => {
  it("gates the rollout on every active laptop, signs the blocks into the bundle, refuses a rollback or an old enrolment, and still lets the admin clear them", async () => {
    const registry = await startRegistry({ domain: "surface-controls.example" });
    try {
      const { owner, member } = registry.people;
      const dee = await registry.join("dee");
      const laptop = await enrolDevice(registry, owner, member, "surface-mac");
      const { publicKeyPem, keyId } = laptop.enrol.signing;
      const retired = await enrolDevice(registry, owner, dee, "retired-mac");
      expect((await registry.consoleWrite(owner, "POST", `/guard/devices/${retired.deviceId}/revoke`, {})).status).toBe(200);
      const document = { ...RULES, surfaceBlocks: BOTH_WEB };

      const unsupported = await putRules(registry, 0, document);
      expect([unsupported.status, (unsupported.body as Json).code]).toEqual([409, "GUARD_UPGRADE_REQUIRED"]);
      expect((await registry.consoleWrite(member, "PUT", "/guard/rules", { baseVersion: 0, document })).status).toBe(403);
      expect((await putRules(registry, 0, { ...document, surfaceBlocks: { unknown: true } })).status).toBe(400);
      expect((await claimSurfaces(registry, laptop, "surface-mac", ["claude-web"])).status).toBe(200);
      expect((await putRules(registry, 0, document)).status).toBe(409);
      expect((await claimSurfaces(registry, laptop, "surface-mac", ["claude-web", "chatgpt-web"])).status).toBe(200);
      const saved = await putRules(registry, 0, document);
      expect(saved.status, saved.text).toBe(200);
      expect((saved.body as Json).document.surfaceBlocks).toEqual(BOTH_WEB);
      expect((await putRules(registry, 0, document)).status).toBe(409);

      const download = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(download.status, download.text).toBe(200);
      const signed: SignedGuardBundle = required(GuardRuleDownloadResponse.parse(download.body).bundle, "a bundle");
      expect(signed.bundle.surfaceBlocks).toEqual(BOTH_WEB);
      expect(verifyGuardBundle(signed, publicKeyPem, keyId, laptop.deviceId)).toMatchObject({ ok: true });
      const applied = {
        protocol: GUARD_PROTOCOL_VERSION,
        bundleVersion: signed.bundle.bundleVersion,
        catalogueVersion: signed.bundle.catalogueVersion,
        bundleDigest: digestOf(signed.bundle),
        rulesReceived: 2,
        rulesProcessed: 2,
        clientMode: "monitor",
      };
      expect((await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, applied)).status).toBe(200);
      const unchanged = await claimSurfaces(registry, laptop, "surface-mac", ["claude-web", "chatgpt-web"], {
        bundleVersion: applied.bundleVersion,
        catalogueVersion: applied.catalogueVersion,
      });
      expect((unchanged.body as Json).rulesChanged).toBe(false);
      const tampered = structuredClone(signed);
      required(tampered.bundle.surfaceBlocks, "the signed blocks")["claude-web"] = false;
      expect(verifyGuardBundle(tampered, publicKeyPem, keyId, laptop.deviceId)).toMatchObject({ ok: false });

      const link = await mintEnrolLink(registry, owner, dee);
      const legacy = await agentDoor(registry, "POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.token, device: facts("old-agent"), ca: CA });
      expect([legacy.status, (legacy.body as Json).code]).toEqual([409, "GUARD_UPGRADE_REQUIRED"]);
      const rollback = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody("surface-mac"));
      expect(rollback.status).toBe(409);
      expect((await agentDoor(registry, "POST", `/postflight/${laptop.deviceId}`, laptop.token, applied)).status).toBe(409);
      const refused = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect([refused.status, (refused.body as Json).code]).toEqual([409, "GUARD_UPGRADE_REQUIRED"]);
      expect(refused.body).not.toHaveProperty("bundle");

      const reduce = await putRules(registry, 1, { ...document, surfaceBlocks: { "chatgpt-web": true } });
      expect(reduce.status, reduce.text).toBe(200);
      expect((reduce.body as Json).document.surfaceBlocks).toEqual({ "chatgpt-web": true });
      expect((await putRules(registry, 2, { ...document, surfaceBlocks: {} })).status).toBe(200);
      const restored = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(restored.status, restored.text).toBe(200);
      const back = required(GuardRuleDownloadResponse.parse(restored.body).bundle, "a bundle after clearing");
      expect(digestOf(back.bundle)).not.toBe(applied.bundleDigest);
      expect(back.bundle.bundleVersion).toBe(3);
      expect(back.bundle).not.toHaveProperty("surfaceBlocks");
      expect(verifyGuardBundle(back, publicKeyPem, keyId, laptop.deviceId)).toMatchObject({ ok: true });
    } finally {
      await registry.close();
    }
  });

  it("needs the catalogue to route a surface before it is switched on, and refuses switching off a service a surface controls", async () => {
    const registry = await startRegistry({ domain: "surface-catalogue.example" });
    try {
      let version = 0;
      for (const [surface, serviceId] of [
        ["claude-web", "anthropic-claude"],
        ["chatgpt-web", "openai-chatgpt"],
      ] as const) {
        expect((await setService(registry, serviceId, false)).status).toBe(200);
        const refused = await putRules(registry, version, { ...RULES, surfaceBlocks: { [surface]: true } });
        expect([surface, refused.status, (refused.body as Json).code]).toEqual([surface, 409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE"]);
        expect((await setService(registry, serviceId, true)).status).toBe(200);
        expect((await putRules(registry, version, { ...RULES, surfaceBlocks: { [surface]: true } })).status).toBe(200);
        version += 1;
        const disabled = await setService(registry, serviceId, false);
        expect([surface, disabled.status, (disabled.body as Json).code]).toEqual([surface, 409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE"]);
        expect((await putRules(registry, version, RULES)).status).toBe(200);
        version += 1;
      }
      expect((await setService(registry, "anthropic-claude", false)).status).toBe(200);
    } finally {
      await registry.close();
    }
  });

  it("refuses a bundle when a catalogue written outside the console stops routing an active surface (Postgres)", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    let storage: Storage | undefined;
    const registry = await startRegistry({ domain: "surface-import.example", configure: capturingStorage((captured) => (storage = captured)) });
    try {
      const databaseUrl = required(required(storage, "the captured storage").databaseUrl, "a database URL");
      const laptop = await enrolDevice(registry, registry.people.owner, registry.people.member, "catalogue-import");
      expect((await claimSurfaces(registry, laptop, "catalogue-import", ["claude-web", "chatgpt-web"])).status).toBe(200);
      expect((await setService(registry, "perplexity", false)).status).toBe(200);
      expect((await putRules(registry, 0, { ...RULES, surfaceBlocks: { "claude-web": true } })).status).toBe(200);
      const changed = await sqlRows<{ org_id: string }>(
        databaseUrl,
        "UPDATE guard_catalogue_overrides SET overrides = $1::jsonb, version = version + 1, updated_at = now() RETURNING org_id",
        [JSON.stringify([{ serviceId: "anthropic-claude", enabled: false }])],
      );
      expect(changed).toHaveLength(1);
      const download = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect([download.status, (download.body as Json).code]).toEqual([409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE"]);
      expect(download.body).not.toHaveProperty("bundle");
      expect((await putRules(registry, 1, RULES)).status).toBe(200);
      expect((await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION })).status).toBe(200);
    } finally {
      await registry.close();
    }
  });

  it("lets the native macOS controls be removed and switched back on one at a time", async () => {
    const registry = await startRegistry({ domain: "surface-native.example" });
    try {
      const both = await putRules(registry, 0, { ...RULES, surfaceBlocks: { "claude-macos": true, "chatgpt-macos": true } });
      expect(both.status, both.text).toBe(200);
      const one = await putRules(registry, 1, { ...RULES, surfaceBlocks: { "claude-macos": true } });
      expect((one.body as Json).document.surfaceBlocks).toEqual({ "claude-macos": true });
      const again = await putRules(registry, 2, { ...RULES, surfaceBlocks: { "claude-macos": true, "chatgpt-macos": true } });
      expect(again.status, again.text).toBe(200);
      expect((again.body as Json).document.surfaceBlocks).toEqual({ "claude-macos": true, "chatgpt-macos": true });
      const none = await putRules(registry, 3, RULES);
      expect(none.status, none.text).toBe(200);
      expect((none.body as Json).document).not.toHaveProperty("surfaceBlocks");
    } finally {
      await registry.close();
    }
  });
});
