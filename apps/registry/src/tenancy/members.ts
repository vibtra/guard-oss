import { VibtraError } from "../errors.js";
import type { OrgRole } from "../auth/session.js";
import { ORG_ROLES } from "../auth/session.js";

interface MemberWhere {
  field: string;
  value: string;
  operator?: "eq";
}

export interface AuthDbAdapter {
  create<T>(data: { model: string; data: Record<string, unknown> }): Promise<T>;
  findOne<T>(data: { model: string; where: MemberWhere[] }): Promise<T | null>;
  findMany<T>(data: {
    model: string;
    where?: MemberWhere[];
    limit?: number;
    sortBy?: { field: string; direction: "asc" | "desc" };
  }): Promise<T[]>;
  count(data: { model: string; where?: MemberWhere[] }): Promise<number>;
  delete<T>(data: { model: string; where: MemberWhere[] }): Promise<void>;
  update<T>(data: { model: string; where: MemberWhere[]; update: Record<string, unknown> }): Promise<T | null>;
}

export interface OrgMemberRow {
  userId: string;
  memberId: string;
  email: string;
  name: string | null;
  orgId: string;
  role: OrgRole;
  createdAt: string;
}

export interface OrgRecord {
  id: string;
  name: string;
  slug: string;
}

export interface MemberDirectory {
  listMembers(orgId: string): Promise<OrgMemberRow[]>;
  listAdmins(orgId: string): Promise<OrgMemberRow[]>;
  countMembers(orgId: string): Promise<number>;
  membershipOf(
    userId: string,
    preferredOrgId?: string,
  ): Promise<{ orgId: string; role: OrgRole } | undefined>;

  membershipsOf(userId: string): Promise<Array<{ orgId: string; role: OrgRole }>>;

  lastActiveOrgOf(userId: string): Promise<string | undefined>;
  lastSeenOf(userId: string): Promise<string | undefined>;
  findOrgBySlug(slug: string): Promise<OrgRecord | undefined>;
  createOrg(input: { name: string; slug: string }): Promise<OrgRecord>;
  renameOrg(orgId: string, name: string): Promise<void>;
  addMember(input: { orgId: string; userId: string; role: OrgRole }): Promise<OrgMemberRow>;

  revokeSessions(userId: string): Promise<void>;

  markClosed(userId: string, at: string): Promise<void>;

  closedAtOf(userId: string): Promise<string | undefined>;

  removeMembership(orgId: string, userId: string): Promise<void>;

  deleteUser(userId: string): Promise<void>;
}

interface MemberRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date | string;
}

interface UserRecord {
  id: string;
  email: string;
  name?: string | null;
}

const displayName = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value));

const roleOf = (value: string): OrgRole =>
  (ORG_ROLES as readonly string[]).includes(value) ? (value as OrgRole) : "member";

const byCreatedAt = (a: OrgMemberRow, b: OrgMemberRow): number => a.createdAt.localeCompare(b.createdAt);

