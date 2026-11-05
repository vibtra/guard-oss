import { GUARD_STARTER_CONTENT_RULES, GuardActivityPage, type GuardClientMode, type GuardEventRow } from "@vibtra/guard-contract";
import type { TestRegistry } from "./registry.ts";

export interface GuardActivity {
  readonly rows: readonly GuardEventRow[];
  readonly text: string;
}

export const applyStarterPolicy = async (registry: TestRegistry, clientMode: GuardClientMode = "enforce"): Promise<void> => {
  const admin = registry.people.admin;
  const settings = await registry.consoleWrite(admin, "PUT", "/guard/settings", { clientMode });
  if (settings.status !== 200) throw new Error(`Guard settings answered ${settings.status}: ${settings.text.slice(0, 300)}`);
  const rules = await registry.consoleWrite(admin, "PUT", "/guard/rules", {
    baseVersion: 0,
    document: {
      defaultAction: "allow",
      serviceRules: [],
      contentRules: GUARD_STARTER_CONTENT_RULES.map((rule) => ({ ...rule, services: "*", audience: { kind: "org" }, enabled: true })),
    },
  });
  if (rules.status !== 200) throw new Error(`Guard rules answered ${rules.status}: ${rules.text.slice(0, 300)}`);
};

export const guardActivity = async (registry: TestRegistry, deviceId: string): Promise<GuardActivity> => {
  const reply = await registry.consoleGet(registry.people.admin, `/guard/activity?deviceId=${encodeURIComponent(deviceId)}&limit=200`);
  if (reply.status !== 200) throw new Error(`Guard activity answered ${reply.status}: ${reply.text.slice(0, 300)}`);
  return { rows: GuardActivityPage.parse(reply.body).rows, text: reply.text };
};
