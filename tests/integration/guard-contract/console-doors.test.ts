import { describe, expect, it } from "vitest";
import { GUARD_CONSOLE_RESPONSE_SCHEMAS, GUARD_NON_SECRET_FIELDS, GUARD_STAFF_NOTICE_TEMPLATE, GuardDeviceRow, GuardRuleTestInput, GuardRulesUpdate, renderStaffNotice } from "@vibtra/guard-contract";
import { bannedFields } from "./support.js";

describe("the Guard console doors", () => {
  it("declare no field a credential or content could travel in, except the one named enrol token", () => {
    const allowed = new Set(GUARD_NON_SECRET_FIELDS.map((e) => `${e.door} ${e.field}`));
    for (const [door, schema] of Object.entries(GUARD_CONSOLE_RESPONSE_SCHEMAS)) {
      expect(bannedFields(schema).filter((field) => !allowed.has(`${door} ${field}`)), door).toEqual([]);
    }
    expect(GUARD_NON_SECRET_FIELDS).toHaveLength(1);
    expect(bannedFields(GUARD_CONSOLE_RESPONSE_SCHEMAS["POST /guard/devices/enrol-links"])).toEqual(["token"]);
  });

  it("PUT /rules takes a base version and rows without ids; the test box takes a service or a host", () => {
    expect(
      GuardRulesUpdate.safeParse({ baseVersion: 2, document: { defaultAction: "allow", serviceRules: [{ serviceId: "*", audience: { kind: "org" }, action: "block" }], contentRules: [] } }).success,
    ).toBe(true);
    expect(GuardRulesUpdate.safeParse({ document: { serviceRules: [], contentRules: [] } }).success).toBe(false);
    expect(GuardRuleTestInput.safeParse({ text: "x" }).success).toBe(false);
    expect(GuardRuleTestInput.safeParse({ host: "chatgpt.com", text: "x" }).success).toBe(true);
    expect(GuardRuleTestInput.safeParse({ serviceId: "openai-chatgpt", text: "x" }).success).toBe(true);
  });

  it("a device row may say whether the Mac intercepts, with a reason exactly when it does not", () => {
    const row = {
      deviceId: "gdev_0123456789abcdef",
      hostname: "made-up-mbp",
      osVersion: "15.1",
      agentVersion: "1.0.0",
      person: { userId: "usr_made_up", email: "ada@example.com" },
      status: "active",
      clientMode: "monitor",
      enrolledAt: "2026-11-06T00:00:00.000Z",
      quiet: false,
      eventsLast24h: 0,
    };
    const withInterception = (interception: unknown) => GuardDeviceRow.safeParse({ ...row, health: { caTrusted: true, interception } });
    expect(GuardDeviceRow.safeParse(row).success).toBe(true);
    expect(withInterception({ on: true }).success).toBe(true);
    expect(withInterception({ on: false, reason: "no-secure-enclave" }).data?.health?.interception).toEqual({ on: false, reason: "no-secure-enclave" });
    for (const interception of [{ on: false }, { on: true, reason: "awaiting-trust" }, { on: false, reason: "made-up" }, { on: false, reason: "key-unavailable", detail: "made-up" }]) {
      expect(withInterception(interception).success, JSON.stringify(interception)).toBe(false);
    }
  });
});

describe("the staff notice", () => {
  it("fills what it knows, leaves the rest visible, and says what it does not read", () => {
    const out = renderStaffNotice(GUARD_STAFF_NOTICE_TEMPLATE, { orgName: "Fernwood", contact: "it@fernwood.example" });
    expect(out).toContain("Fernwood uses Vibtra Guard");
    expect(out).toContain("{{startDate}}");
    expect(out).not.toContain("{{contact}}");
    expect(out).toContain("Questions: it@fernwood.example");
    expect(out).toContain("does not read or keep the content");
  });
});
