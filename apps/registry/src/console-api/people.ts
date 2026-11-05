import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { VibtraError } from "../errors.js";
import {
  CONSOLE_API_PREFIX,
  ConsoleInvitationRequest,
  ConsoleRoleRequest,
  type ConsolePersonRow,
} from "@vibtra/console-api";
import { isOrgAdmin, requireSession, toWebHeaders, wireRole, type RegistrySession } from "../auth/session.js";
import type { RegistryService } from "../service.js";
import { invitationMail } from "../mail/templates.js";
import { revokeTokensHeldBy, tokenHolderOf } from "../tenancy/token-sweep.js";
import { appendVaultAudit } from "../vault/operations.js";
import type { ConsoleApiContext } from "./routes.js";
import { forbidden, notFound, sendConsole } from "./respond.js";
import { requireAdmin } from "./guard.js";
import { identitySourcesFor } from "./sso.js";

const refuseFromAuth = (reply: FastifyReply, error: unknown, fallback: string): FastifyReply => {
  if (!(error instanceof APIError)) throw error;
  const body = error.body as { message?: unknown; code?: unknown } | undefined;
  const message = typeof body?.message === "string" && body.message !== "" ? body.message : fallback;
  const status = String(error.status);
  const code = typeof body?.code === "string" ? body.code : status;
  if (status === "NOT_FOUND" || /MEMBER_NOT_FOUND|ORGANIZATION_NOT_FOUND/.test(code)) {
    return notFound(reply, "No such person here", `${message} (${code})`);
  }
  return forbidden(reply, message, `Better Auth's organization plugin refused this: ${code}`);
};

export interface ConsolePeoplePageView {
  rows: ConsolePersonRow[];
  total: number;
  mayManage: boolean;
  mailEnabled: boolean;
}

export const consolePeoplePage = (
  service: RegistryService,
  ctx: ConsoleApiContext,
): ((claims: RegistrySession) => Promise<ConsolePeoplePageView>) => {
  const tenancy = service.tenancy;
  return async (claims: RegistrySession): Promise<ConsolePeoplePageView> => {
    const mailEnabled = ctx.mailer?.enabled === true;
    if (tenancy === undefined) return { rows: [], total: 0, mayManage: false, mailEnabled };
    const rows = await tenancy.listUsers(claims.orgId);
    const mayManage = isOrgAdmin(claims.role);
    const owners = rows.filter((row) => row.role === "owner").length;
    const identitySources =
      ctx.auth === undefined ? new Map<string, string>() : await identitySourcesFor(ctx.auth, rows.map((r) => r.userId));
    const doorsByHolder = new Map<string, Array<{ tokenId: string; name: string }>>();
    for (const token of await tenancy.listTokens(claims.orgId)) {
      if (token.revokedAt !== undefined) continue;
      const who = tokenHolderOf(token);
      const held = doorsByHolder.get(who) ?? [];
      held.push({ tokenId: token.tokenId, name: token.name });
      doorsByHolder.set(who, held);
    }
    const people: ConsolePersonRow[] = [];
    for (const row of rows) {
      const lastSeenAt = await tenancy.lastSeenOf(row.userId);
      const isYou = row.userId === claims.userId;
      people.push({
        issuer: ctx.issuer,
        subject: row.userId,
        email: row.email,
        ...(row.name === null ? {} : { name: row.name }),
        role: wireRole(row.role),
        createdAt: row.createdAt,
        memberId: row.memberId,
        orgRole: row.role,
        lastSeenAt: lastSeenAt ?? null,
        isYou,
        ...(identitySources.get(row.userId) === undefined
          ? {}
          : { identitySource: identitySources.get(row.userId) as string }),
        doorTokens: doorsByHolder.get(row.email.trim().toLowerCase()) ?? [],
        mayManage:
          mayManage &&
          !isYou &&
          !(row.role === "owner" && claims.role !== "owner") &&
          !(row.role === "owner" && owners <= 1),
      });
    }
    return { rows: people, total: await tenancy.countUsers(claims.orgId), mayManage, mailEnabled };
  };
};

