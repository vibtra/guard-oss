import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONSOLE_API_PREFIX, CSRF_HEADER } from "@vibtra/console-api";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { postgresMissing } from "./server-options.ts";

const ONE_MIB = 1024 * 1024;

const FALLBACK_LANDING_SHA256 = "20c32a00c86f2dd1146296b06b46398a841a2a580a4f91b353199f666c47ce3d";

const BODY_TOO_LARGE = {
  code: "VALIDATION",
  message: "That request body is too large for this door",
  detail:
    "the body was refused at the parser, before the handler ran — nothing was read, nothing was built and nothing was sent. " +
    "POST /v1/deploys accepts a bundle up to 52428800 bytes; every other door on this registry accepts 1 MiB.",
};

const TRIPWIRE = {
  code: "INTERNAL",
  message: "Refusing to send this response",
  detail:
    "the response body contained a sealed vault envelope — the vault ciphertext tripwire blocked it; " +
    "this is a bug in the registry, not in your request",
};

const renameOrg = (registry: TestRegistry, person: Person, name: string, acceptEncoding: string) =>
  fetch(`${registry.url}${CONSOLE_API_PREFIX}/org/name`, {
    method: "POST",
    headers: {
      cookie: person.cookie,
      origin: REGISTRY_ORIGIN,
      [CSRF_HEADER]: person.csrf,
      "content-type": "application/json",
      "accept-encoding": acceptEncoding,
    },
    body: JSON.stringify({ name }),
  });

const sessionOf = (registry: TestRegistry, person: Person) =>
  fetch(`${registry.url}${CONSOLE_API_PREFIX}/session`, { headers: { cookie: person.cookie, "accept-encoding": "identity" } });

describe("the registry server's global wiring", () => {
  let registry: TestRegistry;

  beforeAll(async () => {
    registry = await startRegistry({ domain: "server-wiring.example" });
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("refuses to send a response that carries a sealed vault envelope, and answers again once the envelope is gone", async () => {
    const { owner } = registry.people;
    for (const sealed of ["vault.v1.server-wiring-probe", "bao.v1.server-wiring-probe"]) {
      for (const encoding of ["identity", "gzip"]) {
        const renamed = await renameOrg(registry, owner, sealed, encoding);
        expect(renamed.status, `${sealed} ${encoding}`).toBe(500);
        expect(renamed.headers.get("content-type")).toContain("application/json");
        expect(await renamed.json(), `${sealed} ${encoding}`).toEqual(TRIPWIRE);
      }
      const session = await sessionOf(registry, owner);
      expect(session.status, sealed).toBe(500);
      expect(await session.json(), sealed).toEqual(TRIPWIRE);
    }
    const restored = await renameOrg(registry, owner, "Server Wiring", "identity");
    expect(restored.status, await restored.clone().text()).toBe(200);
    expect(await restored.text()).toContain('"Server Wiring"');
    expect((await sessionOf(registry, owner)).status).toBe(200);
  });

  it("answers 404 for Better Auth's OAuth provider, discovery and JWKS paths, which are not on the Guard allow-list", async () => {
    for (const [method, pathname] of [
      ["GET", "/api/auth/oauth2/authorize?client_id=probe&response_type=code"],
      ["POST", "/api/auth/oauth2/token"],
      ["POST", "/api/auth/oauth2/register"],
      ["GET", "/api/auth/oauth2/userinfo"],
      ["GET", "/api/auth/admin/oauth2/clients"],
      ["GET", "/api/auth/.well-known/openid-configuration"],
      ["GET", "/api/auth/.well-known/oauth-authorization-server"],
      ["GET", "/api/auth/jwks"],
    ] as const) {
      const response = await fetch(`${registry.url}${pathname}`, {
        method,
        headers: { origin: REGISTRY_ORIGIN, ...(method === "POST" ? { "content-type": "application/json" } : {}) },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status, pathname).toBe(404);
      expect(response.headers.get("cache-control"), pathname).toBe("no-store");
      expect(await response.json(), pathname).toEqual({ error: "Not part of Guard" });
    }
  });

  it("parses an application/octet-stream or application/gzip body as raw bytes, so a Guard door validates it rather than refusing the media type", async () => {
    for (const contentType of ["application/octet-stream", "application/gzip"]) {
      const response = await fetch(`${registry.url}/api/guard/v1/enrol`, {
        method: "POST",
        headers: { "content-type": contentType },
        body: "a=b",
      });
      expect(response.status, contentType).toBe(400);
      expect(await response.json(), contentType).toMatchObject({ code: "VALIDATION", message: "Send { protocol, enrolToken, device, ca }" });
    }
  });

  it("refuses a body over 1 MiB at the parser with a 413 and the registry's own sentence", async () => {
    for (const [contentType, payload] of [
      ["application/json", JSON.stringify({ pad: "x".repeat(ONE_MIB) })],
      ["application/octet-stream", "x".repeat(ONE_MIB + 1)],
    ] as const) {
      const response = await registry.server.app.inject({
        method: "POST",
        url: "/api/guard/v1/enrol",
        headers: { "content-type": contentType },
        payload,
      });
      expect(response.statusCode, contentType).toBe(413);
      expect(response.json(), contentType).toEqual(BODY_TOO_LARGE);
    }
  });

  it("serves the fallback landing page byte for byte when no landing build is present", async () => {
    const response = await fetch(`${registry.url}/`, { headers: { "accept-encoding": "identity" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const page = await response.text();
    expect(page).toContain("<style>");
    expect(createHash("sha256").update(page, "utf8").digest("hex")).toBe(FALLBACK_LANDING_SHA256);
  });
});

describe("sign-up and the free budget (Postgres)", () => {
  it("creates a new organisation waitlisted once the month's free budget is 90% used, and active before that", async (context) => {
    if (postgresMissing()) {
      context.skip();
      return;
    }
    const registry = await startRegistry({ domain: "free-budget.example" });
    try {
      const tenancy = registry.server.service.tenancy;
      const metering = registry.server.service.metering;
      if (tenancy === undefined || metering === undefined) throw new Error("the hosted registry built no tenancy or metering store");

      const before = await registry.join("early", "before-budget.example");
      const early = await tenancy.findOrgByDomain("before-budget.example");
      expect(early?.status).toBe("active");
      expect(before.email).toBe("early@before-budget.example");

      const now = new Date();
      const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      await metering.upsertPeriod({
        orgId: "org_free_budget_probe",
        meter: "session",
        periodStart: monthStart.toISOString(),
        periodEnd: monthEnd.toISOString(),
        plan: "free",
        includedMinutes: null,
        usedMinutes: 2000 * 60,
        reportedOverageMinutes: 0,
        state: "open",
        updatedAt: now.toISOString(),
      });

      const after = await registry.join("late", "after-budget.example");
      expect(after.email).toBe("late@after-budget.example");
      const late = await tenancy.findOrgByDomain("after-budget.example");
      expect(late?.status).toBe("waitlisted");
      expect((await tenancy.findOrgByDomain("before-budget.example"))?.status).toBe("active");
    } finally {
      await registry.close();
    }
  });
});
