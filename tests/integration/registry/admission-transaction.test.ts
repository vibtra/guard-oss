import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresRegistryStores, type PostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createPostgresAdmissions } from "@vibtra/registry/src/tenancy/admissions.ts";
import { applyOrgPlan, claimInvitation, type ClaimContext, type InvitationClaim } from "@vibtra/registry/src/tenancy/claim.ts";
import { postgresMissing } from "./server-options.ts";

type Pool = PostgresRegistryStores["pool"];

const INSERT_DELAY_MS = 150;

interface Instrumented {
  pool: Pool;
  peak: () => number;
  checkouts: () => number;
  reset: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const instrumented = (pool: Pool): Instrumented => {
  let active = 0;
  let peak = 0;
  let checkouts = 0;
  const took = (): void => {
    checkouts += 1;
    active += 1;
    peak = Math.max(peak, active);
  };
  const wrapped = {
    query: async (...args: Parameters<Pool["query"]>) => {
      took();
      try {
        return await (pool.query as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        active -= 1;
      }
    },
    connect: async () => {
      const client = await pool.connect();
      took();
      const query = client.query.bind(client) as (...a: unknown[]) => Promise<unknown>;
      const release = client.release.bind(client);
      const patched = client as unknown as { query: unknown; release: unknown };
      patched.query = async (...a: unknown[]) => {
        if (typeof a[0] === "string" && a[0].startsWith(`INSERT INTO "member"`)) await sleep(INSERT_DELAY_MS);
        return query(...a);
      };
      patched.release = (error?: Error | boolean) => {
        active -= 1;
        patched.query = query;
        patched.release = release;
        return release(error);
      };
      return client;
    },
  };
  return {
    pool: wrapped as unknown as Pool,
    peak: () => peak,
    checkouts: () => checkouts,
    reset: () => {
      peak = active;
      checkouts = 0;
    },
  };
};

const ctxOver = (pool: Pool, extra: Partial<ClaimContext> = {}): ClaimContext =>
  ({ admissions: createPostgresAdmissions(pool), ...extra }) as unknown as ClaimContext;

describe.skipIf(postgresMissing())("admissions run in one transaction on one connection (Postgres)", () => {
  const base = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
  const schema = `guard_tests_${randomBytes(6).toString("hex")}`;
  const url = `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
  let admin: PostgresRegistryStores;
  let stores: PostgresRegistryStores;
  let racers: PostgresRegistryStores[];
  let seq = 0;

  const sql = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
    stores.pool.query(text, values).then((res) => res.rows as Row[]);

  const user = async (email: string): Promise<string> => {
    seq += 1;
    const id = `user-${seq}`;
    await sql(`INSERT INTO "user" ("id", "name", "email", "emailVerified") VALUES ($1, $2, $3, TRUE)`, [id, email, email]);
    return id;
  };

  const org = async (plan: string, members: number): Promise<{ orgId: string; owner: string }> => {
    seq += 1;
    const orgId = `org-${seq}`;
    await sql(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, $1, $1, now())`, [orgId]);
    await stores.orgs.createOrg({ orgId, name: orgId, plan, createdAt: new Date().toISOString() });
    let owner = "";
    for (let i = 0; i < members; i += 1) {
      const id = await user(`m${i}@${orgId}.example`);
      if (i === 0) owner = id;
      await sql(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, now())`, [
        `mem-${id}`,
        orgId,
        id,
        i === 0 ? "owner" : "member",
      ]);
    }
    return { orgId, owner };
  };

  const invitation = async (orgId: string, inviter: string, email: string, expiresAt = new Date(Date.now() + 3_600_000)): Promise<string> => {
    seq += 1;
    const id = `inv-${seq}`;
    await sql(`INSERT INTO "invitation" ("id", "organizationId", "email", "role", "status", "expiresAt", "inviterId") VALUES ($1, $2, $3, 'member', 'pending', $4, $5)`, [
      id,
      orgId,
      email,
      expiresAt,
      inviter,
    ]);
    return id;
  };

  const invitee = async (orgId: string, owner: string, name: string): Promise<{ userId: string; email: string; invitationId: string }> => {
    const email = `${name}@${orgId}.example`;
    const userId = await user(email);
    return { userId, email, invitationId: await invitation(orgId, owner, email) };
  };

  const memberCount = async (orgId: string): Promise<number> =>
    Number((await sql<{ n: number }>(`SELECT COUNT(*)::int AS n FROM "member" WHERE "organizationId" = $1`, [orgId]))[0]?.n);

  const statusOf = async (invitationId: string): Promise<string | undefined> =>
    (await sql<{ status: string }>(`SELECT "status" FROM "invitation" WHERE "id" = $1`, [invitationId]))[0]?.status;

  const claim = (ctx: ClaimContext, who: { userId: string; email: string; invitationId: string }): Promise<InvitationClaim> =>
    claimInvitation(ctx, who.invitationId, { userId: who.userId, email: who.email, emailVerified: true });

  beforeAll(async () => {
    admin = createPostgresRegistryStores(base);
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    stores = createPostgresRegistryStores(url);
    await stores.migrate();
    racers = [createPostgresRegistryStores(url), createPostgresRegistryStores(url)];
  });

  afterAll(async () => {
    for (const racer of racers ?? []) await racer.close();
    await stores?.close();
    await admin?.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.close();
  });

  it("admits exactly one of two accepts for the last seat when each runs on its own pool, with no in-process chain between them", async () => {
    const { orgId, owner } = await org("free", 4);
    const [a, b] = [await invitee(orgId, owner, "a"), await invitee(orgId, owner, "b")];
    const [poolA, poolB] = racers.map((r) => instrumented(r.pool));
    const outcomes = await Promise.allSettled([claim(ctxOver(poolA!.pool), a), claim(ctxOver(poolB!.pool), b)]);
    const admitted = outcomes.filter((o) => o.status === "fulfilled" && o.value.kind === "admitted");
    const refused = outcomes.filter((o) => o.status === "rejected");
    expect(admitted, JSON.stringify(outcomes)).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "REGISTRY_LIMIT_EXCEEDED", message: expect.stringContaining("has no seats left") });
    expect(await memberCount(orgId)).toBe(5);
    expect([await statusOf(a.invitationId), await statusOf(b.invitationId)].sort()).toEqual(["accepted", "pending"]);
  });

  it("admits exactly one when a domain join and an accept race for the last seat on separate pools", async () => {
    const { orgId, owner } = await org("team", 2);
    await stores.orgs.setUserLimit(orgId, 3);
    const accepter = await invitee(orgId, owner, "accepter");
    const joiner = await user(`joiner@${orgId}.example`);
    const [poolA, poolB] = racers.map((r) => instrumented(r.pool));
    const outcomes = await Promise.allSettled([
      claim(ctxOver(poolA!.pool), accepter),
      applyOrgPlan(ctxOver(poolB!.pool), { kind: "join", orgId }, joiner, `joiner@${orgId}.example`, { onRefusal: "keep" }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled" && (o.value as { kind?: string }).kind !== "refused"), JSON.stringify(outcomes)).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ code: "REGISTRY_LIMIT_EXCEEDED" }) }),
    ]);
    expect(await memberCount(orgId)).toBe(3);
  });

  it("uses exactly one pool connection for a whole claim, and never two at once", async () => {
    const { orgId, owner } = await org("team", 1);
    const who = await invitee(orgId, owner, "single");
    const counted = instrumented(racers[0]!.pool);
    const ctx = ctxOver(counted.pool);
    counted.reset();
    expect(await claim(ctx, who)).toMatchObject({ kind: "admitted", joined: true });
    expect(counted.peak()).toBe(1);
    expect(counted.checkouts()).toBe(2);

    const joiner = await user(`joiner@${orgId}.example`);
    counted.reset();
    await applyOrgPlan(ctx, { kind: "join", orgId }, joiner, `joiner@${orgId}.example`);
    expect(counted.peak()).toBe(1);
    expect(counted.checkouts()).toBe(1);
  });

  it("deletes a new sign-up refused at a full org it reached through that org's slug, so no user is left without a membership", async () => {
    const { orgId } = await org("free", 5);
    const email = `newcomer@${orgId}.example`;
    const newcomer = await user(email);
    const members = {
      findOrgBySlug: async (slug: string) => (await sql<{ id: string }>(`SELECT "id" FROM "organization" WHERE "slug" = $1`, [slug]))[0],
      deleteUser: async (userId: string) => {
        await sql(`DELETE FROM "user" WHERE "id" = $1`, [userId]);
      },
    };
    const ctx = ctxOver(stores.pool, { members } as unknown as Partial<ClaimContext>);
    await expect(applyOrgPlan(ctx, { kind: "create", name: orgId, slug: orgId }, newcomer, email)).rejects.toMatchObject({
      code: "REGISTRY_LIMIT_EXCEEDED",
      message: expect.stringContaining("has no seats left"),
    });
    expect(await sql(`SELECT "id" FROM "user" WHERE "id" = $1`, [newcomer])).toEqual([]);
    expect(await memberCount(orgId)).toBe(5);
  });

  it("refuses a paid org at its seat count, refuses Free, and admits past it when the deployment has no people limit", async () => {
    const paid = await org("team", 1);
    await stores.orgs.setUserLimit(paid.orgId, 1);
    const overPaid = await invitee(paid.orgId, paid.owner, "over");
    await expect(claim(ctxOver(stores.pool), overPaid)).rejects.toMatchObject({ code: "REGISTRY_LIMIT_EXCEEDED" });
    expect(await statusOf(overPaid.invitationId)).toBe("pending");
    expect(await claim(ctxOver(stores.pool, { noPeopleLimit: true }), overPaid)).toMatchObject({ kind: "admitted" });
    expect(await memberCount(paid.orgId)).toBe(2);

    const free = await org("free", 5);
    const overFree = await invitee(free.orgId, free.owner, "over");
    await expect(claim(ctxOver(stores.pool), overFree)).rejects.toMatchObject({
      code: "REGISTRY_LIMIT_EXCEEDED",
      message: expect.stringContaining("by upgrading from the Free plan"),
    });
    expect(await statusOf(overFree.invitationId)).toBe("pending");
  });

  it("re-checks the invitation inside the transaction: expired, wrong recipient and already accepted are refused and write nothing", async () => {
    const { orgId, owner } = await org("team", 1);
    const late = await invitee(orgId, owner, "late");
    await sql(`UPDATE "invitation" SET "expiresAt" = now() - interval '1 minute' WHERE "id" = $1`, [late.invitationId]);
    expect(await claim(ctxOver(stores.pool), late)).toMatchObject({ kind: "refused", code: "INVITATION_NOT_FOUND" });
    const someone = await invitee(orgId, owner, "someone");
    expect(await claim(ctxOver(stores.pool), { ...someone, email: `other@${orgId}.example` })).toMatchObject({
      kind: "refused",
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    });
    expect(await claim(ctxOver(stores.pool), someone)).toMatchObject({ kind: "admitted" });
    expect(await claim(ctxOver(stores.pool), someone)).toMatchObject({ kind: "refused", code: "INVITATION_NOT_FOUND" });
    expect(await memberCount(orgId)).toBe(2);
  });
});
