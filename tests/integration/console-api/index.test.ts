import { describe, expect, it } from "vitest";
import {
  BANNED_FIELD_FRAGMENTS,
  CONSOLE_ACCEPT_INVITATION_PATH,
  CONSOLE_API_PREFIX,
  CONSOLE_ASSETS_PREFIX,
  CONSOLE_AUTH_PREFIX,
  CONSOLE_DEV_ORIGINS,
  CONSOLE_INVITE_ROLES,
  CONSOLE_JOIN_POLICIES,
  CONSOLE_LOGIN_PATH,
  CONSOLE_RESPONSE_SCHEMAS,
  ConsoleInvitationCreated,
  ConsoleInviteRole,
  ConsoleJoinPolicy,
  ConsoleOrgNameRequest,
  consolePathFor,
  ConsolePeoplePage,
  ConsolePersonRow,
  ConsoleSession,
  CSRF_COOKIE,
  CSRF_HEADER,
  isReservedOrgHandle,
  LANDING_ASSETS_PREFIX,
  ORG_HANDLE_HEADER,
  ORG_HANDLE_MAX_LENGTH,
  ORG_HANDLE_MIN_LENGTH,
  orgHandleProblem,
  RESERVED_ORG_HANDLES,
  SCIM_BASE_PATH,
} from "@vibtra/console-api";

describe("mount prefixes", () => {
  it("keeps the doors and Better Auth on disjoint prefixes", () => {
    expect(CONSOLE_AUTH_PREFIX.startsWith(CONSOLE_API_PREFIX)).toBe(false);
    expect(CONSOLE_API_PREFIX.startsWith(CONSOLE_AUTH_PREFIX)).toBe(false);
  });

  it("keeps the SCIM door on a prefix of its own, disjoint from both (access-14)", () => {
    for (const other of [CONSOLE_API_PREFIX, CONSOLE_AUTH_PREFIX, CONSOLE_ASSETS_PREFIX]) {
      expect(SCIM_BASE_PATH.startsWith(other)).toBe(false);
      expect(other.startsWith(SCIM_BASE_PATH)).toBe(false);
    }
    expect(SCIM_BASE_PATH.startsWith("/v1")).toBe(false);
  });

  it("keeps every apex prefix pairwise non-prefixing, `/assets` and `/login` included (host-14)", () => {
    const prefixes = [
      CONSOLE_API_PREFIX,
      CONSOLE_AUTH_PREFIX,
      SCIM_BASE_PATH,
      CONSOLE_ASSETS_PREFIX,
      CONSOLE_LOGIN_PATH,
    ];
    for (const a of prefixes) {
      for (const b of prefixes) {
        if (a === b) continue;
        expect(a.startsWith(`${b}/`)).toBe(false);
        expect(a).not.toBe(b);
      }
    }
  });

  it("signs in on the apex, above every handle (host-14)", () => {
    expect(CONSOLE_LOGIN_PATH).toBe("/login");
    expect(isReservedOrgHandle(CONSOLE_LOGIN_PATH.slice(1))).toBe(true);
  });

  it("composes an invitation link under the organisation, not under the doors", () => {
    const href = consolePathFor("acme", `${CONSOLE_ACCEPT_INVITATION_PATH}/inv_1`);
    expect(href).toBe("/acme/accept-invitation/inv_1");
    expect(href.startsWith(CONSOLE_API_PREFIX)).toBe(false);
  });

  it("composes an organisation's own root with no trailing slash", () => {
    expect(consolePathFor("acme")).toBe("/acme");
    expect(consolePathFor("acme", "/")).toBe("/acme");
    expect(consolePathFor("acme", "")).toBe("/acme");
    expect(consolePathFor("acme", "/receipts")).toBe("/acme/receipts");
    expect(consolePathFor("acme", "receipts")).toBe("/acme/receipts");
  });

  it("gives every prefix a leading slash and no trailing one", () => {
    for (const prefix of [
      CONSOLE_API_PREFIX,
      CONSOLE_ASSETS_PREFIX,
      CONSOLE_AUTH_PREFIX,
      CONSOLE_LOGIN_PATH,
      SCIM_BASE_PATH,
    ]) {
      expect(prefix.startsWith("/")).toBe(true);
      expect(prefix.endsWith("/")).toBe(false);
    }
  });

  it("names the org-handle header in lower case and outside every door prefix", () => {
    expect(ORG_HANDLE_HEADER).toBe(ORG_HANDLE_HEADER.toLowerCase());
    expect(ORG_HANDLE_HEADER.startsWith("/")).toBe(false);
  });
});

