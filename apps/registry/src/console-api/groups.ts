import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { VibtraError } from "../errors.js";
import {
  CONSOLE_API_PREFIX,
  ConsoleGroupMemberRequest,
  ConsoleGroupNameRequest,
  MY_GROUPS_RESPONSE_SCHEMAS,
  type ConsoleGroupRow,
} from "@vibtra/console-api";
import { isOrgAdmin, toWebHeaders, type RegistrySession } from "../auth/session.js";
import type { GroupStore } from "../groups/store.js";
import { normalizeAudienceEmail } from "../issuer/audience.js";
import type { RegistryService } from "../service.js";
import { appendVaultAudit } from "../vault/operations.js";
import type { ConsoleApiContext } from "./routes.js";
import { forbidden, notFound, sendConsole } from "./respond.js";
import { requireAdmin } from "./guard.js";

const refuseFromAuth = (reply: FastifyReply, error: unknown, fallback: string): FastifyReply => {
  if (!(error instanceof APIError)) throw error;
  const body = error.body as { message?: unknown; code?: unknown } | undefined;
  const message = typeof body?.message === "string" && body.message !== "" ? body.message : fallback;
  const status = String(error.status);
  const code = typeof body?.code === "string" ? body.code : status;
  if (status === "NOT_FOUND" || /TEAM_NOT_FOUND|ORGANIZATION_NOT_FOUND|USER_IS_NOT_A_MEMBER/.test(code)) {
    return notFound(reply, "No such group here", `${message} (${code})`);
  }
  return forbidden(reply, message, `Better Auth's organization plugin refused this: ${code}`);
};

