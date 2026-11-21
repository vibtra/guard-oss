import type pg from "pg";
import { generateRandomString } from "better-auth/crypto";
import { ORG_ROLES, type OrgRole } from "../auth/session.js";
import type { AuthDbAdapter } from "./members.js";

interface PendingInvitationRow {
  invitationId: string;
  orgId: string;
  email: string;
  role: OrgRole;
  status: string;
  expiresAt: Date;
}

interface InvitationAdmission {
  invitationId: string;
  orgId: string;
  userId: string;
  role: OrgRole;
  addMember: boolean;
  sessionId?: string;
  at: Date;
}

type AdmissionWrite = "admitted" | "not_pending";

export interface InvitationAdmissions {
  readonly kind: "postgres" | "adapter";
  invitation(invitationId: string): Promise<PendingInvitationRow | undefined>;
  admit(admission: InvitationAdmission): Promise<AdmissionWrite>;
}

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

const invitationOf = (row: StoredInvitation | null | undefined): PendingInvitationRow | undefined => {
  if (row === null || row === undefined) return undefined;
  if (typeof row.id !== "string" || typeof row.organizationId !== "string" || typeof row.email !== "string" || typeof row.status !== "string") return undefined;
  const expiresAt = row.expiresAt instanceof Date ? row.expiresAt : typeof row.expiresAt === "string" ? new Date(row.expiresAt) : undefined;
  if (expiresAt === undefined || Number.isNaN(expiresAt.getTime())) return undefined;
  return { invitationId: row.id, orgId: row.organizationId, email: row.email.trim().toLowerCase(), role: roleOf(row.role), status: row.status, expiresAt };
};

const memberId = (): string => generateRandomString(32, "a-z", "A-Z", "0-9");

export const createPostgresInvitationAdmissions = (pool: pg.Pool): InvitationAdmissions => ({
  kind: "postgres",

  async invitation(invitationId) {
    const res = await pool.query<StoredInvitation>(
      `SELECT "id", "organizationId", "email", "role", "status", "expiresAt" FROM "invitation" WHERE "id" = $1`,
      [invitationId],
    );
    return invitationOf(res.rows[0]);
  },

  async admit(admission) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const accepted = await client.query(
        `UPDATE "invitation" SET "status" = 'accepted' WHERE "id" = $1 AND "organizationId" = $2 AND "status" = 'pending'`,
        [admission.invitationId, admission.orgId],
      );
      if (accepted.rowCount !== 1) {
        await client.query("ROLLBACK");
        return "not_pending";
      }
      if (admission.addMember) {
        await client.query(
          `INSERT INTO "member" ("id", "organizationId", "userId", "role", "createdAt") VALUES ($1, $2, $3, $4, $5)`,
          [memberId(), admission.orgId, admission.userId, admission.role, admission.at],
        );
      }
      if (admission.sessionId !== undefined) {
        await client.query(`UPDATE "session" SET "activeOrganizationId" = $1, "updatedAt" = $2 WHERE "id" = $3 AND "userId" = $4`, [
          admission.orgId,
          admission.at,
          admission.sessionId,
          admission.userId,
        ]);
      }
      await client.query("COMMIT");
      return "admitted";
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  },
});

export const createAdapterInvitationAdmissions = (adapterOf: () => Promise<AuthDbAdapter>): InvitationAdmissions => ({
  kind: "adapter",

  async invitation(invitationId) {
    const adapter = await adapterOf();
    return invitationOf(await adapter.findOne<StoredInvitation>({ model: "invitation", where: [{ field: "id", value: invitationId }] }));
  },

  async admit(admission) {
    const adapter = await adapterOf();
    const current = invitationOf(await adapter.findOne<StoredInvitation>({ model: "invitation", where: [{ field: "id", value: admission.invitationId }] }));
    if (current === undefined || current.orgId !== admission.orgId || current.status !== "pending") return "not_pending";
    const byId = [{ field: "id", value: admission.invitationId }];
    await adapter.update({ model: "invitation", where: byId, update: { status: "accepted" } });
    try {
      if (admission.addMember) {
        await adapter.create({
          model: "member",
          data: { organizationId: admission.orgId, userId: admission.userId, role: admission.role, createdAt: admission.at },
        });
      }
      if (admission.sessionId !== undefined) {
        await adapter.update({
          model: "session",
          where: [{ field: "id", value: admission.sessionId }],
          update: { activeOrganizationId: admission.orgId, updatedAt: admission.at },
        });
      }
    } catch (error) {
      await adapter.update({ model: "invitation", where: byId, update: { status: "pending" } }).catch(() => undefined);
      throw error;
    }
    return "admitted";
  },
});
