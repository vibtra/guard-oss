import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { planFor, seatAllowanceFor, userLimitFor } from "@vibtra/registry/src/config.ts";
import { createPostgresRegistryStores, type PostgresRegistryStores } from "@vibtra/registry/src/store/postgres.ts";
import { createFileOrgStore, type OrgStore } from "@vibtra/registry/src/tenancy/store.ts";
import { postgresMissing } from "./server-options.ts";

const SUBSCRIBED = { stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active", stripeSeats: 7 } as const;

describe("seat allowance precedence", () => {
  it("takes the per-org override first, then an active subscription's quantity, then the plan default", () => {
    expect(seatAllowanceFor({ plan: "team" })).toEqual({ seats: 25, source: "plan" });
    expect(seatAllowanceFor({ plan: "team", ...SUBSCRIBED })).toEqual({ seats: 7, source: "subscription" });
    expect(seatAllowanceFor({ plan: "team", ...SUBSCRIBED, userLimit: 3 })).toEqual({ seats: 3, source: "override" });
    expect(seatAllowanceFor({ plan: "team", ...SUBSCRIBED, userLimit: 0 })).toEqual({ seats: 0, source: "override" });
    expect(seatAllowanceFor({ plan: "enterprise" })).toEqual({ seats: null, source: "plan" });
    expect(seatAllowanceFor(undefined)).toEqual({ seats: 5, source: "plan" });
  });

  it("counts a subscription only while it is live and carries a quantity", () => {
    for (const status of ["active", "trialing", "past_due"]) {
      expect(seatAllowanceFor({ plan: "team", ...SUBSCRIBED, stripeSubscriptionStatus: status }).source).toBe("subscription");
    }
    for (const status of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]) {
      expect(seatAllowanceFor({ plan: "team", ...SUBSCRIBED, stripeSubscriptionStatus: status })).toEqual({ seats: 25, source: "plan" });
    }
    expect(seatAllowanceFor({ plan: "team", stripeSubscriptionStatus: "active", stripeSeats: 7 }).source).toBe("plan");
    expect(seatAllowanceFor({ plan: "team", stripeSubscriptionId: "sub_1", stripeSubscriptionStatus: "active" }).source).toBe("plan");
  });

  it("is what userLimitFor reports, so the console shows the enforced number", () => {
    expect(userLimitFor({ plan: "business", ...SUBSCRIBED })).toBe(7);
    expect(userLimitFor({ plan: "business", ...SUBSCRIBED, userLimit: 2 })).toBe(2);
  });
});

const stepsAgree = async (orgs: OrgStore, orgId: string, seatsOf: () => Promise<{ seats: number | null; source: string }>): Promise<void> => {
  const expectBoth = async (seats: number | null, source: string): Promise<void> => {
    const row = await seatsOf();
    expect(row).toEqual({ seats, source });
    expect(seatAllowanceFor(await orgs.getOrg(orgId))).toEqual({ seats, source });
  };
  await expectBoth(5, "plan");
  await orgs.setPlan(orgId, "team");
  await expectBoth(25, "plan");
  await orgs.setStripeBilling(orgId, SUBSCRIBED);
  await expectBoth(7, "subscription");
  await orgs.setStripeBilling(orgId, { stripeSeats: 9 });
  await expectBoth(9, "subscription");
  await orgs.setUserLimit(orgId, 3);
  await expectBoth(3, "override");
  await orgs.setUserLimit(orgId, undefined);
  await expectBoth(9, "subscription");
  await orgs.setStripeBilling(orgId, { stripeSubscriptionStatus: "canceled" });
  await expectBoth(25, "plan");
  await orgs.setPlan(orgId, "enterprise");
  await expectBoth(null, "plan");
};

describe("seat allowance in file mode", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "guard-seats-"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));

  it("follows each input change with the same precedence", async () => {
    const orgs = await createFileOrgStore(path.join(dir, "tenancy.json"));
    await orgs.createOrg({ orgId: "org-file", name: "File", createdAt: new Date().toISOString() });
    await stepsAgree(orgs, "org-file", async () => seatAllowanceFor(await orgs.getOrg("org-file")));
  });
});

