import type pg from "pg";
import { generateRandomString } from "better-auth/crypto";
import { ORG_ROLES, type OrgRole } from "../auth/session.js";
import { seatAllowanceFor, type SeatSource } from "../config.js";
import { VibtraError } from "../errors.js";
import { createInProcessCoordinator } from "../store/coordination.js";
import { sqlOf, type OrgLockedTx, type OrgLocks } from "../store/org-lock.js";
import { insertOrgRow } from "../store/postgres.js";
import { displayName, type AuthDbAdapter, type MemberDirectory } from "./members.js";
import type { OrgRow, OrgRowInput, TenancyStore } from "./store.js";

export interface StoredInvitationRow {
  invitationId: string;
  orgId: string;
  email: string;
  role: OrgRole;
  status: string;
  expiresAt: Date;
}

export interface OrgSeats {
  orgId: string;
  name: string;
  plan: string;
  billingStatus: string;
  members: number;
  seats: number | null;
  source: SeatSource;
  open: number | null;
}

export type AdmissionRole = OrgRole | "first-is-owner";

type Admission =
  | { kind: "member"; userId: string; role: AdmissionRole; at: Date }
  | { kind: "invitation"; invitationId: string; userId: string; sessionId?: string; at: Date };

interface AdmissionRules<R> {
  invitation?: (row: StoredInvitationRow | undefined) => R | undefined;
  seats: (seats: OrgSeats) => void;
}

interface NewOrg {
  name: string;
  slug: string;
  domain?: string;
  waitlisted: boolean;
  ownerId: string;
  at: Date;
}

export type AdmissionOutcome<R> =
  | { kind: "admitted"; orgId: string; role: OrgRole; joined: boolean }
  | { kind: "refused"; refusal: R }
  | { kind: "not_pending" };

interface LockedMember {
  userId: string;
  email: string;
  name: string | null;
}

export interface Admissions {
  readonly kind: "postgres" | "adapter";
  invitation(invitationId: string): Promise<StoredInvitationRow | undefined>;
  admit<R>(tx: OrgLockedTx, admission: Admission, rules: AdmissionRules<R>): Promise<AdmissionOutcome<R>>;
  members(tx: OrgLockedTx): Promise<LockedMember[]>;
  createOrg(org: NewOrg): Promise<{ orgId: string; role: "owner" }>;
}

const orgStillBeingSetUp = (orgId: string, missing: string): VibtraError =>
  new VibtraError({
    code: "REGISTRY_LIMIT_EXCEEDED",
    message: "This organisation is still being set up. Try again in a moment.",
    detail: `admission into org ${orgId} refused: it has no ${missing} row yet, so its seats cannot be counted. Nothing was written and an invitation stays pending.`,
  });

const orgRowOf = (org: NewOrg, orgId: string): OrgRowInput => ({
  orgId,
  name: org.name,
  ...(org.domain === undefined ? {} : { domain: org.domain }),
  ...(org.waitlisted ? { status: "waitlisted" } : {}),
  createdAt: org.at.toISOString(),
});

interface StoredInvitation {
  id?: unknown;
  organizationId?: unknown;
  email?: unknown;
  role?: unknown;
  status?: unknown;
  expiresAt?: unknown;
}

const roleOf = (value: unknown): OrgRole =>
  typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value) ? (value as OrgRole) : "member";

const invitationOf = (row: StoredInvitation | null | undefined): StoredInvitationRow | undefined => {
  if (row === null || row === undefined) return undefined;
  if (typeof row.id !== "string" || typeof row.organizationId !== "string" || typeof row.email !== "string" || typeof row.status !== "string") return undefined;
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : typeof row.expiresAt === "string" ? new Date(row.expiresAt) : undefined;
  if (expiresAt === undefined || Number.isNaN(expiresAt.getTime())) return undefined;
  return { invitationId: row.id, orgId: row.organizationId, email: row.email.trim().toLowerCase(), role: roleOf(row.role), status: row.status, expiresAt };
};

export const orgSeatsOf = (org: OrgRow, members: number): OrgSeats => {
  const { seats, source } = seatAllowanceFor(org);
  return {
    orgId: org.orgId,
    name: org.name,
    plan: org.plan,
    billingStatus: org.billingStatus,
    members,
    seats,
    source,
    open: seats === null ? null : seats - members,
  };
};

const roleFor = (admission: Admission, invitation: StoredInvitationRow | undefined, members: number): OrgRole => {
  if (admission.kind === "invitation") return invitation?.role ?? "member";
  if (admission.role === "first-is-owner") return members === 0 ? "owner" : "member";
  return admission.role;
};

const memberId = (): string => generateRandomString(32, "a-z", "A-Z", "0-9");

const orgId = (): string => generateRandomString(32, "a-z", "A-Z", "0-9");

const INVITATION_COLUMNS = `"id", "organizationId", "email", "role", "status", "expiresAt"`;

const SEAT_SOURCES: readonly SeatSource[] = ["override", "plan"];