export const registerConsoleGroupRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
  sessionOf: (req: FastifyRequest) => RegistrySession,
): void => {
  const now = ctx.now ?? (() => new Date());

  const storeOf = (reply: FastifyReply): GroupStore | undefined => {
    if (ctx.groups !== undefined) return ctx.groups;
    void notFound(
      reply,
      "This registry has no groups",
      "a group is a Better Auth team (migration 0013), and this build was constructed without sign-in",
    );
    return undefined;
  };

  const GROUPS_ARE_ACCESS =
    "A group is an audience and a connection scope, so changing one changes who can reach data.";

  const rowView = async (store: GroupStore, orgId: string, groupId: string): Promise<ConsoleGroupRow | undefined> => {
    const group = await store.get(orgId, groupId);
    if (group === undefined) return undefined;
    const members = await store.membersOf(orgId, groupId);
    const usage = await store.usedBy(orgId, groupId);
    return {
      id: group.id,
      name: group.name,
      members: members.map((member) => ({ email: member.email, name: member.name })),
      memberCount: members.length,
      usedBy: { tools: usage.tools.length, connections: usage.connections.length },
      createdAt: group.createdAt,
      createdBy: group.createdBy ?? "unknown",
    };
  };

  const audit = async (row: {
    orgId: string;
    event: "group.created" | "group.renamed" | "group.deleted" | "group.member.added" | "group.member.removed";
    actor: string;
    detail: string;
  }): Promise<void> => {
    const vault = service.vault;
    if (vault === undefined) return;
    await appendVaultAudit(
      vault,
      { orgId: row.orgId, event: row.event, actorKind: "admin", actor: row.actor, outcome: "allowed", detail: row.detail },
      now().toISOString(),
    );
  };

  const cleanName = (raw: string): string => raw.trim().replace(/\s+/g, " ");

  app.get(`${CONSOLE_API_PREFIX}/groups`, async (req, reply) => {
    const claims = sessionOf(req);
    const store = ctx.groups;
    if (store === undefined) return sendConsole(reply, "GET /groups", { rows: [] });
    const mayReadMembers = isOrgAdmin(claims.role);
    const usage = await store.usageMap(claims.orgId);
    const rows: ConsoleGroupRow[] = (await store.listWithMembers(claims.orgId)).map((group) => ({
      id: group.id,
      name: group.name,
      ...(mayReadMembers
        ? { members: group.members.map((member) => ({ email: member.email, name: member.name })) }
        : {}),
      memberCount: group.members.length,
      usedBy: {
        tools: usage.get(group.id)?.tools.length ?? 0,
        connections: usage.get(group.id)?.connections.length ?? 0,
      },
      createdAt: group.createdAt,
      ...(mayReadMembers ? { createdBy: group.createdBy ?? "unknown" } : {}),
    }));
    return sendConsole(reply, "GET /groups", { rows });
  });

  app.get(`${CONSOLE_API_PREFIX}/me/groups`, async (req, reply) => {
    const claims = sessionOf(req);
    void reply.header("cache-control", "no-store");
    const store = ctx.groups;
    const rows =
      store === undefined
        ? []
        : (await store.groupsOf(claims.orgId, normalizeAudienceEmail(claims.email)))
            .map((group) => ({ id: group.id, name: group.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    return reply.send(MY_GROUPS_RESPONSE_SCHEMAS["GET /me/groups"].parse({ rows }));
  });

  app.post(`${CONSOLE_API_PREFIX}/groups`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(claims, "create a group", GROUPS_ARE_ACCESS);
    const store = storeOf(reply);
    if (store === undefined) return reply;

    const parsed = ConsoleGroupNameRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Give the group a name",
        detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }
    const name = cleanName(parsed.data.name);
    if (name === "") {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Give the group a name",
        detail: "A group's name is what an admin picks it by in an audience form; whitespace is not one.",
      });
    }
    if ((await store.findByName(claims.orgId, name)) !== undefined) {
      return reply.code(409).send({
        ...new VibtraError({
          code: "VALIDATION",
          message: "That group already exists",
          detail: `this org already has a group called «${name}» — rename that one, or pick another name`,
        }).toJSON(),
      });
    }

    let created;
    try {
      created = await store.create({ orgId: claims.orgId, headers: toWebHeaders(req.headers), name });
    } catch (error) {
      return refuseFromAuth(reply, error, "That group could not be created");
    }
    await audit({
      orgId: claims.orgId,
      event: "group.created",
      actor: claims.email,
      detail: `group ${created.id} «${created.name}»`,
    });
    const row = await rowView(store, claims.orgId, created.id);
    if (row === undefined) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "That group was created and could not be read back",
        detail: `group ${created.id} is not readable in org ${claims.orgId} immediately after its creation`,
      });
    }
    void reply.code(201);
    return sendConsole(reply, "POST /groups", { row });
  });

  app.patch<{ Params: { id: string } }>(`${CONSOLE_API_PREFIX}/groups/:id`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(claims, "rename a group", GROUPS_ARE_ACCESS);
    const store = storeOf(reply);
    if (store === undefined) return reply;

    const group = await store.get(claims.orgId, req.params.id);
    if (group === undefined) {
      return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
    }
    const parsed = ConsoleGroupNameRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Give the group a name",
        detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }
    const name = cleanName(parsed.data.name);
    if (name === "") {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Give the group a name",
        detail: "A group's name is what an admin picks it by in an audience form; whitespace is not one.",
      });
    }
    const clash = await store.findByName(claims.orgId, name);
    if (clash !== undefined && clash.id !== group.id) {
      return reply.code(409).send({
        ...new VibtraError({
          code: "VALIDATION",
          message: "That group already exists",
          detail: `this org already has a group called «${name}» — rename that one, or pick another name`,
        }).toJSON(),
      });
    }

    try {
      await store.rename({ orgId: claims.orgId, headers: toWebHeaders(req.headers), groupId: group.id, name });
    } catch (error) {
      return refuseFromAuth(reply, error, `«${group.name}» could not be renamed`);
    }
    await audit({
      orgId: claims.orgId,
      event: "group.renamed",
      actor: claims.email,
      detail: `group ${group.id}: «${group.name}» → «${name}»`,
    });
    const row = await rowView(store, claims.orgId, group.id);
    if (row === undefined) {
      return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
    }
    return sendConsole(reply, "PATCH /groups/:id", { row });
  });

  app.delete<{ Params: { id: string } }>(`${CONSOLE_API_PREFIX}/groups/:id`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(claims, "delete a group", GROUPS_ARE_ACCESS);
    const store = storeOf(reply);
    if (store === undefined) return reply;

    const group = await store.get(claims.orgId, req.params.id);
    if (group === undefined) {
      return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
    }
    const usage = await store.usedBy(claims.orgId, group.id);
    if (usage.tools.length > 0 || usage.connections.length > 0) {
      const n = usage.tools.length + usage.connections.length;
      void reply.code(409);
      return sendConsole(reply, "DELETE /groups/:id?inUse", {
        message: `«${group.name}» is still in use`,
        usedBy: usage,
        code: "VALIDATION",
        detail:
          `${n} thing${n === 1 ? "" : "s"} still name${n === 1 ? "s" : ""} this group — ` +
          `${usage.tools.length} tool audience${usage.tools.length === 1 ? "" : "s"} and ` +
          `${usage.connections.length} connection scope${usage.connections.length === 1 ? "" : "s"}. ` +
          "Change each of them first: deleting the group would leave an audience naming an id nothing can " +
          "resolve, which refuses everybody and says nothing about why.",
      });
    }

    try {
      await store.remove({ orgId: claims.orgId, headers: toWebHeaders(req.headers), groupId: group.id });
    } catch (error) {
      return refuseFromAuth(reply, error, `«${group.name}» could not be deleted`);
    }
    await audit({
      orgId: claims.orgId,
      event: "group.deleted",
      actor: claims.email,
      detail: `group ${group.id} «${group.name}»`,
    });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(`${CONSOLE_API_PREFIX}/groups/:id/members`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(claims, "change who is in a group", GROUPS_ARE_ACCESS);
    const store = storeOf(reply);
    if (store === undefined) return reply;

    const group = await store.get(claims.orgId, req.params.id);
    if (group === undefined) {
      return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
    }
    const parsed = ConsoleGroupMemberRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Name somebody to add",
        detail: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }
    const person = await personOf(claims, parsed.data.email);
    if (person === undefined) {
      return notFound(
        reply,
        "No such person here",
        `${JSON.stringify(parsed.data.email)} is not a member of your organisation — a group can only hold ` +
          "people who are already in it. Have them sign in first.",
      );
    }

    try {
      await store.addMember({
        orgId: claims.orgId,
        headers: toWebHeaders(req.headers),
        groupId: group.id,
        userId: person.userId,
      });
    } catch (error) {
      return refuseFromAuth(reply, error, `${person.email} could not be added to «${group.name}»`);
    }
    await audit({
      orgId: claims.orgId,
      event: "group.member.added",
      actor: claims.email,
      detail: `group ${group.id} «${group.name}» + ${person.email}`,
    });
    const row = await rowView(store, claims.orgId, group.id);
    if (row === undefined) {
      return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
    }
    return sendConsole(reply, "POST /groups/:id/members", { row });
  });

  app.delete<{ Params: { id: string; email: string } }>(
    `${CONSOLE_API_PREFIX}/groups/:id/members/:email`,
    async (req, reply) => {
      const claims = sessionOf(req);
      requireAdmin(claims, "change who is in a group", GROUPS_ARE_ACCESS);
      const store = storeOf(reply);
      if (store === undefined) return reply;

      const group = await store.get(claims.orgId, req.params.id);
      if (group === undefined) {
        return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
      }
      const person = await personOf(claims, decodeURIComponent(req.params.email));
      if (person === undefined) {
        return notFound(
          reply,
          "No such person here",
          `${JSON.stringify(req.params.email)} is not a member of your organisation`,
        );
      }

      try {
        await store.removeMember({
          orgId: claims.orgId,
          headers: toWebHeaders(req.headers),
          groupId: group.id,
          userId: person.userId,
        });
      } catch (error) {
        return refuseFromAuth(reply, error, `${person.email} could not be removed from «${group.name}»`);
      }
      await audit({
        orgId: claims.orgId,
        event: "group.member.removed",
        actor: claims.email,
        detail: `group ${group.id} «${group.name}» − ${person.email}`,
      });
      const row = await rowView(store, claims.orgId, group.id);
      if (row === undefined) {
        return notFound(reply, "No such group", `group ${JSON.stringify(req.params.id)} is unknown to your org`);
      }
      return sendConsole(reply, "DELETE /groups/:id/members/:email", { row });
    },
  );

  async function personOf(
    claims: RegistrySession,
    email: string,
  ): Promise<{ userId: string; email: string } | undefined> {
    const tenancy = service.tenancy;
    if (tenancy === undefined) return undefined;
    const wanted = normalizeAudienceEmail(email);
    if (wanted === "") return undefined;
    const person = (await tenancy.listUsers(claims.orgId)).find(
      (row) => normalizeAudienceEmail(row.email) === wanted,
    );
    return person === undefined ? undefined : { userId: person.userId, email: normalizeAudienceEmail(person.email) };
  }
};
