import { describe, expect, it } from "vitest";
import {
  BANNED_FIELD_FRAGMENTS,
  CONSOLE_RESPONSE_SCHEMAS,
  ConsoleSsoDomainBinding,
  ConsoleSsoPage,
  ConsoleSsoProviderRow,
  ConsoleSsoRegistration,
  ConsoleSsoTestResult,
  isBannedFieldName,
  SSO_SIGN_IN_PATH,
} from "@vibtra/console-api";
import { fieldNamesOf } from "./field-names.js";

const row = {
  providerId: "sso-acme-example",
  kind: "oidc" as const,
  issuer: "https://idp.example.test/oauth2/default",
  domain: "acme.example",
  redirectUri: "https://registry.example/api/auth/sso/callback/sso-acme-example",
  createdAt: "2026-09-04T00:00:00.000Z",
};

describe("the SSO doors are in the contract, and are covered by its guarantees", () => {
  it("declares all five doors", () => {
    for (const door of [
      "GET /sso",
      "POST /sso",
      "DELETE /sso/:id",
      "POST /sso/:id/test",
      "POST /sso/domains",
    ] as const) {
      expect(CONSOLE_RESPONSE_SCHEMAS[door], door).toBeDefined();
    }
  });

  it("has no field a credential could travel in, on any of them", () => {
    const keys = new Set([ConsoleSsoPage, ConsoleSsoProviderRow, ConsoleSsoTestResult].flatMap((schema) => fieldNamesOf(schema)));
    expect(keys.size).toBeGreaterThan(10);
    expect([...keys].filter((key) => isBannedFieldName(key))).toEqual([]);
    expect(isBannedFieldName("clientSecret")).toBe(true);
    expect(BANNED_FIELD_FRAGMENTS).toContain("secret");
  });
});

describe("the registration", () => {
  it("takes an issuer, a client id and a secret — and nothing else", () => {
    const parsed = ConsoleSsoRegistration.parse({
      issuer: "https://idp.example.test/oauth2/default",
      clientId: "0oaFAKEclientid1234",
      clientSecret: "this is not a real client secret it is a sentence",
    });
    expect(Object.keys(parsed).sort()).toEqual(["clientId", "clientSecret", "issuer"]);
  });

  it("has NO `domain` and NO `providerId` — both are the registry's to decide", () => {
    const parsed = ConsoleSsoRegistration.parse({
      issuer: "https://idp.example",
      clientId: "id",
      clientSecret: "s",
      domain: "victim.example",
      providerId: "sso-victim-example",
      organizationId: "org_someone_else",
    }) as Record<string, unknown>;
    expect(parsed["domain"]).toBeUndefined();
    expect(parsed["providerId"]).toBeUndefined();
    expect(parsed["organizationId"]).toBeUndefined();
  });

  it("refuses an issuer that is not a URL", () => {
    expect(
      ConsoleSsoRegistration.safeParse({ issuer: "idp.example.test", clientId: "a", clientSecret: "b" })
        .success,
    ).toBe(false);
  });

  it("refuses an http issuer — the client secret would cross in the clear", () => {
    for (const issuer of ["http://idp.example", "HTTP://idp.example", "ftp://idp.example"]) {
      const result = ConsoleSsoRegistration.safeParse({ issuer, clientId: "a", clientSecret: "b" });
      expect(result.success, issuer).toBe(false);
    }
    expect(
      ConsoleSsoRegistration.safeParse({
        issuer: "https://idp.example",
        discoveryEndpoint: "http://idp.example/.well-known/openid-configuration",
        clientId: "a",
        clientSecret: "b",
      }).success,
    ).toBe(false);
  });

  it("refuses a URL carrying a credential of its own, which the row would echo", () => {
    expect(
      ConsoleSsoRegistration.safeParse({
        issuer: "https://someone:a-secret-sentence@idp.example",
        clientId: "a",
        clientSecret: "b",
      }).success,
    ).toBe(false);
  });
});

describe("the page and the probe", () => {
  it("parses a page with one provider", () => {
    const page = ConsoleSsoPage.parse({ rows: [row], mayManage: true, orgDomain: "acme.example" });
    expect(page.rows[0]?.providerId).toBe("sso-acme-example");
    expect(page.rows[0]?.kind).toBe("oidc");
  });

  it("parses the honest empty — no domain, no planned URI, one sentence", () => {
    const page = ConsoleSsoPage.parse({
      rows: [],
      mayManage: true,
      notYet: "This organisation has no email domain of its own.",
    });
    expect(page.orgDomain).toBeUndefined();
    expect(page.plannedRedirectUri).toBeUndefined();
    expect(page.notYet).toBeTruthy();
  });

  it("carries a discovery refusal as a code and a sentence", () => {
    const probe = ConsoleSsoTestResult.parse({
      reachable: false,
      refusal: { code: "issuer_mismatch", message: "Discovered issuer does not match" },
    });
    expect(probe.reachable).toBe(false);
    expect(probe.refusal?.code).toBe("issuer_mismatch");
  });

  it("names Better Auth's own sign-in path once, so nothing types it twice", () => {
    expect(SSO_SIGN_IN_PATH).toBe("/sign-in/sso");
  });
});

describe("the sub-domain binding request", () => {
  it("trims and lower-cases, so the door compares one spelling", () => {
    expect(ConsoleSsoDomainBinding.parse({ domain: "  EU.Acme.Example " })).toEqual({
      domain: "eu.acme.example",
    });
  });

  it("refuses what people actually paste into a domain box", () => {
    for (const bad of [
      "https://eu.acme.example",
      "ada@eu.acme.example",
      "eu.acme.example/path",
      "localhost",
      "-eu.acme.example",
      "eu-.acme.example",
      "",
    ]) {
      expect(ConsoleSsoDomainBinding.safeParse({ domain: bad }).success, bad).toBe(false);
    }
  });

  it("has exactly one field — the provider is the registry's to know", () => {
    expect(Object.keys(ConsoleSsoDomainBinding.shape)).toEqual(["domain"]);
  });
});