interface SeatRow {
  members: number;
  org_id: string | null;
  name: string | null;
  plan: string | null;
  billing_status: string | null;
  seats_org_id: string | null;
  seats: number | null;
  source: string | null;
  open_seats: number | null;
}

const seatsIn = async (client: pg.PoolClient, orgId: string): Promise<{ members: number; seats: OrgSeats }> => {
  const res = await client.query<SeatRow>(
    `SELECT m.members, o.org_id, o.name, o.plan, o.billing_status, v.org_id AS seats_org_id, v.seats, v.source, v.open_seats
       FROM (SELECT COUNT(*)::int AS members FROM "member" WHERE "organizationId" = $1) m
       LEFT JOIN orgs o ON o.org_id = $1
       LEFT JOIN org_open_seats v ON v.org_id = $1`,
    [orgId],
  );
  const row = res.rows[0];
  const members = Number(row?.members ?? 0);
  if (row === undefined || row.org_id === null) throw orgStillBeingSetUp(orgId, "orgs");
  if (row.seats_org_id === null) throw orgStillBeingSetUp(orgId, "org_seats");
  const source = SEAT_SOURCES.find((s) => s === row.source);
  if (source === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "This organisation's seats could not be read, so nobody was added",
      detail: `org ${orgId} has an org_seats row with source ${String(row.source)}, which admission does not read; nothing was written`,
    });
  }
  return {
    members,
    seats: {
      orgId,
      name: row.name ?? orgId,
      plan: row.plan ?? "free",
      billingStatus: row.billing_status ?? "active",
      members,
      seats: row.seats === null ? null : Number(row.seats),
      source,
      open: row.open_seats === null ? null : Number(row.open_seats),
    },
  };
};

