import { describe, expect, it } from "vitest";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import { applyOrgPlan, planOrgForSignIn, type ClaimContext } from "@vibtra/registry/src/tenancy/claim.ts";
import { startRegistry } from "../../support/registry.ts";
import { withHosted } from "./server-options.ts";

type Json = Record<string, any>;

const baseEnv: NodeJS.ProcessEnv = {
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "http://localhost:4700",
  REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
  REGISTRY_GATE_SIGNING_SECRET: "guard-tests-gate-secret-0123456789abcdef0123456",
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  NODE_ENV: "test",
};

describe("REGISTRY_OWNER_EMAIL: the self-host owner on a personal mailbox", () => {
  it("reads one normalised address and refuses anything else", () => {
    expect(loadRegistryConfig({ ...baseEnv, REGISTRY_OWNER_EMAIL: " Founder.Name@Gmail.com " }).hosted?.ownerEmail).toBe("founder.name@gmail.com");
    expect(loadRegistryConfig(baseEnv).hosted?.ownerEmail).toBeUndefined();
    for (const bad of ["founder", "a@b@gmail.com", "founder@gmail", "two words@gmail.com"]) {
      expect(() => loadRegistryConfig({ ...baseEnv, REGISTRY_OWNER_EMAIL: bad })).toThrow("REGISTRY_OWNER_EMAIL must be one email address");
    }
  });

  it("lets only that address create an organisation from a public mail domain, with no domain claim", async () => {
    const registry = await startRegistry({
      domain: "acme.example",
      configure: withHosted((hosted) => ({
        ...hosted,
        registration: { mode: "allowlist", operatorDomain: "acme.example" },
        ownerEmail: "founder.name@gmail.com",
      })),
    });
    try {
      const founder = await registry.join("founder.name", "gmail.com");
      const session = await registry.consoleGet(founder, "/session");
      expect(session.status, session.text).toBe(200);
      expect(session.body).toMatchObject({ handle: "founder-name", orgRole: "owner", role: "admin" });

      const ownerSession = (await registry.consoleGet(registry.people.owner, "/session")).body as Json;
      expect(ownerSession.handle).not.toBe("founder-name");

      await expect(registry.join("stranger", "gmail.com")).rejects.toThrow(/personal mailbox|sign-up/);
      await expect(registry.join("outsider", "elsewhere.example")).rejects.toThrow(/invitation/);

      const link = await registry.consoleWrite(founder, "POST", "/guard/devices/enrol-links", { personEmail: founder.email, note: "owner mailbox" });
      expect(link.status, link.text).toBe(201);
    } finally {
      await registry.close();
    }
  });

  it("changes nothing when it is not set: personal mailboxes stay refused", async () => {
    const registry = await startRegistry({ domain: "acme.example" });
    try {
      await expect(registry.join("founder.name", "gmail.com")).rejects.toThrow(/personal mailbox/);
    } finally {
      await registry.close();
    }
  });

  it("makes a new owner address the owner of its own organisation when its handle is already taken", async () => {
    const orgs: { id: string; slug: string }[] = [{ id: "org-old", slug: "a-b" }];
    const roles: { orgId: string; userId: string; role: string }[] = [{ orgId: "org-old", userId: "old-owner", role: "owner" }];
    const ctx = {
      ownerEmail: "a-b@gmail.com",
      orgs: { createOrg: async () => undefined },
      members: {
        findOrgBySlug: async (slug: string) => orgs.find((o) => o.slug === slug),
        createOrg: async ({ slug }: { slug: string }) => {
          const org = { id: `org-${orgs.length}`, slug };
          orgs.push(org);
          return org;
        },
        addMember: async (row: { orgId: string; userId: string; role: string }) => {
          roles.push(row);
        },
      },
    } as unknown as ClaimContext;
    const plan = await planOrgForSignIn(ctx, { email: "a-b@gmail.com", emailVerified: true });
    expect(plan).toMatchObject({ kind: "create", slug: "a-b" });
    if (plan.kind === "none") throw new Error(plan.reason);
    const outcome = await applyOrgPlan(ctx, plan, "new-owner", "a-b@gmail.com");
    expect(outcome).toMatchObject({ role: "owner", createdOrg: true });
    expect(orgs.find((o) => o.id === outcome.orgId)?.slug).toBe("a-b-2");
    expect(roles.filter((r) => r.orgId === "org-old")).toEqual([{ orgId: "org-old", userId: "old-owner", role: "owner" }]);
  });
});
