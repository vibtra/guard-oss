import type pg from "pg";
import { generateRandomString } from "better-auth/crypto";
import { ORG_ROLES, type OrgRole } from "../auth/session.js";
import { seatAllowanceFor, type SeatSource } from "../config.js";
import { VibtraError } from "../errors.js";
import { advisoryLockOf, createInProcessCoordinator } from "../store/coordination.js";
import type { AuthDbAdapter } from "./members.js";
import type { OrgRow } from "./store.js";

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
  | { kind: "member"; orgId: string; userId: string; role: AdmissionRole; at: Date }
  | { kind: "invitation"; orgId: string; invitationId: string; userId: string; sessionId?: string; at: Date };

interface AdmissionRules<R> {
  invitation?: (row: StoredInvitationRow | undefined) => R | undefined;
  seats: (seats: OrgSeats | undefined) => void;
}

export type AdmissionOutcome<R> =
  | { kind: "admitted"; orgId: string; role: OrgRole; joined: boolean }
  | { kind: "refused"; refusal: R }
  | { kind: "not_pending" };

export interface Admissions {
  readonly kind: "postgres" | "adapter";
  invitation(invitationId: string): Promise<StoredInvitationRow | undefined>;
  admit<R>(admission: Admission, rules: AdmissionRules<R>): Promise<AdmissionOutcome<R>>;
}

const admissionLockKey = (orgId: string): string => `claim:join:${orgId}`;

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

const INVITATION_COLUMNS = `"id", "organizationId", "email", "role", "status", "expiresAt"`;

const SEAT_SOURCES: readonly SeatSource[] = ["override", "plan"];

interface SeatRow {
  members: number;
  org_id: string | null;
  name: string | null;
  plan: string | null;
  billing_status: string | null;
  seats: number | null;
  source: string | null;
  open_seats: number | null;
}