describe.skipIf(postgresMissing())("the org_seats table (Postgres)", () => {
  const base = process.env.VIBTRA_TEST_DATABASE_URL ?? "";
  const schema = `guard_tests_${randomBytes(6).toString("hex")}`;
  const url = `${base}${base.includes("?") ? "&" : "?"}options=${encodeURIComponent(`-csearch_path=${schema}`)}`;
  let admin: PostgresRegistryStores;
  let stores: PostgresRegistryStores;

  const seatsRow = async (orgId: string): Promise<{ seats: number | null; source: string }> => {
    const res = await stores.pool.query(`SELECT seats, source FROM org_seats WHERE org_id = $1`, [orgId]);
    const row = res.rows[0] as { seats: number | null; source: string } | undefined;
    if (row === undefined) throw new Error(`no org_seats row for ${orgId}`);
    return row;
  };

  beforeAll(async () => {
    admin = createPostgresRegistryStores(base);
    await admin.pool.query(`CREATE SCHEMA ${schema}`);
    stores = createPostgresRegistryStores(url);
    await stores.migrate();
  });

  afterAll(async () => {
    await stores?.close();
    await admin?.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.close();
  });

  it("gives every plan the same default in SQL as in config.ts", async () => {
    for (const id of ["free", "team", "business", "enterprise", "entry", "no-such-plan"]) {
      const res = await stores.pool.query(`SELECT vibtra_plan_seats($1) AS seats`, [id]);
      expect((res.rows[0] as { seats: number | null }).seats, id).toBe(planFor(id).userLimit);
    }
  });

  it("writes a row at org creation and recomputes it on every input change, agreeing with userLimitFor", async () => {
    await stores.orgs.createOrg({ orgId: "org-pg", name: "Pg", createdAt: new Date().toISOString() });
    await stepsAgree(stores.orgs, "org-pg", () => seatsRow("org-pg"));
  });

  it("reports open seats as seats minus members, and unlimited as null", async () => {
    await stores.orgs.createOrg({ orgId: "org-open", name: "Open", createdAt: new Date().toISOString() });
    await stores.pool.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ('org-open', 'Open', 'org-open', now())`);
    await stores.pool.query(`INSERT INTO "user" ("id", "name", "email") VALUES ('u-open', 'u', 'u@open.example')`);
    await stores.pool.query(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ('m-open', 'org-open', 'u-open', 'owner', now())`);
    const open = async (): Promise<unknown> => (await stores.pool.query(`SELECT seats, members, open_seats FROM org_open_seats WHERE org_id = 'org-open'`)).rows[0];
    expect(await open()).toEqual({ seats: 5, members: 1, open_seats: 4 });
    await stores.orgs.setPlan("org-open", "enterprise");
    expect(await open()).toEqual({ seats: null, members: 1, open_seats: null });
  });

  it("backfills every existing org when migration 0120 runs", async () => {
    const fixtures: Array<{ orgId: string; set: string; want: { seats: number | null; source: string } }> = [
      { orgId: "bf-free", set: "plan = 'free'", want: { seats: 5, source: "plan" } },
      { orgId: "bf-business", set: "plan = 'business'", want: { seats: 100, source: "plan" } },
      { orgId: "bf-enterprise", set: "plan = 'enterprise'", want: { seats: null, source: "plan" } },
      { orgId: "bf-override", set: "plan = 'team', user_limit = 12, stripe_subscription_id = 'sub_o', stripe_subscription_status = 'active', stripe_seats = 30", want: { seats: 12, source: "override" } },
      { orgId: "bf-subscribed", set: "plan = 'team', stripe_subscription_id = 'sub_s', stripe_subscription_status = 'trialing', stripe_seats = 30", want: { seats: 30, source: "subscription" } },
      { orgId: "bf-cancelled", set: "plan = 'team', stripe_subscription_id = 'sub_c', stripe_subscription_status = 'canceled', stripe_seats = 30", want: { seats: 25, source: "plan" } },
    ];
    await stores.pool.query(`
      DROP VIEW org_open_seats;
      DROP TRIGGER orgs_seats_on_create ON orgs;
      DROP TRIGGER orgs_seats_on_change ON orgs;
      DROP FUNCTION vibtra_org_seats_follow();
      DROP FUNCTION vibtra_recompute_org_seats(TEXT);
      DROP TABLE org_seats;
      DROP FUNCTION vibtra_plan_seats(TEXT);
      DELETE FROM registry_migrations WHERE name = '0120_org_seats.sql';
    `);
    for (const f of fixtures) {
      await stores.orgs.createOrg({ orgId: f.orgId, name: f.orgId, createdAt: new Date().toISOString() });
      await stores.pool.query(`UPDATE orgs SET ${f.set} WHERE org_id = $1`, [f.orgId]);
    }
    await stores.migrate();
    for (const f of fixtures) {
      expect(await seatsRow(f.orgId), f.orgId).toEqual(f.want);
      expect(seatAllowanceFor(await stores.orgs.getOrg(f.orgId)), f.orgId).toEqual(f.want);
    }
    expect(await seatsRow("org-pg")).toEqual({ seats: null, source: "plan" });
  });
});
