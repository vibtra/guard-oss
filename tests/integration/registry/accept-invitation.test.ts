import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OnboardingPage } from "@vibtra/console-api";
import { SESSION_COOKIE_NAME } from "@vibtra/registry/src/auth/better-auth.ts";
import { GUARD_ACCEPT_INVITATION_ROUTE } from "@vibtra/registry/src/guard/entry-pages.ts";
import { guardAuthRequestAllowed, guardRouteAllowed } from "@vibtra/registry/src/guard/product-boundary.ts";
import type { HostedBillingModule } from "@vibtra/registry/src/hosted-billing.ts";
import { REGISTRY_ORIGIN, startRegistry, type Person, type StartRegistryOptions, type TestRegistry } from "../../support/registry.ts";
import { postgresMissing, withHosted } from "./server-options.ts";

type Json = Record<string, any>;

interface Reply {
  status: number;
  body: Json;
}

interface Invitee {
  email: string;
  userId: string;
  cookie: string;
}

const OVERFLOW_BILLING: HostedBillingModule = {
  create: () => ({
    overflowSeats: true,
    console: { selfServePlanIds: [], billingEnabled: false, planIdForStripePrice: () => undefined },
    registerRoutes: () => undefined,
    registerConsoleRoutes: () => undefined,
  }),
};

const MODES = [
  { name: "file", storage: "file" as const, missing: () => false },
  { name: "Postgres", storage: undefined, missing: postgresMissing },
];

const replyOf = async (response: Response): Promise<Reply> => {
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) as Json };
  } catch {
    return { status: response.status, body: { text } };
  }
};

