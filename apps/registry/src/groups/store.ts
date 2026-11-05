import type { RegistryAuth } from "../auth/better-auth.js";
import { normalizeAudienceEmail } from "../issuer/audience.js";
import type { AuthDbAdapter, MemberDirectory } from "../tenancy/members.js";
import type { ToolStore } from "../tools/store.js";
import type { VaultStore } from "../vault/store.js";

export interface GroupRow {
  id: string;
  name: string;
  orgId: string;
  createdAt: string;
  createdBy: string | null;
}

export interface GroupMemberRow {
  userId: string;
  email: string;
  name: string | null;
}

export interface GroupUsageRow {
  id: string;
  name: string;
}

export interface GroupUsage {
  tools: GroupUsageRow[];
  connections: GroupUsageRow[];
}

export type GroupExpansion = { ok: true; emails: string[] } | { ok: false; reason: string };

export interface GroupStore {
  list(orgId: string): Promise<GroupRow[]>;
  get(orgId: string, groupId: string): Promise<GroupRow | undefined>;
  findByName(orgId: string, name: string): Promise<GroupRow | undefined>;
  membersOf(orgId: string, groupId: string): Promise<GroupMemberRow[]>;
  groupsOf(orgId: string, email: string): Promise<GroupRow[]>;
  expand(orgId: string, groupIds: readonly string[]): Promise<GroupExpansion>;
  namesOf(orgId: string, groupIds: readonly string[]): Promise<string[] | undefined>;
  usedBy(orgId: string, groupId: string): Promise<GroupUsage>;

  listWithMembers(orgId: string): Promise<Array<GroupRow & { members: GroupMemberRow[] }>>;
  usageMap(orgId: string): Promise<Map<string, GroupUsage>>;

  create(input: GroupWrite & { name: string }): Promise<GroupRow>;
  rename(input: GroupWrite & { groupId: string; name: string }): Promise<void>;
  remove(input: GroupWrite & { groupId: string }): Promise<void>;
  addMember(input: GroupWrite & { groupId: string; userId: string }): Promise<void>;
  removeMember(input: GroupWrite & { groupId: string; userId: string }): Promise<void>;
}

export interface GroupWrite {
  orgId: string;
  headers: Headers;
}

interface TeamRecord {
  id: string;
  name: string;
  organizationId: string;
  createdAt: Date | string;
  createdBy?: string | null;
}

interface TeamMemberRecord {
  id: string;
  teamId: string;
  userId: string;
}

const iso = (value: Date | string): string => (value instanceof Date ? value.toISOString() : String(value));

const byName = (a: GroupRow, b: GroupRow): number => a.name.localeCompare(b.name);

export interface GroupStoreOptions {
  adapterOf: () => Promise<AuthDbAdapter>;
  authOf: () => RegistryAuth;
  members: MemberDirectory;
  tools?: ToolStore;
  vault?: VaultStore;
}