const seatsIn = async (client: pg.PoolClient, orgId: string): Promise<{ members: number; seats: OrgSeats | undefined }> => {
  const res = await client.query<SeatRow>(
    `SELECT m.members, o.org_id, o.name, o.plan, o.billing_status, v.seats, v.source, v.open_seats
       FROM (SELECT COUNT(*)::int AS members FROM "member" WHERE "organizationId" = $1) m
       LEFT JOIN orgs o ON o.org_id = $1
       LEFT JOIN org_open_seats v ON v.org_id = $1`,
    [orgId],
  );
  const row = res.rows[0];
  const members = Number(row?.members ?? 0);
  if (row === undefined || row.org_id === null) return { members, seats: undefined };
  const source = SEAT_SOURCES.find((s) => s === row.source);
  if (source === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "This organisation's seats could not be read, so nobody was added",
      detail: `org ${orgId} has no org_seats row (migration 0120 keeps one per org through the orgs triggers); nothing was written`,
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

export const createPostgresAdmissions = (pool: pg.Pool): Admissions => ({
  kind: "postgres",

  async invitation(invitationId) {
    const res = await pool.query<StoredInvitation>(`SELECT ${INVITATION_COLUMNS} FROM "invitation" WHERE "id" = $1`, [invitationId]);
    return invitationOf(res.rows[0]);
  },

  async admit(admission, rules) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const [namespace, id] = advisoryLockOf(admissionLockKey(admission.orgId));
      await client.query(`SELECT pg_advisory_xact_lock($1, $2)`, [namespace, id]);
      let invitation: StoredInvitationRow | undefined;
      if (admission.kind === "invitation") {
        const read = await client.query<StoredInvitation>(`SELECT ${INVITATION_COLUMNS} FROM "invitation" WHERE "id" = $1`, [admission.invitationId]);
        invitation = invitationOf(read.rows[0]);
        const refusal = rules.invitation?.(invitation);
        if (refusal !== undefined || invitation === undefined || invitation.orgId !== admission.orgId) {
          await client.query("ROLLBACK");
          return refusal === undefined ? { kind: "not_pending" } : { kind: "refused", refusal };
        }
      }
      const existing = await client.query<{ role: unknown }>(`SELECT "role" FROM "member" WHERE "organizationId" = $1 AND "userId" = $2`, [
        admission.orgId,
        admission.userId,
      ]);
      const already = existing.rows[0] === undefined ? undefined : roleOf(existing.rows[0].role);
      let role = already;
      if (already === undefined) {
        const { members, seats } = await seatsIn(client, admission.orgId);
        rules.seats(seats);
        role = roleFor(admission, invitation, members);
      }
      if (admission.kind === "invitation") {
        const accepted = await client.query(
          `UPDATE "invitation" SET "status" = 'accepted' WHERE "id" = $1 AND "organizationId" = $2 AND "status" = 'pending'`,
          [admission.invitationId, admission.orgId],
        );
        if (accepted.rowCount !== 1) {
          await client.query("ROLLBACK");
          return { kind: "not_pending" };
        }
      }
      if (already === undefined) {
        await client.query(`INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, $5)`, [
          memberId(),
          admission.orgId,
          admission.userId,
          role,
          admission.at,
        ]);
      }
      if (admission.kind === "invitation" && admission.sessionId !== undefined) {
        await client.query(`UPDATE "session" SET "activeOrganizationId" = $1, "updatedAt" = $2 WHERE "id" = $3 AND "userId" = $4`, [
          admission.orgId,
          admission.at,
          admission.sessionId,
          admission.userId,
        ]);
      }
      await client.query("COMMIT");
      return { kind: "admitted", orgId: admission.orgId, role: role ?? "member", joined: already === undefined };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
});

export interface AdapterAdmissionsOptions {
  adapter: () => Promise<AuthDbAdapter>;
  seatsOf: (orgId: string) => Promise<OrgSeats | undefined>;
}

export const createAdapterAdmissions = (options: AdapterAdmissionsOptions): Admissions => {
  const locks = createInProcessCoordinator(() => Date.now());
  const readInvitation = async (invitationId: string): Promise<StoredInvitationRow | undefined> =>
    invitationOf(await (await options.adapter()).findOne<StoredInvitation>({ model: "invitation", where: [{ field: "id", value: invitationId }] }));

  return {
    kind: "adapter",

    invitation: readInvitation,

    admit: (admission, rules) =>
      locks.lock(admissionLockKey(admission.orgId), async () => {
        const adapter = await options.adapter();
        let invitation: StoredInvitationRow | undefined;
        if (admission.kind === "invitation") {
          invitation = await readInvitation(admission.invitationId);
          const refusal = rules.invitation?.(invitation);
          if (refusal !== undefined) return { kind: "refused", refusal };
          if (invitation === undefined || invitation.orgId !== admission.orgId || invitation.status !== "pending") return { kind: "not_pending" };
        }
        const existing = await adapter.findOne<{ role?: unknown }>({
          model: "member",
          where: [
            { field: "organizationId", value: admission.orgId },
            { field: "userId", value: admission.userId },
          ],
        });
        const already = existing === null ? undefined : roleOf(existing.role);
        let role = already;
        if (already === undefined) {
          const seats = await options.seatsOf(admission.orgId);
          rules.seats(seats);
          const members = seats?.members ?? (await adapter.count({ model: "member", where: [{ field: "organizationId", value: admission.orgId }] }));
          role = roleFor(admission, invitation, members);
        }
        const byId = admission.kind === "invitation" ? [{ field: "id", value: admission.invitationId }] : undefined;
        if (byId !== undefined) await adapter.update({ model: "invitation", where: byId, update: { status: "accepted" } });
        try {
          if (already === undefined) {
            await adapter.create({
              model: "member",
              data: { organizationId: admission.orgId, userId: admission.userId, role, createdAt: admission.at },
            });
          }
          if (admission.kind === "invitation" && admission.sessionId !== undefined) {
            await adapter.update({
              model: "session",
              where: [{ field: "id", value: admission.sessionId }],
              update: { activeOrganizationId: admission.orgId, updatedAt: admission.at },
            });
          }
        } catch (error) {
          if (byId !== undefined) await adapter.update({ model: "invitation", where: byId, update: { status: "pending" } }).catch(() => undefined);
          throw error;
        }
        return { kind: "admitted", orgId: admission.orgId, role: role ?? "member", joined: already === undefined };
      }),
  };
};