describe("the org handle grammar (host-14)", () => {
  it("takes GitHub's rule whole: lower-case, digits, single hyphens, no hyphen at either end", () => {
    for (const good of ["acme", "acme-corp", "a1", "x9y", "a".repeat(ORG_HANDLE_MAX_LENGTH)]) {
      expect(orgHandleProblem(good)).toBeUndefined();
    }
    for (const bad of [
      "a",
      "a".repeat(ORG_HANDLE_MAX_LENGTH + 1),
      "Acme",
      "acme_corp",
      "acme.io",
      "-acme",
      "acme-",
      "acme--corp",
      "acme corp",
      "acme/corp",
    ]) {
      expect(orgHandleProblem(bad)).toBeDefined();
    }
  });

  it("refuses every reserved name, with the sentence that says why", () => {
    for (const reserved of RESERVED_ORG_HANDLES) {
      expect(isReservedOrgHandle(reserved)).toBe(true);
      expect(orgHandleProblem(reserved)).toBeDefined();
    }
    expect(isReservedOrgHandle("LOGIN")).toBe(true);
    expect(isReservedOrgHandle(" login ")).toBe(true);
  });

  it("reserves every top-level address the apex serves", () => {
    for (const served of [
      "login",
      "assets",
      "api",
      "oauth2",
      "scim",
      "r",
      "v1",
      "tools",
      "healthz",
      ".well-known",
      "landing",
    ]) {
      expect(RESERVED_ORG_HANDLES).toContain(served);
    }

    expect(LANDING_ASSETS_PREFIX).not.toBe(CONSOLE_ASSETS_PREFIX);
    expect(RESERVED_ORG_HANDLES).toContain(LANDING_ASSETS_PREFIX.slice(1));
    expect(RESERVED_ORG_HANDLES).toContain(CONSOLE_ASSETS_PREFIX.slice(1));
    expect(ORG_HANDLE_MIN_LENGTH).toBeLessThan(ORG_HANDLE_MAX_LENGTH);
  });
});

describe("dev origins", () => {
  it("names only the console dev server, on http, at the strict port", () => {
    expect(CONSOLE_DEV_ORIGINS.length).toBeGreaterThan(0);
    for (const origin of CONSOLE_DEV_ORIGINS) {
      const url = new URL(origin);
      expect(url.protocol).toBe("http:");
      expect(url.port).toBe("5180");
      expect(url.pathname).toBe("/");
      expect(origin).toBe(url.origin);
    }
  });
});

describe("CSRF vocabulary", () => {
  it("keeps the header lowercase, because node hands headers over lowercased", () => {
    expect(CSRF_HEADER).toBe(CSRF_HEADER.toLowerCase());
  });

  it("does not collide with Better Auth's session cookie", () => {
    expect(CSRF_COOKIE).not.toContain("session");
  });
});

describe("banned field fragments", () => {
  it("are all lowercase, because they are compared against a lowercased key", () => {
    for (const fragment of BANNED_FIELD_FRAGMENTS) {
      expect(fragment).toBe(fragment.toLowerCase());
      expect(fragment).not.toBe("");
    }
  });

  it("covers the credential vocabulary this repo actually uses", () => {
    for (const required of ["secret", "credential", "sealed", "ciphertext", "password"]) {
      expect(BANNED_FIELD_FRAGMENTS).toContain(required);
    }
  });
});

describe("the session view model", () => {
  const session = {
    email: "ada@example.com",
    issuer: "https://idp.example.test",
    orgId: "org_1",
    orgName: "Example",
    handle: "example",
    role: "admin",
    usage: { plan: "team", users: 2, userLimit: 10 },
  };

  it("accepts the two wire roles and refuses anything else", () => {
    expect(ConsoleSession.safeParse(session).success).toBe(true);
    expect(ConsoleSession.safeParse({ ...session, role: "member" }).success).toBe(true);
    expect(ConsoleSession.safeParse({ ...session, role: "owner" }).success).toBe(false);
  });

  it("refuses a session with no org, because inventing a tenant is the one thing we never do", () => {
    const { orgId: _orgId, ...withoutOrg } = session;
    expect(ConsoleSession.safeParse(withoutOrg).success).toBe(false);
    expect(ConsoleSession.safeParse({ ...session, orgId: "" }).success).toBe(false);
  });

  it("refuses a session with no handle, because the window has to know its own address (host-14)", () => {
    const { handle: _handle, ...withoutHandle } = session;
    expect(ConsoleSession.safeParse(withoutHandle).success).toBe(false);
    expect(ConsoleSession.safeParse({ ...session, handle: "" }).success).toBe(false);
  });

  it("carries the bucket's NAME beside its id, and still parses without one", () => {
    const named = { ...session, usage: { ...session.usage, planName: "Team 100" } };
    expect(ConsoleSession.safeParse(named).success).toBe(true);
    expect(ConsoleSession.safeParse(session).success).toBe(true);
    expect(
      ConsoleSession.safeParse({ ...session, usage: { ...session.usage, planName: "" } }).success,
    ).toBe(false);
    const { plan: _plan, ...noId } = session.usage;
    expect(ConsoleSession.safeParse({ ...session, usage: { ...noId, planName: "Team 100" } }).success).toBe(false);
  });
});

describe("invitable roles", () => {
  it("offers member and admin, least privileged first, and never owner", () => {
    expect([...CONSOLE_INVITE_ROLES]).toEqual(["member", "admin"]);
    expect(ConsoleInviteRole.safeParse("owner").success).toBe(false);
    expect(ConsoleInviteRole.safeParse("member").success).toBe(true);
    expect(ConsoleInviteRole.safeParse("admin").success).toBe(true);
  });
});