export const createGroupStore = (options: GroupStoreOptions): GroupStore => {
  const directoryOf = async (orgId: string): Promise<Map<string, GroupMemberRow>> => {
    const rows = await options.members.listMembers(orgId);
    return new Map(
      rows.map((row) => [
        row.userId,
        { userId: row.userId, email: normalizeAudienceEmail(row.email), name: null },
      ]),
    );
  };

  const teamsOf = async (orgId: string): Promise<GroupRow[]> => {
    const adapter = await options.adapterOf();
    const teams = await adapter.findMany<TeamRecord>({
      model: "team",
      where: [{ field: "organizationId", value: orgId }],
    });
    return teams
      .map((team) => ({
        id: team.id,
        name: team.name,
        orgId: team.organizationId,
        createdAt: iso(team.createdAt),
        createdBy: typeof team.createdBy === "string" && team.createdBy !== "" ? team.createdBy : null,
      }))
      .sort(byName);
  };

  const teamOf = async (orgId: string, groupId: string): Promise<GroupRow | undefined> => {
    const adapter = await options.adapterOf();
    const team = await adapter.findOne<TeamRecord>({ model: "team", where: [{ field: "id", value: groupId }] });
    if (team === null || team.organizationId !== orgId) return undefined;
    return {
      id: team.id,
      name: team.name,
      orgId: team.organizationId,
      createdAt: iso(team.createdAt),
      createdBy: typeof team.createdBy === "string" && team.createdBy !== "" ? team.createdBy : null,
    };
  };

  const memberRowsOf = async (
    orgId: string,
    groupId: string,
    directory?: Map<string, GroupMemberRow>,
  ): Promise<GroupMemberRow[]> => {
    const adapter = await options.adapterOf();
    const rows = await adapter.findMany<TeamMemberRecord>({
      model: "teamMember",
      where: [{ field: "teamId", value: groupId }],
    });
    const people = directory ?? (await directoryOf(orgId));
    const out: GroupMemberRow[] = [];
    for (const row of rows) {
      const person = people.get(row.userId);
      if (person === undefined) continue;
      out.push(person);
    }
    return out.sort((a, b) => a.email.localeCompare(b.email));
  };

  const auth = () => options.authOf().auth;

  return {
    list: teamsOf,
    get: teamOf,

    async findByName(orgId, name) {
      const wanted = name.trim().toLowerCase();
      return (await teamsOf(orgId)).find((row) => row.name.trim().toLowerCase() === wanted);
    },

    async membersOf(orgId, groupId) {
      if ((await teamOf(orgId, groupId)) === undefined) return [];
      const rows = await memberRowsOf(orgId, groupId);
      const adapter = await options.adapterOf();
      const named: GroupMemberRow[] = [];
      for (const row of rows) {
        const user = await adapter.findOne<{ id: string; name?: string | null }>({
          model: "user",
          where: [{ field: "id", value: row.userId }],
        });
        const name = typeof user?.name === "string" && user.name.trim() !== "" ? user.name : null;
        named.push({ ...row, name });
      }
      return named;
    },

    async groupsOf(orgId, email) {
      const wanted = normalizeAudienceEmail(email);
      const people = await directoryOf(orgId);
      const person = [...people.values()].find((row) => row.email === wanted);
      if (person === undefined) return [];
      const adapter = await options.adapterOf();
      const rows = await adapter.findMany<TeamMemberRecord>({
        model: "teamMember",
        where: [{ field: "userId", value: person.userId }],
      });
      const inOrg = new Map((await teamsOf(orgId)).map((row) => [row.id, row]));
      const out: GroupRow[] = [];
      for (const row of rows) {
        const group = inOrg.get(row.teamId);
        if (group !== undefined) out.push(group);
      }
      return out.sort(byName);
    },

    async expand(orgId, groupIds) {
      const ids = [...new Set(groupIds.map((id) => id.trim()).filter((id) => id !== ""))];
      if (ids.length === 0) {
        return { ok: false, reason: "this audience names no group at all — refused" };
      }
      let known: Map<string, GroupRow>;
      let people: Map<string, GroupMemberRow>;
      try {
        known = new Map((await teamsOf(orgId)).map((row) => [row.id, row]));
        people = await directoryOf(orgId);
      } catch {
        return { ok: false, reason: "this registry could not read the groups this is scoped to — refused" };
      }
      const missing = ids.filter((id) => !known.has(id));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `${missing.length} of the ${ids.length} group${ids.length === 1 ? "" : "s"} this is scoped to no longer exists in this org — refused`,
        };
      }
      const emails = new Set<string>();
      for (const id of ids) {
        for (const member of await memberRowsOf(orgId, id, people)) emails.add(member.email);
      }
      return { ok: true, emails: [...emails].sort() };
    },

    async namesOf(orgId, groupIds) {
      const known = new Map((await teamsOf(orgId)).map((row) => [row.id, row.name]));
      const names: string[] = [];
      for (const id of groupIds) {
        const name = known.get(id);
        if (name === undefined) return undefined;
        names.push(name);
      }
      return names;
    },

    async usedBy(orgId, groupId) {
      const tools =
        options.tools === undefined
          ? []
          : (await options.tools.listTools(orgId))
              .filter((row) => row.audienceKind === "groups" && row.audienceSubjects.includes(groupId))
              .map((row) => ({ id: row.toolId, name: row.name }));
      const connections =
        options.vault === undefined
          ? []
          : (await options.vault.listConnections(orgId))
              .filter((row) => row.scopeKind === "groups" && row.scopeSubjects.includes(groupId))
              .map((row) => ({ id: row.connectionId, name: row.displayName }));
      return { tools, connections };
    },

    async usageMap(orgId) {
      const out = new Map<string, GroupUsage>();
      for (const group of await teamsOf(orgId)) out.set(group.id, { tools: [], connections: [] });
      if (options.tools !== undefined) {
        for (const row of await options.tools.listTools(orgId)) {
          if (row.audienceKind !== "groups") continue;
          for (const id of row.audienceSubjects) out.get(id)?.tools.push({ id: row.toolId, name: row.name });
        }
      }
      if (options.vault !== undefined) {
        for (const row of await options.vault.listConnections(orgId)) {
          if (row.scopeKind !== "groups") continue;
          for (const id of row.scopeSubjects) {
            out.get(id)?.connections.push({ id: row.connectionId, name: row.displayName });
          }
        }
      }
      return out;
    },

    async listWithMembers(orgId) {
      const groups = await teamsOf(orgId);
      const people = await directoryOf(orgId);
      const adapter = await options.adapterOf();
      const byGroup = new Map<string, GroupMemberRow[]>();
      const wanted = new Set<string>();
      for (const group of groups) {
        const rows = await memberRowsOf(orgId, group.id, people);
        byGroup.set(group.id, rows);
        for (const row of rows) wanted.add(row.userId);
      }
      const names = new Map<string, string | null>();
      for (const userId of wanted) {
        const user = await adapter.findOne<{ id: string; name?: string | null }>({
          model: "user",
          where: [{ field: "id", value: userId }],
        });
        names.set(userId, typeof user?.name === "string" && user.name.trim() !== "" ? user.name : null);
      }
      return groups.map((group) => ({
        ...group,
        members: (byGroup.get(group.id) ?? []).map((row) => ({ ...row, name: names.get(row.userId) ?? null })),
      }));
    },

    async create({ orgId, headers, name }) {
      const created = await auth().api.createTeam({ headers, body: { name, organizationId: orgId } });
      const row = created as unknown as TeamRecord;
      return {
        id: row.id,
        name: row.name,
        orgId,
        createdAt: iso(row.createdAt),
        createdBy: typeof row.createdBy === "string" && row.createdBy !== "" ? row.createdBy : null,
      };
    },

    async rename({ orgId, headers, groupId, name }) {
      await auth().api.updateTeam({ headers, body: { teamId: groupId, data: { name, organizationId: orgId } } });
    },

    async remove({ orgId, headers, groupId }) {
      await auth().api.removeTeam({ headers, body: { teamId: groupId, organizationId: orgId } });
    },

    async addMember({ orgId, headers, groupId, userId }) {
      await auth().api.addTeamMember({ headers, body: { teamId: groupId, userId, organizationId: orgId } });
    },

    async removeMember({ orgId, headers, groupId, userId }) {
      await auth().api.removeTeamMember({ headers, body: { teamId: groupId, userId, organizationId: orgId } });
    },
  };
};
