import { describe, expect, it } from "vitest";
import {
  CONSOLE_RESPONSE_SCHEMAS,
  ConsoleAllowlistAddition,
  ConsoleAllowlistRow,
  ConsoleRegistrationNotice,
  ConsoleRegistrationPage,
  ConsoleSession,
  REGISTRATION_NOTICE_PATH,
} from "@vibtra/console-api";

const row = {
  id: "al_1",
  subject: "ada@acme.example",
  kind: "email" as const,
  addedBy: "operator@example.test",
  addedAt: "2026-09-24T00:00:00.000Z",
};

describe("the sign-ups doors are in the contract", () => {
  it("declares the three operator doors, answering the whole page", () => {
    expect(CONSOLE_RESPONSE_SCHEMAS["GET /registration"]).toBe(ConsoleRegistrationPage);
    expect(CONSOLE_RESPONSE_SCHEMAS["POST /registration/allowlist"]).toBe(ConsoleRegistrationPage);
    expect(CONSOLE_RESPONSE_SCHEMAS["DELETE /registration/allowlist/:id"]).toBe(ConsoleRegistrationPage);
  });

  it("keeps the public notice outside the console map and free of rows", () => {
    expect(REGISTRATION_NOTICE_PATH).toBe("/auth/registration");
    expect(Object.keys(CONSOLE_RESPONSE_SCHEMAS).some((k) => k.includes("/auth/registration"))).toBe(false);
    expect(ConsoleRegistrationNotice.parse({ mode: "open" })).toEqual({ mode: "open" });
    expect(ConsoleRegistrationNotice.parse({ mode: "allowlist", contactEmail: "operator@example.test" }).contactEmail).toBe(
      "operator@example.test",
    );
    expect(ConsoleRegistrationNotice.safeParse({ mode: "allowlist", rows: [row] }).success).toBe(true);
    expect(ConsoleRegistrationNotice.parse({ mode: "allowlist", rows: [row] })).not.toHaveProperty("rows");
    expect(ConsoleRegistrationNotice.safeParse({ mode: "invite_only" }).success).toBe(false);
  });

  it("parses a page and an addition, and refuses an empty subject", () => {
    const page = ConsoleRegistrationPage.parse({ mode: "allowlist", rows: [row, { ...row, id: "al_2", subject: "acme.example", kind: "domain", note: "Forum post, 24 Sep" }], mayManage: true });
    expect(page.rows).toHaveLength(2);
    expect(ConsoleAllowlistRow.safeParse({ ...row, kind: "person" }).success).toBe(false);
    expect(ConsoleAllowlistAddition.parse({ subject: "  Ada@Acme.Example " }).subject).toBe("Ada@Acme.Example");
    expect(ConsoleAllowlistAddition.safeParse({ subject: "   " }).success).toBe(false);
  });

  it("lets a session say it operates the registry, additively", () => {
    const base = { email: "operator@example.test", issuer: "https://idp.example.test", orgId: "o1", orgName: "Example Org", handle: "example-org", role: "admin" as const, usage: { plan: "free", users: 1, userLimit: 5 } };
    const parsedWithout = ConsoleSession.safeParse(base);
    if (!parsedWithout.success) throw new Error("the base session fixture must parse; adjust the fixture to ConsoleUsage");
    expect(parsedWithout.data.operator).toBeUndefined();
    expect(ConsoleSession.parse({ ...base, operator: true }).operator).toBe(true);
  });
});
