import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GUARD_PROTOCOL_VERSION,
  GuardDevicesPage,
  GuardPreflightResponse,
  GuardProtectionApplied,
  GuardProtectionPreview,
  GuardProtectionRollout,
  GuardRuleDownloadResponse,
  GuardRulesPage,
  type GuardClientMode,
  type GuardDeviceFacts,
  type SignedGuardBundle,
} from "@vibtra/guard-contract";
import { startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, facts, preflightBody, required, type EnrolledDevice } from "./guard-device.ts";
import { postgresMissing } from "./server-options.ts";

const P = "/people/protection";
const CAN_TURN_OFF: Partial<GuardDeviceFacts> = { capabilities: { protectionOff: 1 } };

const TWINS = [
  { name: "JSON file", postgres: false },
  { name: "Postgres", postgres: true },
] as const;

for (const twin of TWINS) {
  describe.skipIf(twin.postgres && postgresMissing())(`the check-in heartbeat (${twin.name})`, () => {
    let registry: TestRegistry;
    let owner: Person;
    let ana: Person;
    let bo: Person;

    beforeAll(async () => {
      registry = await startRegistry({ domain: `guard-heartbeat-${twin.postgres ? "pg" : "file"}.example`, ...(twin.postgres ? {} : { storage: "file" as const }) });
      owner = registry.people.owner;
      ana = await registry.join("ana");
      bo = await registry.join("bo");
    });

    afterAll(async () => {
      await registry?.close();
    });

    const setMode = async (who: Person, mode: GuardClientMode): Promise<number> => {
      const changes = [{ userIds: [who.userId], mode }];
      const preview = await registry.consoleWrite(owner, "POST", `${P}/preview`, { changes });
      expect(preview.status, preview.text).toBe(200);
      const { revision, peopleDigest } = GuardProtectionPreview.parse(preview.body);
      const reply = await registry.consoleWrite(owner, "POST", `${P}/apply`, { changes, revision, peopleDigest });
      expect(reply.status, reply.text).toBe(200);
      return GuardProtectionApplied.parse(reply.body).revision;
    };
    const preflight = async (laptop: EnrolledDevice, hostname: string, body: Record<string, unknown>) => {
      const reply = await agentDoor(registry, "POST", `/preflight/${laptop.deviceId}`, laptop.token, preflightBody(hostname, { device: facts(hostname, CAN_TURN_OFF), ...body }));
      expect(reply.status, reply.text).toBe(200);
      return GuardPreflightResponse.parse(reply.body);
    };
    const download = async (laptop: EnrolledDevice): Promise<SignedGuardBundle> => {
      const reply = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
      expect(reply.status, reply.text).toBe(200);
      return required(GuardRuleDownloadResponse.parse(reply.body).bundle, "a bundle");
    };
    const stateOf = async (revision: number, laptop: EnrolledDevice) => {
      const reply = await registry.consoleGet(owner, `${P}/rollout?revision=${revision}`);
      expect(reply.status, reply.text).toBe(200);
      return required(GuardProtectionRollout.parse(reply.body).people.flatMap((p) => p.devices).find((d) => d.deviceId === laptop.deviceId), "the Mac in the rollout").state;
    };
    const rowOf = async (laptop: EnrolledDevice) => {
      const reply = await registry.consoleGet(owner, "/guard/devices");
      expect(reply.status, reply.text).toBe(200);
      return required(GuardDevicesPage.parse(reply.body).rows.find((row) => row.deviceId === laptop.deviceId), "the Mac on the devices page");
    };

    it("confirms a rollout from the next check-in's stamp when the postflight was lost", async () => {
      const laptop = await enrolDevice(registry, owner, ana, "ana-mbp", facts("ana-mbp", CAN_TURN_OFF));
      const before = await setMode(ana, "monitor");
      await preflight(laptop, "ana-mbp", { clientMode: "enforce" });
      const held = await download(laptop);
      expect(held.bundle.protectionRevision).toBe(before);

      const revision = await setMode(ana, "off");
      await preflight(laptop, "ana-mbp", { clientMode: "monitor", bundleVersion: held.bundle.bundleVersion, protectionRevision: held.bundle.protectionRevision });
      const fresh = await download(laptop);
      expect([fresh.bundle.clientMode, fresh.bundle.protectionRevision]).toEqual(["off", revision]);
      expect(await stateOf(revision, laptop), "the Mac downloaded the change but its postflight never arrived").toBe("pending");

      await preflight(laptop, "ana-mbp", { clientMode: "off", bundleVersion: held.bundle.bundleVersion, protectionRevision: held.bundle.protectionRevision });
      expect(await stateOf(revision, laptop), "a heartbeat still carrying the old stamp").toBe("pending");

      await preflight(laptop, "ana-mbp", { clientMode: "off", bundleVersion: fresh.bundle.bundleVersion, protectionRevision: fresh.bundle.protectionRevision });
      expect(await stateOf(revision, laptop)).toBe("applied");
      expect(await rowOf(laptop)).toMatchObject({ clientMode: "off", bundleVersion: fresh.bundle.bundleVersion });

      await preflight(laptop, "ana-mbp", { clientMode: "monitor", bundleVersion: fresh.bundle.bundleVersion, protectionRevision: fresh.bundle.protectionRevision });
      expect(await stateOf(revision, laptop), "the new stamp in a mode other than the target").toBe("pending");
    });

    it("keeps the last health snapshot when a check-in leaves it out, and replaces it when one comes", async () => {
      const laptop = await enrolDevice(registry, owner, bo, "bo-mbp", facts("bo-mbp", CAN_TURN_OFF));
      const health = { caTrusted: true, proxyListening: true, extensionActive: true, uptimeSeconds: 40 };
      await preflight(laptop, "bo-mbp", { health });
      expect((await rowOf(laptop)).health).toEqual({ caTrusted: true, proxyListening: true, extensionActive: true });

      await preflight(laptop, "bo-mbp", {});
      expect((await rowOf(laptop)).health, "a heartbeat without health").toEqual({ caTrusted: true, proxyListening: true, extensionActive: true });

      await preflight(laptop, "bo-mbp", { health: { ...health, extensionActive: false, uptimeSeconds: 100 } });
      expect((await rowOf(laptop)).health).toEqual({ caTrusted: true, proxyListening: true, extensionActive: false });
    });

    it("confirms a rollout only when the stamp's bundle version and revision both match, and reads a check-in without a revision as revision 0", async () => {
      const laptop = await enrolDevice(registry, owner, bo, "bo-air", facts("bo-air", CAN_TURN_OFF));
      const revision = await setMode(bo, "monitor");
      await preflight(laptop, "bo-air", { clientMode: "enforce" });
      const held = await download(laptop);
      const { version } = GuardRulesPage.parse((await registry.consoleGet(owner, "/guard/rules")).body).document;
      const saved = await registry.consoleWrite(owner, "PUT", "/guard/rules", { baseVersion: version, document: { defaultAction: "allow", serviceRules: [], contentRules: [] } });
      expect(saved.status, saved.text).toBe(200);
      const fresh = await download(laptop);
      expect([fresh.bundle.protectionRevision, fresh.bundle.bundleVersion > held.bundle.bundleVersion]).toEqual([revision, true]);

      await preflight(laptop, "bo-air", { clientMode: "monitor", bundleVersion: held.bundle.bundleVersion, protectionRevision: revision });
      expect(await stateOf(revision, laptop), "the person's revision, but rules from before the change").toBe("pending");

      await preflight(laptop, "bo-air", { clientMode: "monitor", bundleVersion: fresh.bundle.bundleVersion, protectionRevision: revision });
      expect(await stateOf(revision, laptop)).toBe("applied");

      await preflight(laptop, "bo-air", { clientMode: "monitor", bundleVersion: fresh.bundle.bundleVersion });
      expect(await stateOf(revision, laptop), "a check-in that names no revision holds revision 0").toBe("pending");
    });
  });
}