const sessionCookieOf = (response: Response): string =>
  response.headers
    .getSetCookie()
    .map((line) => line.split(";")[0] ?? "")
    .find((pair) => pair.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";

const BARRIER_WAIT_MS = 5_000;

const lastSeat = (emails: readonly string[]): ((join: { orgId: string; email: string }) => Promise<void>) => {
  const waiting = new Set(emails);
  let release: () => void = () => undefined;
  const everyone = new Promise<void>((resolve) => {
    release = resolve;
    setTimeout(resolve, BARRIER_WAIT_MS).unref();
  });
  return async (join) => {
    if (!waiting.has(join.email)) return;
    waiting.delete(join.email);
    if (waiting.size === 0) release();
    await everyone;
  };
};

const harness = (registry: TestRegistry, inviteDomain: string) => {
  const owner = registry.people.owner;
  const auth = registry.server.auth!;
  const tenancy = registry.server.service.tenancy!;

  const orgIdOf = async (person: Person = owner): Promise<string> => String(((await registry.consoleGet(person, "/session")).body as Json).orgId);

  const invite = async (email: string, role: "member" | "admin" = "member", by: Person = owner): Promise<string> => {
    const invited = await registry.consoleWrite(by, "POST", "/people/invitations", { email, role });
    expect(invited.status, invited.text).toBe(200);
    return String((invited.body as Json).invitationId);
  };

  const signUp = async (name: string, domain = inviteDomain): Promise<Invitee & { status: number; text: string }> => {
    const email = `${name}@${domain}`;
    const res = await fetch(`${registry.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
      body: JSON.stringify({ email, password: `vibtra-test-passphrase-${email}`, name }),
    });
    const text = await res.text();
    const userId = res.ok ? String((JSON.parse(text) as Json).user.id) : "";
    return { email, userId, cookie: sessionCookieOf(res), status: res.status, text };
  };

  const accept = async (invitationId: string, cookie?: string, headers: Record<string, string> = { origin: REGISTRY_ORIGIN }): Promise<Reply> =>
    replyOf(
      await fetch(`${registry.url}/api/onboarding/invitations/${encodeURIComponent(invitationId)}/accept`, {
        method: "POST",
        headers: { ...headers, ...(cookie === undefined ? {} : { cookie }) },
      }),
    );

  const memberRows = async (orgId: string): Promise<Array<{ userId: string; role: string }>> =>
    (await auth.adapter()).findMany<{ userId: string; role: string }>({ model: "member", where: [{ field: "organizationId", value: orgId }] });

  const invitationStatus = async (invitationId: string): Promise<string | undefined> =>
    (await (await auth.adapter()).findOne<{ status: string }>({ model: "invitation", where: [{ field: "id", value: invitationId }] }))?.status;

  const remove = async (userId: string): Promise<void> => {
    const removed = await registry.consoleWrite(owner, "DELETE", `/people/${userId}`);
    expect(removed.status, removed.text).toBe(200);
  };

  const invited = async (name: string, role: "member" | "admin" = "member"): Promise<Invitee & { invitationId: string }> => {
    const invitationId = await invite(`${name}@${inviteDomain}`, role);
    const person = await signUp(name);
    expect(person.status, person.text).toBe(200);
    return { ...person, invitationId };
  };

  const fillTo = async (orgId: string, count: number, tag: string): Promise<string[]> => {
    const added: string[] = [];
    for (let i = 0; (await memberRows(orgId)).length < count; i += 1) {
      const person = await invited(`${tag}${i}`);
      expect((await accept(person.invitationId, person.cookie)).status).toBe(200);
      added.push(person.userId);
    }
    return added;
  };

  return { owner, auth, tenancy, orgIdOf, invite, invited, signUp, accept, memberRows, invitationStatus, remove, fillTo };
};

describe("the accept door at the product boundary", () => {
  it("serves Guard's own accept route and refuses Better Auth's", () => {
    expect(GUARD_ACCEPT_INVITATION_ROUTE).toBe("/api/onboarding/invitations/:invitationId/accept");
    expect(guardRouteAllowed(GUARD_ACCEPT_INVITATION_ROUTE)).toBe(true);
    expect(guardAuthRequestAllowed("POST", "/api/auth/organization/accept-invitation")).toBe(false);
    expect(guardAuthRequestAllowed("POST", "/api/auth/organization/accept-invitation", { testAuth: true })).toBe(false);
    expect(guardAuthRequestAllowed("POST", "/api/auth/organization/add-member", { testAuth: true })).toBe(false);
  });
});

for (const mode of MODES) {
  const options = (domain: string, extra: Partial<StartRegistryOptions> = {}): StartRegistryOptions => ({
    domain,
    ...(mode.storage === undefined ? {} : { storage: mode.storage }),
    ...extra,
  });

  describe.skipIf(mode.missing())(`accepting an invitation through Guard (${mode.name})`, () => {
    let registry: TestRegistry;
    let h: ReturnType<typeof harness>;
    let orgId: string;
    const inviteDomain = `accept-${mode.name.toLowerCase()}.example`;

    beforeAll(async () => {
      registry = await startRegistry(options(inviteDomain));
      h = harness(registry, inviteDomain);
      orgId = await h.orgIdOf();
    });
    afterAll(async () => registry?.close());

    it(`stores admissions in ${mode.name}`, () => {
      expect(registry.server.service.pool === undefined).toBe(mode.storage === "file");
    });

    it("admits exactly one of two invitations accepted at once for the Free plan's last seat", async () => {
      const added = await h.fillTo(orgId, 4, "free-fill");
      const [a, b] = [await h.invited("free-a"), await h.invited("free-b")];
      const ids = [a.invitationId, b.invitationId];
      h.auth.setJoinGate(lastSeat([a.email, b.email]));
      let replies: Reply[];
      try {
        replies = await Promise.all([h.accept(ids[0]!, a.cookie), h.accept(ids[1]!, b.cookie)]);
      } finally {
        h.auth.setJoinGate(undefined);
      }
      expect(replies.map((r) => r.status).sort()).toEqual([200, 403]);
      const refused = replies.find((r) => r.status === 403)!;
      expect(refused.body.code).toBe("REGISTRY_LIMIT_EXCEEDED");
      expect(refused.body.message).toMatch(/already has the Free plan's 5 people \(MEMBER_LIMIT\), so free-[ab]@.* was not added/);
      expect(await h.memberRows(orgId)).toHaveLength(5);
      const admitted = replies[0]!.status === 200 ? 0 : 1;
      expect(await h.invitationStatus(ids[admitted]!)).toBe("accepted");
      expect(await h.invitationStatus(ids[1 - admitted]!)).toBe("pending");
      for (const userId of [...added, admitted === 0 ? a.userId : b.userId]) await h.remove(userId);
    });

    it("admits exactly one when a domain join and an accept race for the last seat, under one lock", async () => {
      const count = (await h.memberRows(orgId)).length;
      await h.tenancy.setUserLimit(orgId, count + 1);
      const invitee = await h.invited("racer-invited");
      const id = invitee.invitationId;
      const joiner = `racer-domain@${inviteDomain}`;
      h.auth.setJoinGate(lastSeat([invitee.email, joiner]));
      let joined: Awaited<ReturnType<typeof h.signUp>>;
      let accepted: Reply;
      try {
        [joined, accepted] = await Promise.all([h.signUp("racer-domain"), h.accept(id, invitee.cookie)]);
      } finally {
        h.auth.setJoinGate(undefined);
        await h.tenancy.setUserLimit(orgId, undefined);
      }
      expect([joined.status, accepted.status].sort(), `${joined.text} / ${JSON.stringify(accepted.body)}`).toEqual([200, 403]);
      const rows = await h.memberRows(orgId);
      expect(rows).toHaveLength(count + 1);
      if (accepted.status === 403) {
        expect(accepted.body).toMatchObject({ code: "REGISTRY_LIMIT_EXCEEDED", message: expect.stringContaining("its own user limit allows") });
        expect(await h.invitationStatus(id)).toBe("pending");
        await h.remove(joined.userId);
      } else {
        expect(joined.text).toContain("its own user limit allows");
        expect(await h.invitationStatus(id)).toBe("accepted");
        await h.remove(invitee.userId);
      }
    });

    it("refuses a full organisation with its own user limit, and leaves the invitation pending", async () => {
      const count = (await h.memberRows(orgId)).length;
      await h.tenancy.setUserLimit(orgId, count);
      const invitee = await h.invited("full");
      const id = invitee.invitationId;
      let refused: Reply;
      try {
        refused = await h.accept(id, invitee.cookie);
      } finally {
        await h.tenancy.setUserLimit(orgId, undefined);
      }
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "REGISTRY_LIMIT_EXCEEDED" });
      expect(refused.body.message).toMatch(new RegExp(`is full: it already has ${count} of the ${count} people its own user limit allows, so full@`));
      expect(refused.body.detail).toBeUndefined();
      expect(await h.invitationStatus(id)).toBe("pending");
      expect(await h.memberRows(orgId)).toHaveLength(count);
    });

    it("writes the member with the invited role, accepts the invitation, makes the org active and moves onboarding to signed in", async () => {
      const elsewhere = await registry.join("has-org", `own-${mode.name.toLowerCase()}.example`);
      const before = String(((await registry.consoleGet(elsewhere, "/session")).body as Json).orgId);
      expect(before).not.toBe(orgId);
      const id = await h.invite(elsewhere.email, "admin");
      const adapter = await h.auth.adapter();
      await adapter.update({ model: "user", where: [{ field: "id", value: elsewhere.userId }], update: { joinDeferredAt: new Date() } });

      const accepted = await h.accept(id, elsewhere.cookie);
      expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
      expect(accepted.body).toEqual({ orgId, role: "admin" });
      expect((await h.memberRows(orgId)).filter((row) => row.userId === elsewhere.userId)).toEqual([expect.objectContaining({ role: "admin" })]);
      expect(await h.invitationStatus(id)).toBe("accepted");
      const sessions = await adapter.findMany<{ activeOrganizationId?: string }>({ model: "session", where: [{ field: "userId", value: elsewhere.userId }] });
      expect(sessions.map((s) => s.activeOrganizationId)).toContain(orgId);
      expect((await registry.consoleGet(elsewhere, "/session")).body).toMatchObject({ orgId, role: "admin" });
      expect(await adapter.findOne<{ joinDeferredAt?: unknown }>({ model: "user", where: [{ field: "id", value: elsewhere.userId }] })).toMatchObject({ joinDeferredAt: null });

      const onboarding = await registry.consoleGet(h.owner, "/people/onboarding");
      expect(onboarding.status, onboarding.text).toBe(200);
      const row = OnboardingPage.parse(onboarding.body).rows.find((entry) => entry.email === elsewhere.email);
      expect(row).toMatchObject({ stage: "signed_in" });

      const again = await h.accept(id, elsewhere.cookie);
      expect(again).toMatchObject({ status: 400, body: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" } });
      await h.remove(elsewhere.userId);
    });

    it("refuses expired, cancelled, already accepted and other people's invitations, and an unverified address, with the messages the start page reads", async () => {
      const adapter = await h.auth.adapter();
      const notFound = { status: 400, body: { code: "INVITATION_NOT_FOUND", message: "Invitation not found" } };

      const late = await h.invited("late");
      const expired = late.invitationId;
      await adapter.update({ model: "invitation", where: [{ field: "id", value: expired }], update: { expiresAt: new Date(Date.now() - 60_000) } });
      expect(await h.accept(expired, late.cookie)).toMatchObject(notFound);

      const gone = await h.invited("gone");
      const cancelled = gone.invitationId;
      expect((await registry.consoleWrite(h.owner, "DELETE", `/people/invitations/${cancelled}`)).status).toBe(204);
      expect(await h.accept(cancelled, gone.cookie)).toMatchObject(notFound);

      expect(await h.accept("no-such-invitation", gone.cookie)).toMatchObject(notFound);
      expect(await h.accept("not an id!", gone.cookie)).toMatchObject(notFound);

      const intended = await h.invite(`intended@${inviteDomain}`);
      const other = await h.invited("other");
      expect(await h.accept(intended, other.cookie)).toMatchObject({
        status: 403,
        body: { code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION", message: "You are not the recipient of the invitation" },
      });
      expect(await h.invitationStatus(intended)).toBe("pending");

      const unverified = await h.invited("unverified");
      const forUnverified = unverified.invitationId;
      await adapter.update({ model: "user", where: [{ field: "id", value: unverified.userId }], update: { emailVerified: false } });
      expect(await h.accept(forUnverified, unverified.cookie)).toMatchObject({
        status: 403,
        body: { code: "EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION" },
      });
      expect(await h.invitationStatus(forUnverified)).toBe("pending");
      expect((await h.memberRows(orgId)).some((row) => [late, gone, other, unverified].some((p) => p.userId === row.userId))).toBe(false);
    });

    it("refuses a caller who is not signed in, and a post from another site", async () => {
      const invitee = await h.invited("anon");
      const id = invitee.invitationId;
      expect(await h.accept(id)).toMatchObject({ status: 401, body: { code: "not_signed_in" } });
      expect(await h.accept(id, "better-auth.session_token=forged")).toMatchObject({ status: 401 });
      expect(await h.accept(id, invitee.cookie, { origin: "https://elsewhere.example" })).toMatchObject({ status: 403, body: { code: "foreign_origin" } });
      expect(await h.accept(id, invitee.cookie, { "sec-fetch-site": "cross-site" })).toMatchObject({ status: 403 });
      expect(await h.invitationStatus(id)).toBe("pending");
    });

    it("no longer serves Better Auth's accept door", async () => {
      const invitee = await h.invited("old-door");
      const id = invitee.invitationId;
      const res = await fetch(`${registry.url}/api/auth/organization/accept-invitation`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN, cookie: invitee.cookie },
        body: JSON.stringify({ invitationId: id }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Not part of Guard" });
      expect(await h.invitationStatus(id)).toBe("pending");
    });
  });

  describe.skipIf(mode.missing())(`accepting past the people limit when the server allows it (${mode.name})`, () => {
    it("admits over a paid plan's limit when billing sells overflow seats, and still refuses on Free", async () => {
      const registry = await startRegistry(options(`overflow-${mode.name.toLowerCase()}.example`, { configure: (o) => ({ ...o, billing: OVERFLOW_BILLING }) }));
      try {
        const h = harness(registry, `overflow-${mode.name.toLowerCase()}.example`);
        const orgId = await h.orgIdOf();
        const count = (await h.memberRows(orgId)).length;
        await h.tenancy.setPlan(orgId, "team");
        await h.tenancy.setUserLimit(orgId, count);
        const paid = await h.invited("paid");
        expect(await h.accept(paid.invitationId, paid.cookie)).toMatchObject({ status: 200 });
        expect(await h.memberRows(orgId)).toHaveLength(count + 1);

        await h.tenancy.setPlan(orgId, "free");
        await h.tenancy.setUserLimit(orgId, undefined);
        await h.fillTo(orgId, 5, "overflow-fill");
        const free = await h.invited("free");
        expect(await h.accept(free.invitationId, free.cookie)).toMatchObject({ status: 403, body: { code: "REGISTRY_LIMIT_EXCEEDED" } });
      } finally {
        await registry.close();
      }
    });

    it("admits over the Free plan's limit when GUARD_NO_PEOPLE_LIMIT is on", async () => {
      const registry = await startRegistry(
        options(`unlimited-${mode.name.toLowerCase()}.example`, { configure: withHosted((hosted) => ({ ...hosted, noPeopleLimit: true })) }),
      );
      try {
        const h = harness(registry, `unlimited-${mode.name.toLowerCase()}.example`);
        const orgId = await h.orgIdOf();
        await h.fillTo(orgId, 5, "unlimited-fill");
        const extra = await h.invited("extra");
        expect(await h.accept(extra.invitationId, extra.cookie)).toMatchObject({ status: 200 });
        expect(await h.memberRows(orgId)).toHaveLength(6);
      } finally {
        await registry.close();
      }
    });
  });
}
