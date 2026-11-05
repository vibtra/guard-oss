import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GUARD_PROTOCOL_VERSION, GuardRuleDownloadResponse } from "@vibtra/guard-contract";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import { startRegistry, type ConsoleReply, type TestRegistry } from "../../support/registry.ts";
import { agentDoor, enrolDevice, required } from "./guard-device.ts";
import { withHosted } from "./server-options.ts";

type Json = Record<string, any>;

const json = (reply: ConsoleReply): Json => reply.body as Json;

const baseEnv: NodeJS.ProcessEnv = {
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "http://localhost:4700",
  REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
  REGISTRY_GATE_SIGNING_SECRET: "guard-tests-gate-secret-0123456789abcdef0123456",
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  NODE_ENV: "test",
};

const cardRule = { name: "Payment card numbers", detector: { kind: "card-number" }, action: "block", enabled: true };

describe("GUARD_QUICK_START=1: a new organisation opens in Enforce with the starter rules", () => {
  let registry: TestRegistry;

  beforeAll(async () => {
    registry = await startRegistry({ domain: "quick-start.example", configure: withHosted((hosted) => ({ ...hosted, guardQuickStart: true })) });
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("shows Enforce and the card rule in the console, ships both in the device bundle, and blocks a test card number", async () => {
    const { owner } = registry.people;
    const rules = await registry.consoleGet(owner, "/guard/rules");
    expect(rules.status, rules.text).toBe(200);
    expect(json(rules).clientMode).toBe("enforce");
    expect(json(rules).document.contentRules).toContainEqual(expect.objectContaining(cardRule));
    const settings = await registry.consoleGet(owner, "/guard/settings");
    expect(json(settings).settings.clientMode).toBe("enforce");

    const laptop = await enrolDevice(registry, owner, owner, "quick-start-mac");
    expect(laptop.enrol.clientMode).toBe("enforce");
    const download = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
    expect(download.status, download.text).toBe(200);
    const bundle = required(GuardRuleDownloadResponse.parse(download.body).bundle, "a bundle on a first download").bundle;
    expect(bundle.clientMode).toBe("enforce");
    expect(bundle.contentRules).toContainEqual(expect.objectContaining({ name: "Payment card numbers", action: "block" }));

    const again = await agentDoor(registry, "POST", `/ruledownload/${laptop.deviceId}`, laptop.token, { protocol: GUARD_PROTOCOL_VERSION });
    const ruleIds = (b: { contentRules: Array<{ ruleId: string }> }) => b.contentRules.map((r) => r.ruleId);
    expect(ruleIds(required(GuardRuleDownloadResponse.parse(again.body).bundle, "a second bundle").bundle)).toEqual(ruleIds(bundle));

    const test = await registry.consoleWrite(owner, "POST", "/guard/rules/test", { serviceId: "openai-chatgpt", text: "4111 1111 1111 1111" });
    expect(test.status, test.text).toBe(200);
    expect(json(test)).toMatchObject({ verdict: "blocked", enforced: true });
  });

  it("lets the saved settings and rules win over the flag", async () => {
    const { owner } = registry.people;
    const saved = await registry.consoleWrite(owner, "PUT", "/guard/settings", { clientMode: "monitor" });
    expect(saved.status, saved.text).toBe(200);
    expect(json(await registry.consoleGet(owner, "/guard/rules")).clientMode).toBe("monitor");
    expect(json(await registry.consoleGet(owner, "/guard/settings")).settings.clientMode).toBe("monitor");

    const { version: _version, ...shown } = json(await registry.consoleGet(owner, "/guard/rules")).document;
    const edited = { ...shown, contentRules: shown.contentRules.map((rule: Json) => (rule.name === "Tax file numbers" ? { ...rule, enabled: false } : rule)) };
    const kept = await registry.consoleWrite(owner, "PUT", "/guard/rules", { baseVersion: 0, document: edited });
    expect(kept.status, kept.text).toBe(200);
    expect(json(kept).document.version).toBe(1);
    expect(json(kept).document.contentRules.map((rule: Json) => rule.ruleId)).toEqual(shown.contentRules.map((rule: Json) => rule.ruleId));
    expect(json(kept).document.contentRules.find((rule: Json) => rule.name === "Tax file numbers").enabled).toBe(false);

    const put = await registry.consoleWrite(owner, "PUT", "/guard/rules", { baseVersion: 1, document: { defaultAction: "allow", serviceRules: [], contentRules: [] } });
    expect(put.status, put.text).toBe(200);
    expect(json(await registry.consoleGet(owner, "/guard/rules")).document).toMatchObject({ version: 2, contentRules: [] });
  });
});

describe("without GUARD_QUICK_START: a new organisation stays in Monitor with no rules", () => {
  it("shows Monitor and an empty rule set", async () => {
    const registry = await startRegistry({ domain: "company.example" });
    try {
      const rules = await registry.consoleGet(registry.people.owner, "/guard/rules");
      expect(rules.status, rules.text).toBe(200);
      expect(json(rules)).toMatchObject({ clientMode: "monitor", document: { version: 0, contentRules: [] } });
      expect(json(await registry.consoleGet(registry.people.owner, "/guard/settings")).settings.clientMode).toBe("monitor");
    } finally {
      await registry.close();
    }
  });
});

describe("GUARD_QUICK_START in the environment", () => {
  it("turns on only for 1, stays off when empty or unset, and refuses anything else at boot", () => {
    expect(loadRegistryConfig({ ...baseEnv, GUARD_QUICK_START: "1" }).hosted?.guardQuickStart).toBe(true);
    expect(loadRegistryConfig({ ...baseEnv, GUARD_QUICK_START: "" }).hosted?.guardQuickStart).toBeFalsy();
    expect(loadRegistryConfig(baseEnv).hosted?.guardQuickStart).toBeFalsy();
    for (const bad of ["yes", "true", "0", "on", " 2 "]) {
      expect(() => loadRegistryConfig({ ...baseEnv, GUARD_QUICK_START: bad })).toThrow("GUARD_QUICK_START must be 1 or empty");
    }
  });
});

describe("GUARD_NO_PEOPLE_LIMIT in the environment", () => {
  const joinEight = async (registry: TestRegistry): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await registry.join(`person${i}`, "people-limit.example");
  };

  it("lets a Free organisation grow past its people limit only when it is on", async () => {
    const capped = await startRegistry({ domain: "people-limit.example" });
    try {
      await expect(joinEight(capped)).rejects.toThrow(/MEMBER_LIMIT/);
    } finally {
      await capped.close();
    }
    const uncapped = await startRegistry({ domain: "people-limit.example", configure: withHosted((hosted) => ({ ...hosted, noPeopleLimit: true })) });
    try {
      await expect(joinEight(uncapped)).resolves.toBeUndefined();
    } finally {
      await uncapped.close();
    }
  });

  it("turns on only for 1, stays off when empty or unset, and refuses anything else at boot", () => {
    expect(loadRegistryConfig({ ...baseEnv, GUARD_NO_PEOPLE_LIMIT: "1" }).hosted?.noPeopleLimit).toBe(true);
    expect(loadRegistryConfig({ ...baseEnv, GUARD_NO_PEOPLE_LIMIT: "" }).hosted?.noPeopleLimit).toBeFalsy();
    expect(loadRegistryConfig(baseEnv).hosted?.noPeopleLimit).toBeFalsy();
    for (const bad of ["yes", "true", "0"]) {
      expect(() => loadRegistryConfig({ ...baseEnv, GUARD_NO_PEOPLE_LIMIT: bad })).toThrow("GUARD_NO_PEOPLE_LIMIT must be 1 or empty");
    }
  });

  it("is set by the self-hosted Compose file and not by the Vibtra Cloud stack", async () => {
    const read = (rel: string): Promise<string> => readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
    expect(await read("apps/registry/docker-compose.yml")).toContain('GUARD_NO_PEOPLE_LIMIT: "1"');
    expect(await read("infra/lib/registry-stack.ts")).not.toContain("GUARD_NO_PEOPLE_LIMIT");
  });
});
