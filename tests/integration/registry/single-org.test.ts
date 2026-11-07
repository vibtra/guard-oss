import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { loadRegistryConfig } from "@vibtra/registry/src/config.ts";
import { applyOrgPlan, planOrgForSignIn, type ClaimContext } from "@vibtra/registry/src/tenancy/claim.ts";
import { REGISTRY_ORIGIN, startRegistry } from "../../support/registry.ts";
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

const singleOrg = withHosted((hosted) => ({ ...hosted, singleOrg: true }));

describe("GUARD_MULTI_ORG=0: a server with one organisation", () => {
  it("refuses a sign-in that would create a second organisation, and creates nothing", async () => {
    const registry = await startRegistry({ domain: "acme.example", configure: singleOrg });
    try {
      await expect(registry.join("outsider", "elsewhere.example")).rejects.toThrow(/one organisation.*nothing was created/s);
      await expect(registry.join("outsider", "elsewhere.example")).rejects.toThrow(/one organisation/);
      const people = await registry.consoleGet(registry.people.owner, "/people");
      expect(people.status, people.text).toBe(200);
      expect(people.text).not.toContain("outsider@elsewhere.example");
    } finally {
      await registry.close();
    }
  });

  it("still lets people join the existing organisation by domain and by invitation", async () => {
    const registry = await startRegistry({ domain: "acme.example", configure: singleOrg });
    try {
      const ownerHandle = ((await registry.consoleGet(registry.people.owner, "/session")).body as Json).handle;
      const colleague = await registry.join("colleague");
      const session = await registry.consoleGet(colleague, "/session");
      expect(session.body).toMatchObject({ handle: ownerHandle, orgRole: "member" });

      const invited = await registry.consoleWrite(registry.people.owner, "POST", "/people/invitations", { email: "guest@elsewhere.example", role: "member" });
      expect(invited.status, invited.text).toBe(200);
      const signUp = await fetch(`${registry.url}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
        body: JSON.stringify({ email: "guest@elsewhere.example", password: "vibtra-test-passphrase-guest", name: "guest" }),
      });
      expect(signUp.ok, await signUp.text()).toBe(true);
    } finally {
      await registry.close();
    }
  });

  it("lets only one of two racing first sign-ins create the organisation", async () => {
    const created: string[] = [];
    const deleted: string[] = [];
    const ctx = {
      singleOrg: { orgExists: async () => created.length > 0 },
      orgs: {
        findOrgByDomain: async () => undefined,
        getOrg: async () => undefined,
        createOrg: async () => undefined,
      },
      members: {
        findOrgBySlug: async () => undefined,
        createOrg: async ({ slug }: { slug: string }) => {
          created.push(slug);
          return { id: `org-${slug}`, slug };
        },
        addMember: async () => undefined,
        deleteUser: async (userId: string) => {
          deleted.push(userId);
        },
      },
    } as unknown as ClaimContext;
    const first = await planOrgForSignIn(ctx, { email: "a@one.example", emailVerified: true });
    const second = await planOrgForSignIn(ctx, { email: "b@two.example", emailVerified: true });
    if (first.kind === "none" || second.kind === "none") throw new Error("both first sign-ins should plan to create");
    const outcomes = await Promise.allSettled([applyOrgPlan(ctx, first, "user-a", "a@one.example"), applyOrgPlan(ctx, second, "user-b", "b@two.example")]);
    expect(created).toEqual(["one.example"]);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: { createdOrg: true, role: "owner" } });
    expect(outcomes[1]).toMatchObject({ status: "rejected", reason: { message: expect.stringMatching(/one organisation/) } });
    expect(deleted).toEqual(["user-b"]);
  });

  it("refuses the REGISTRY_OWNER_EMAIL mailbox and listed domains too once the organisation exists", async () => {
    const registry = await startRegistry({
      domain: "acme.example",
      configure: withHosted((hosted) => ({
        ...hosted,
        singleOrg: true,
        registration: { mode: "allowlist", operatorDomain: "acme.example" },
        ownerEmail: "founder.name@gmail.com",
      })),
    });
    try {
      await expect(registry.join("founder.name", "gmail.com")).rejects.toThrow(/one organisation/);
      await expect(registry.join("outsider", "elsewhere.example")).rejects.toThrow(/one organisation/);
      await expect(registry.join("colleague")).resolves.toMatchObject({ email: "colleague@acme.example" });
    } finally {
      await registry.close();
    }
  });

  it("leaves the allowlist in charge of who creates the first organisation", async () => {
    const ctx = {
      singleOrg: { orgExists: async () => false },
      registration: { mode: "allowlist", operatorDomain: "acme.example", isAllowed: async () => false },
      orgs: { findOrgByDomain: async () => undefined, getOrg: async () => undefined },
      members: {},
    } as unknown as ClaimContext;
    await expect(planOrgForSignIn(ctx, { email: "a@unlisted.example", emailVerified: true })).rejects.toThrow(/onboarding by invitation/);
    await expect(planOrgForSignIn(ctx, { email: "a@acme.example", emailVerified: true })).resolves.toMatchObject({ kind: "create", domain: "acme.example" });
  });
});

describe("GUARD_MULTI_ORG unset: today's behaviour", () => {
  it("creates a new organisation for a sign-in from a domain no organisation claims", async () => {
    const registry = await startRegistry({ domain: "acme.example" });
    try {
      const outsider = await registry.join("outsider", "elsewhere.example");
      expect((await registry.consoleGet(outsider, "/session")).body).toMatchObject({ orgRole: "owner" });
    } finally {
      await registry.close();
    }
  });
});

describe("GUARD_MULTI_ORG in the environment", () => {
  it("is single-org only for 0, multi-org for 1, empty or unset, and refuses anything else at boot", () => {
    expect(loadRegistryConfig({ ...baseEnv, GUARD_MULTI_ORG: "0" }).hosted?.singleOrg).toBe(true);
    expect(loadRegistryConfig({ ...baseEnv, GUARD_MULTI_ORG: "1" }).hosted?.singleOrg).toBeFalsy();
    expect(loadRegistryConfig({ ...baseEnv, GUARD_MULTI_ORG: "" }).hosted?.singleOrg).toBeFalsy();
    expect(loadRegistryConfig(baseEnv).hosted?.singleOrg).toBeFalsy();
    for (const bad of ["yes", "true", "false", "2", " 0"]) {
      expect(() => loadRegistryConfig({ ...baseEnv, GUARD_MULTI_ORG: bad })).toThrow("GUARD_MULTI_ORG must be 1, 0 or empty");
    }
  });

  it("is single-org in the self-hosted Compose file and untouched by the Vibtra Cloud stack", async () => {
    const read = (rel: string): Promise<string> => readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
    expect(await read("apps/registry/docker-compose.yml")).toContain("GUARD_MULTI_ORG: ${GUARD_MULTI_ORG:-0}");
    expect(await read("apps/registry/self-host.env.example")).toMatch(/^GUARD_MULTI_ORG=0$/m);
    expect(await read("infra/lib/registry-stack.ts")).not.toContain("GUARD_MULTI_ORG");
  });
});
