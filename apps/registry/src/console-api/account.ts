import type { FastifyInstance, FastifyRequest } from "fastify";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import type { RegistrySession } from "../auth/session.js";
import type { RegistryService } from "../service.js";
import { ORG_CLOSURE_RETENTION_DAYS, type TenancyStore } from "../tenancy/store.js";
import { revokeTokensHeldBy } from "../tenancy/token-sweep.js";
import type { ConsoleApiContext } from "./routes.js";
import { forbidden, notFound, sendConsole } from "./respond.js";

export const soleOwnerRefusal = (orgName: string): string =>
  `You are the only owner of ${orgName}. Make somebody else an owner on the People page first, then ` +
  "close your account — an organisation with no owner cannot be administered, and there is no way back.";

export const SOLE_OWNER_REFUSAL = soleOwnerRefusal("this organisation");

export const registerConsoleAccountRoutes = (
  app: FastifyInstance,
  service: RegistryService,
  ctx: ConsoleApiContext,
  sessionOf: (req: FastifyRequest) => RegistrySession,
): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const orgs: TenancyStore = tenancy;
  const now = ctx.now ?? (() => new Date());

  app.post(`${CONSOLE_API_PREFIX}/account/close`, async (req, reply) => {
    const claims = sessionOf(req);
    const auth = ctx.auth;
    if (auth === undefined) {
      return notFound(reply, "This registry has no accounts", "there is no directory to close an account in");
    }

    const memberships = await auth.members.membershipsOf(claims.userId);

    for (const membership of memberships) {
      if (membership.role !== "owner") continue;
      const owners = (await orgs.listAdmins(membership.orgId)).filter((row) => row.role === "owner");
      if (owners.length === 1 && owners[0]?.userId === claims.userId) {
        const named =
          membership.orgId === claims.orgId
            ? "this organisation"
            : (await orgs.getOrg(membership.orgId))?.name ?? membership.orgId;
        return forbidden(reply, "Hand the owner role over first", soleOwnerRefusal(named));
      }
    }

    const at = now().toISOString();

    await auth.members.markClosed(claims.userId, at);
    await auth.members.revokeSessions(claims.userId);
    let revokedCount = 0;
    for (const membership of memberships) {
      const revoked = await revokeTokensHeldBy(orgs, {
        orgId: membership.orgId,
        email: claims.email,
        at,
      });
      revokedCount += revoked.length;
    }
    for (const membership of memberships) {
      await auth.members.removeMembership(membership.orgId, claims.userId);
    }

    return sendConsole(reply, "POST /account/close", {
      closedAt: at,
      email: claims.email,
      sessionsRevoked: true,
      doorTokensRevoked: revokedCount,
      membershipRemoved: true,
      retentionDays: ORG_CLOSURE_RETENTION_DAYS,
      notice:
        "Your account is closed. You are signed out everywhere, every door token you held is revoked, and you " +
        "are no longer a member of this organisation. Your name stays on everything you did — the ledger is " +
        `append-only and is never rewritten. If this organisation is ever closed, its records are kept for ` +
        `${ORG_CLOSURE_RETENTION_DAYS} days and then deleted. Signing in again is refused; ask an owner or ` +
        "admin to invite you if you need access back.",
    });
  });
};