describe("a person's display name", () => {
  const person = {
    issuer: "https://registry.test.local",
    subject: "usr_ada",
    email: "ada@acme.example",
    role: "admin" as const,
    createdAt: "2026-09-01T10:00:00.000Z",
  };

  it("is optional, so every row written before account-6 still parses", () => {
    const parsed = ConsolePersonRow.safeParse(person);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.name).toBeUndefined();
    expect(ConsolePersonRow.safeParse({ ...person, name: "Ada Lovelace" }).success).toBe(true);
  });

  it("REFUSES an empty one, because empty is not a name", () => {
    expect(ConsolePersonRow.safeParse({ ...person, name: "" }).success).toBe(false);
  });
});

describe("the organisation's two editable settings", () => {
  it("takes a name of 1 to 64 characters and nothing else", () => {
    expect(ConsoleOrgNameRequest.safeParse({ name: "Acme" }).success).toBe(true);
    expect(ConsoleOrgNameRequest.safeParse({ name: "y".repeat(64) }).success).toBe(true);
    expect(ConsoleOrgNameRequest.safeParse({ name: "y".repeat(65) }).success).toBe(false);
    expect(ConsoleOrgNameRequest.safeParse({ name: "" }).success).toBe(false);
    expect(ConsoleOrgNameRequest.safeParse({ name: "Acme", orgName: "Acme" }).success).toBe(false);
    expect(ConsoleOrgNameRequest.safeParse({ name: "Acme", domain: "acme.example" }).success).toBe(false);
  });

  it("closes the joining setting to exactly two values", () => {
    expect([...CONSOLE_JOIN_POLICIES]).toEqual(["domain", "invite"]);
    expect(ConsoleJoinPolicy.safeParse("domain").success).toBe(true);
    expect(ConsoleJoinPolicy.safeParse("invite").success).toBe(true);
    expect(ConsoleJoinPolicy.safeParse("approval").success).toBe(false);
  });

  it("carries both on the session, optionally, so an older build reads as it did", () => {
    const base = {
      email: "ada@acme.example",
      issuer: "https://registry.test.local",
      orgId: "org_acme",
      orgName: "Acme",
      handle: "acme",
      role: "admin" as const,
      usage: { plan: "team", users: 2, userLimit: 25 },
    };
    const bare = ConsoleSession.safeParse(base);
    expect(bare.success).toBe(true);
    if (!bare.success) return;
    expect(bare.data.orgRole).toBeUndefined();
    expect(bare.data.joinPolicy).toBeUndefined();

    const full = ConsoleSession.parse({ ...base, orgRole: "owner", joinPolicy: "invite" });
    expect(full.orgRole).toBe("owner");
    expect(full.joinPolicy).toBe("invite");
    expect(ConsoleSession.safeParse({ ...base, orgRole: "billing" }).success).toBe(false);
  });
});

describe("the door registry", () => {
  it("names every door as `METHOD /path`, with no duplicates", () => {
    const doors = Object.keys(CONSOLE_RESPONSE_SCHEMAS);
    expect(doors.length).toBeGreaterThan(0);
    expect(new Set(doors).size).toBe(doors.length);
    for (const door of doors) {
      expect(door).toMatch(/^(GET|POST|PATCH|PUT|DELETE) \/[a-z0-9\-/:]*(\?[a-zA-Z0-9=&_-]+)?$/);
    }
  });

  it("puts no door under the auth prefix", () => {
    for (const door of Object.keys(CONSOLE_RESPONSE_SCHEMAS)) {
      expect(door).not.toContain(CONSOLE_AUTH_PREFIX);
    }
  });
});

describe("mail, on the invitation and people contracts", () => {
  const created = { invitationId: "inv_1", email: "auditor@partner.example", role: "member" as const };

  it("`emailed` is optional, so a registry that predates the transport still parses", () => {
    const parsed = ConsoleInvitationCreated.safeParse(created);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.emailed).toBeUndefined();
  });

  it("carries both answers when the door gives one", () => {
    for (const emailed of [true, false]) {
      expect(ConsoleInvitationCreated.parse({ ...created, emailed }).emailed).toBe(emailed);
    }
  });

  it("NEVER carries the link, the key or an address to send from", () => {
    const parsed = ConsoleInvitationCreated.parse({ ...created, emailed: true });
    for (const banned of ["link", "url", "apiKey", "from"]) {
      expect(Object.keys(parsed)).not.toContain(banned);
    }
  });

  it("`mailEnabled` is optional on the people page and absent means off", () => {
    const page = ConsolePeoplePage.safeParse({ rows: [], total: 0 });
    expect(page.success).toBe(true);
    expect(page.success && page.data.mailEnabled).toBeUndefined();
    expect(ConsolePeoplePage.parse({ rows: [], total: 0, mailEnabled: true }).mailEnabled).toBe(true);
  });

  it("the accept-invitation address the mail prints is the console's own, under the handle", () => {
    expect(consolePathFor("acme", `${CONSOLE_ACCEPT_INVITATION_PATH}/inv_1`)).toBe(
      "/acme/accept-invitation/inv_1",
    );
  });
});