export const createPostgresAdmissions = (pool: pg.Pool, locks: OrgLocks): Admissions => ({
  kind: "postgres",

  async invitation(invitationId) {
    const res = await pool.query<StoredInvitation>(`SELECT ${INVITATION_COLUMNS} FROM "invitation" WHERE "id" = $1`, [invitationId]);
    return invitationOf(res.rows[0]);
  },

  async admit(tx, admission, rules) {
    const client = sqlOf(tx);
    let invitation: StoredInvitationRow | undefined;
    if (admission.kind === "invitation") {
      const read = await client.query<StoredInvitation>(`SELECT ${INVITATION_COLUMNS} FROM "invitation" WHERE "id" = $1`, [admission.invitationId]);
      invitation = invitationOf(read.rows[0]);
      const refusal = rules.invitation?.(invitation);
      if (refusal !== undefined || invitation === undefined || invitation.orgId !== tx.orgId) {
        return refusal === undefined ? { kind: "not_pending" } : { kind: "refused", refusal };
      }
    }
    const existing = await client.query<{ role: unknown }>(`SELECT "role" FROM "member" WHERE "organizationId" = $1 AND "userId" = $2`, [tx.orgId, admission.userId]);
    const already = existing.rows[0] === undefined ? undefined : roleOf(existing.rows[0].role);
    let role = already;
    if (already === undefined) {
      const { members, seats } = await seatsIn(client, tx.orgId);
      rules.seats(seats);
      role = roleFor(admission, invitation, members);
    }
    if (admission.kind === "invitation") {
      const accepted = await client.query(`UPDATE "invitation" SET "status" = 'accepted' WHERE "id" = $1 AND "organizationId" = $2 AND "status" = 'pending'`, [
        admission.invitationId,
        tx.orgId,
      ]);
      if (accepted.rowCount !== 1) return { kind: "not_pending" };
    }
    if (already === undefined) {
      await client.query(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
        memberId(),
        tx.orgId,
        admission.userId,
        role,
        admission.at,
      ]);
    }
    if (admission.kind === "invitation" && admission.sessionId !== undefined) {
      await client.query(`UPDATE "session" SET "activeOrganizationId" = $1, "updatedAt" = $2 WHERE "id" = $3 AND "userId" = $4`, [
        tx.orgId,
        admission.at,
        admission.sessionId,
        admission.userId,
      ]);
    }
    return { kind: "admitted", orgId: tx.orgId, role: role ?? "member", joined: already === undefined };
  },

  async members(tx) {
    const res = await sqlOf(tx).query<{ user_id: string; email: string; name: unknown }>(
      `SELECT m."userId" AS user_id, u."email" AS email, u."name" AS name FROM "member" m JOIN "user" u ON u."id" = m."userId" WHERE m."organizationId" = $1`,
      [tx.orgId],
    );
    return res.rows.map((row) => ({ userId: row.user_id, email: row.email, name: displayName(row.name) }));
  },

  createOrg: (org) =>
    locks.withOrgLock(orgId(), async (tx) => {
      const client = sqlOf(tx);
      await client.query(`INSERT INTO "organization" ("id", "name", "slug", "createdAt") VALUES ($1, $2, $3, $4)`, [tx.orgId, org.name, org.slug, org.at]);
      await insertOrgRow(client, orgRowOf(org, tx.orgId));
      await client.query(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, 'owner', $4)`, [
        memberId(),
        tx.orgId,
        org.ownerId,
        org.at,
      ]);
      return { orgId: tx.orgId, role: "owner" as const };
    }),
});

export interface AdapterAdmissionsOptions {
  adapter: () => Promise<AuthDbAdapter>;
  orgs: Pick<TenancyStore, "createOrg">;
  seatsOf: (orgId: string) => Promise<OrgSeats | undefined>;
  members: Pick<MemberDirectory, "listMembers">;
  locks: OrgLocks;
}

export const createAdapterAdmissions = (options: AdapterAdmissionsOptions): Admissions => {
  const creators = createInProcessCoordinator(() => Date.now());
  const readInvitation = async (invitationId: string): Promise<StoredInvitationRow | undefined> =>
    invitationOf(await (await options.adapter()).findOne<StoredInvitation>({ model: "invitation", where: [{ field: "id", value: invitationId }] }));

  return {
    kind: "adapter",

    invitation: readInvitation,

    async admit(tx, admission, rules) {
      const adapter = await options.adapter();
      let invitation: StoredInvitationRow | undefined;
      if (admission.kind === "invitation") {
        invitation = await readInvitation(admission.invitationId);
        const refusal = rules.invitation?.(invitation);
        if (refusal !== undefined) return { kind: "refused", refusal };
        if (invitation === undefined || invitation.orgId !== tx.orgId || invitation.status !== "pending") return { kind: "not_pending" };
      }
      const existing = await adapter.findOne<{ role?: unknown }>({
        model: "member",
        where: [
          { field: "organizationId", value: tx.orgId },
          { field: "userId", value: admission.userId },
        ],
      });
      const already = existing === null ? undefined : roleOf(existing.role);
      let role = already;
      if (already === undefined) {
        const seats = await options.seatsOf(tx.orgId);
        if (seats === undefined) throw orgStillBeingSetUp(tx.orgId, "orgs");
        rules.seats(seats);
        role = roleFor(admission, invitation, seats.members);
      }
      const byId = admission.kind === "invitation" ? [{ field: "id", value: admission.invitationId }] : undefined;
      if (admission.kind === "invitation" && byId !== undefined) {
        const fresh = await readInvitation(admission.invitationId);
        const refusal = rules.invitation?.(fresh);
        if (refusal !== undefined) return { kind: "refused", refusal };
        if (fresh === undefined || fresh.orgId !== tx.orgId || fresh.status !== "pending") return { kind: "not_pending" };
        const accepted = await adapter.update({ model: "invitation", where: [...byId, { field: "status", value: "pending" }], update: { status: "accepted" } });
        if (accepted === null) return { kind: "not_pending" };
      }
      try {
        if (already === undefined) {
          await adapter.create({
            model: "member",
            data: { organizationId: tx.orgId, userId: admission.userId, role, createdAt: admission.at },
          });
        }
        if (admission.kind === "invitation" && admission.sessionId !== undefined) {
          await adapter.update({
            model: "session",
            where: [{ field: "id", value: admission.sessionId }],
            update: { activeOrganizationId: tx.orgId, updatedAt: admission.at },
          });
        }
      } catch (error) {
        if (byId !== undefined) {
          await adapter.update({ model: "invitation", where: [...byId, { field: "status", value: "accepted" }], update: { status: "pending" } }).catch(() => undefined);
        }
        throw error;
      }
      return { kind: "admitted", orgId: tx.orgId, role: role ?? "member", joined: already === undefined };
    },

    members: async (tx) => (await options.members.listMembers(tx.orgId)).map(({ userId, email, name }) => ({ userId, email, name })),

    createOrg: (org) =>
      creators.lock(`claim:create:${org.slug}`, async () => {
        const adapter = await options.adapter();
        const taken = await adapter.findOne<{ id?: unknown }>({ model: "organization", where: [{ field: "slug", value: org.slug }] });
        if (taken !== null) {
          throw new VibtraError({
            code: "VALIDATION",
            message: "That organisation already exists",
            detail: `slug ${org.slug} already belongs to org ${String(taken.id)}; nothing was written`,
          });
        }
        const created = await adapter.create<{ id?: unknown }>({ model: "organization", data: { name: org.name, slug: org.slug, createdAt: org.at } });
        if (typeof created.id !== "string" || created.id === "") {
          throw new VibtraError({ code: "INTERNAL", message: "The organization could not be created", detail: "Better Auth returned an organization row with no id" });
        }
        const id = created.id;
        return options.locks.withOrgLock(id, async () => {
          try {
            await options.orgs.createOrg(orgRowOf(org, id));
          } catch (error) {
            await adapter.delete({ model: "organization", where: [{ field: "id", value: id }] }).catch(() => undefined);
            throw error;
          }
          await adapter.create({ model: "member", data: { organizationId: id, userId: org.ownerId, role: "owner", createdAt: org.at } });
          return { orgId: id, role: "owner" as const };
        });
      }),
  };
};