export const registerConsolePeopleRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const sessionOf = (req: FastifyRequest): RegistrySession => requireSession(req);
  const peoplePage = consolePeoplePage(service, ctx);

  const memberOf = async (claims: RegistrySession, userId: string) =>
    (await tenancy.listUsers(claims.orgId)).find((row) => row.userId === userId);

  const guardTarget = async (
    claims: RegistrySession,
    userId: string,
    reply: FastifyReply,
    verb: string,
  ): Promise<{ memberId: string; email: string; role: string } | undefined> => {
    requireAdmin(claims, verb);
    const target = await memberOf(claims, userId);
    if (target === undefined) {
      void notFound(reply, "No such person here", `${JSON.stringify(userId)} is not a member of your organisation`);
      return undefined;
    }
    if (target.userId === claims.userId) {
      void forbidden(
        reply,
        "You cannot do that to your own account",
        `${target.email} is the account you are signed in as; ask another owner or admin to ${verb}.`,
      );
      return undefined;
    }
    return { memberId: target.memberId, email: target.email, role: target.role };
  };

  const LAST_OWNER = "This organisation would be left with no owner. Make somebody else an owner first";
  const lastOwnerRefusal = async (
    claims: RegistrySession,
    target: { role: string; email: string },
    nextRole?: string,
  ): Promise<string | undefined> => {
    if (target.role !== "owner") return undefined;
    if (nextRole === "owner") return undefined;
    const owners = (await tenancy.listUsers(claims.orgId)).filter((row) => row.role === "owner").length;
    if (owners > 1) return undefined;
    return (
      `${target.email} is the only owner of this organisation. An organisation must always keep at least one ` +
      "owner, or nobody can manage its people, tools and connections. Make somebody else an owner first."
    );
  };

  const authOf = (reply: FastifyReply): NonNullable<ConsoleApiContext["auth"]> | undefined => {
    if (ctx.auth !== undefined) return ctx.auth;
    void notFound(reply, "This registry has no directory", "membership is Better Auth's, and this build has none");
    return undefined;
  };

  app.post<{ Params: { userId: string } }>(`${CONSOLE_API_PREFIX}/people/:userId/role`, async (req, reply) => {
    const claims = sessionOf(req);
    const target = await guardTarget(claims, req.params.userId, reply, "change a role");
    if (target === undefined) return reply;
    const auth = authOf(reply);
    if (auth === undefined) return reply;

    const parsed = ConsoleRoleRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "Pick a role",
        detail:
          "A person is an owner, an admin or a member. " +
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }

    const emptied = await lastOwnerRefusal(claims, target, parsed.data.role);
    if (emptied !== undefined) {
      return forbidden(reply, LAST_OWNER, emptied);
    }

    try {
      await auth.auth.api.updateMemberRole({
        headers: toWebHeaders(req.headers),
        body: { memberId: target.memberId, role: parsed.data.role, organizationId: claims.orgId },
      });
    } catch (error) {
      return refuseFromAuth(reply, error, `${target.email}'s role could not be changed`);
    }
    return sendConsole(reply, "POST /people/:id/role", await peoplePage(claims));
  });

  app.delete<{ Params: { userId: string } }>(`${CONSOLE_API_PREFIX}/people/:userId`, async (req, reply) => {
    const claims = sessionOf(req);
    const target = await guardTarget(claims, req.params.userId, reply, "remove somebody");
    if (target === undefined) return reply;
    const auth = authOf(reply);
    if (auth === undefined) return reply;

    const emptied = await lastOwnerRefusal(claims, target);
    if (emptied !== undefined) {
      return forbidden(reply, LAST_OWNER, emptied);
    }

    try {
      await auth.auth.api.removeMember({
        headers: toWebHeaders(req.headers),
        body: { memberIdOrEmail: target.memberId, organizationId: claims.orgId },
      });
    } catch (error) {
      return refuseFromAuth(reply, error, `${target.email} could not be removed`);
    }
    await revokeTokensHeldBy(tenancy, {
      orgId: claims.orgId,
      email: target.email,
      at: new Date().toISOString(),
    });

    return sendConsole(reply, "DELETE /people/:id", await peoplePage(claims));
  });

  app.post(`${CONSOLE_API_PREFIX}/people/invitations`, async (req, reply) => {
    const claims = sessionOf(req);
    requireAdmin(
      claims,
      "invite somebody to this organisation",
      "Ask an owner or an admin to send it. Nothing was created.",
    );
    const auth = authOf(reply);
    if (auth === undefined) return reply;

    const parsed = ConsoleInvitationRequest.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "That invitation is not valid",
        detail:
          "an invitation is one email address and one role — `member` or `admin`. " +
          parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
      });
    }
    const email = parsed.data.email.trim().toLowerCase();

    let created: { id?: unknown; email?: unknown; role?: unknown; expiresAt?: unknown };
    try {
      created = (await auth.auth.api.createInvitation({
        headers: toWebHeaders(req.headers),
        body: { email, role: parsed.data.role, organizationId: claims.orgId },
      })) as { id?: unknown; email?: unknown; role?: unknown; expiresAt?: unknown };
    } catch (error) {
      return refuseFromAuth(reply, error, `${email} could not be invited`);
    }
    if (typeof created.id !== "string" || created.id === "") {
      throw new VibtraError({
        code: "INTERNAL",
        message: "That invitation was not created",
        detail: "Better Auth returned an invitation row with no id, so there is no link to copy",
      });
    }
    const expiresAt = created.expiresAt;
    const expiresWord =
      expiresAt instanceof Date
        ? expiresAt.toISOString()
        : typeof expiresAt === "string" && expiresAt !== ""
          ? expiresAt
          : undefined;

    const org = ctx.mailer === undefined || !ctx.mailer.enabled ? undefined : await tenancy.getOrg(claims.orgId);
    const emailed =
      ctx.mailer === undefined
        ? false
        : await ctx.mailer.send(
            invitationMail({
              baseUrl: ctx.baseUrl,
              handle: org?.handle,
              orgName: org?.name ?? claims.orgId,
              to: email,
              invitedBy: claims.email,
              invitationId: created.id,
              ...(expiresWord === undefined ? {} : { expiresAt: expiresWord }),
            }),
          );

    return sendConsole(reply, "POST /people/invitations", {
      invitationId: created.id,
      email: typeof created.email === "string" && created.email !== "" ? created.email : email,
      role: parsed.data.role,
      ...(expiresWord === undefined ? {} : { expiresAt: expiresWord }),
      emailed,
    });
  });

  app.delete<{ Params: { invitationId: string } }>(
    `${CONSOLE_API_PREFIX}/people/invitations/:invitationId`,
    async (req, reply) => {
      const claims = sessionOf(req);
      requireAdmin(
        claims,
        "cancel an invitation",
        "Ask an owner or an admin to cancel it. Nothing was changed.",
      );
      const auth = authOf(reply);
      if (auth === undefined) return reply;

      try {
        await auth.auth.api.cancelInvitation({
          headers: toWebHeaders(req.headers),
          body: { invitationId: req.params.invitationId },
        });
      } catch (error) {
        return refuseFromAuth(reply, error, "That invitation could not be cancelled");
      }
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { userId: string } }>(
    `${CONSOLE_API_PREFIX}/people/:userId/sessions/revoke`,
    async (req, reply) => {
      const claims = sessionOf(req);
      const target = await guardTarget(claims, req.params.userId, reply, "sign somebody out everywhere");
      if (target === undefined) return reply;
      const auth = authOf(reply);
      if (auth === undefined) return reply;

      await auth.members.revokeSessions(req.params.userId);

      const vault = service.vault;
      if (vault !== undefined) {
        await appendVaultAudit(vault, {
          orgId: claims.orgId,
          event: "sessions.revoked",
          actorKind: "admin",
          actor: claims.email,
          outcome: "allowed",
          detail: `every session of ${target.email} was ended from the People page`,
        });
      }

      return sendConsole(reply, "POST /people/:id/sessions/revoke", await peoplePage(claims));
    },
  );
};