export const createMemberDirectory = (adapterOf: () => Promise<AuthDbAdapter>): MemberDirectory => {
  const withEmails = async (adapter: AuthDbAdapter, members: MemberRecord[]): Promise<OrgMemberRow[]> => {
    const rows: OrgMemberRow[] = [];
    for (const m of members) {
      const user = await adapter.findOne<UserRecord>({ model: "user", where: [{ field: "id", value: m.userId }] });
      if (user === null) continue;
      rows.push({
        userId: m.userId,
        memberId: m.id,
        email: user.email,
        name: displayName(user.name),
        orgId: m.organizationId,
        role: roleOf(m.role),
        createdAt: iso(m.createdAt),
      });
    }
    return rows.sort(byCreatedAt);
  };

  const membershipRows = async (userId: string): Promise<MemberRecord[]> => {
    const adapter = await adapterOf();
    const rows = await adapter.findMany<MemberRecord>({
      model: "member",
      where: [{ field: "userId", value: userId }],
    });
    return [...rows].sort((a, b) => iso(a.createdAt).localeCompare(iso(b.createdAt)));
  };

  const membersOf = async (orgId: string): Promise<OrgMemberRow[]> => {
    const adapter = await adapterOf();
    const members = await adapter.findMany<MemberRecord>({
      model: "member",
      where: [{ field: "organizationId", value: orgId }],
    });
    return withEmails(adapter, members);
  };

  return {
    listMembers: membersOf,

    async listAdmins(orgId) {
      return (await membersOf(orgId)).filter((row) => row.role === "owner" || row.role === "admin");
    },

    async countMembers(orgId) {
      const adapter = await adapterOf();
      return adapter.count({ model: "member", where: [{ field: "organizationId", value: orgId }] });
    },

    async membershipOf(userId, preferredOrgId) {
      const rows = await membershipRows(userId);
      if (rows.length === 0) return undefined;
      if (preferredOrgId !== undefined && preferredOrgId !== "") {
        const chosen = rows.find((row) => row.organizationId === preferredOrgId);
        if (chosen !== undefined) return { orgId: chosen.organizationId, role: roleOf(chosen.role) };
      }
      const oldest = rows[0];
      if (oldest === undefined) return undefined;
      return { orgId: oldest.organizationId, role: roleOf(oldest.role) };
    },

    async membershipsOf(userId) {
      return (await membershipRows(userId)).map((row) => ({
        orgId: row.organizationId,
        role: roleOf(row.role),
      }));
    },

    async lastActiveOrgOf(userId) {
      const adapter = await adapterOf();
      const sessions = await adapter.findMany<{ activeOrganizationId?: unknown }>({
        model: "session",
        where: [{ field: "userId", value: userId }],
        limit: 1,
        sortBy: { field: "updatedAt", direction: "desc" },
      });
      const active = sessions[0]?.activeOrganizationId;
      return typeof active === "string" && active !== "" ? active : undefined;
    },

    async lastSeenOf(userId) {
      const adapter = await adapterOf();
      const sessions = await adapter.findMany<{ updatedAt?: Date | string; createdAt?: Date | string }>({
        model: "session",
        where: [{ field: "userId", value: userId }],
        limit: 1,
        sortBy: { field: "updatedAt", direction: "desc" },
      });
      const newest = sessions[0];
      if (newest === undefined) return undefined;
      const at = newest.updatedAt ?? newest.createdAt;
      return at === undefined ? undefined : iso(at);
    },

    async findOrgBySlug(slug) {
      const adapter = await adapterOf();
      const org = await adapter.findOne<OrgRecord>({ model: "organization", where: [{ field: "slug", value: slug }] });
      return org ?? undefined;
    },

    async createOrg(input) {
      const adapter = await adapterOf();
      const created = await adapter.create<OrgRecord>({
        model: "organization",
        data: { name: input.name, slug: input.slug, createdAt: new Date() },
      });
      if (typeof created.id !== "string" || created.id === "") {
        throw new VibtraError({
          code: "INTERNAL",
          message: "The organization could not be created",
          detail: "Better Auth returned an organization row with no id",
        });
      }
      return created;
    },

    async renameOrg(orgId, name) {
      const adapter = await adapterOf();
      await adapter.update({ model: "organization", where: [{ field: "id", value: orgId }], update: { name } });
    },

    async deleteUser(userId) {
      const adapter = await adapterOf();
      await adapter.delete({ model: "account", where: [{ field: "userId", value: userId }] });
      await adapter.delete({ model: "user", where: [{ field: "id", value: userId }] });
    },

    async revokeSessions(userId) {
      const adapter = await adapterOf();
      await adapter.delete({ model: "session", where: [{ field: "userId", value: userId }] });
    },

    async markClosed(userId, at) {
      const adapter = await adapterOf();
      await adapter.update({ model: "user", where: [{ field: "id", value: userId }], update: { closedAt: at } });
    },

    async closedAtOf(userId) {
      const adapter = await adapterOf();
      const user = await adapter.findOne<{ closedAt?: Date | string | null }>({
        model: "user",
        where: [{ field: "id", value: userId }],
      });
      const at = user?.closedAt;
      return at === undefined || at === null ? undefined : iso(at);
    },

    async removeMembership(orgId, userId) {
      const adapter = await adapterOf();
      await adapter.delete({
        model: "member",
        where: [
          { field: "organizationId", value: orgId },
          { field: "userId", value: userId },
        ],
      });
    },

    async addMember(input) {
      const adapter = await adapterOf();
      const created = await adapter.create<MemberRecord>({
        model: "member",
        data: {
          organizationId: input.orgId,
          userId: input.userId,
          role: input.role,
          createdAt: new Date(),
        },
      });
      const user = await adapter.findOne<UserRecord>({ model: "user", where: [{ field: "id", value: input.userId }] });
      return {
        userId: input.userId,
        memberId: created.id,
        email: user?.email ?? "",
        name: displayName(user?.name),
        orgId: input.orgId,
        role: roleOf(created.role),
        createdAt: iso(created.createdAt),
      };
    },
  };
};
