import type { FastifyInstance } from "fastify";
import { CONSOLE_ACCEPT_INVITATION_ROUTE } from "@vibtra/console-api";
import { access } from "../auth/access.js";
import { VibtraError } from "../errors.js";
import { toWebHeaders } from "../auth/session.js";
import { postedFrom } from "../onboarding/entry-routes.js";
import type { Coordinator } from "../store/coordination.js";
import { INVITATION_REFUSALS } from "../tenancy/claim.js";
import { timed } from "../telemetry.js";
import type { ConsoleApiContext } from "./routes.js";
import { sendConsole } from "./respond.js";

const ACCEPTS_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

const INVITATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const REFUSAL_STATUS: Record<keyof typeof INVITATION_REFUSALS, number> = {
  INVITATION_NOT_FOUND: 400,
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 403,
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: 403,
};

export const registerConsoleInvitationRoutes = (app: FastifyInstance, ctx: ConsoleApiContext, limiter: Coordinator): void => {
  const auth = ctx.auth;
  if (auth === undefined) return;
  const baseOrigin = new URL(ctx.baseUrl).origin;

  app.post<{ Params: { invitationId: string } }>(CONSOLE_ACCEPT_INVITATION_ROUTE, access.public, async (req, reply) => {
    void reply.header("cache-control", "no-store");
    if (!postedFrom(req, baseOrigin)) {
      return reply.code(403).send({ code: "foreign_origin", message: "This request did not come from Guard. Open the invitation link from your email again." });
    }
    const take = await timed(req.log, "rate_limit", () => limiter.take(`console:accept-invitation:${req.ip}`, ACCEPTS_PER_MINUTE, MINUTE_MS));
    if (!take.ok) {
      if (take.firstRefusal) req.log.warn({ route: req.routeOptions.url, count: take.count }, "invitation accept rate limited");
      const wait = String(take.retryAfterSeconds);
      return reply.code(429).header("retry-after", wait).send({ code: "rate_limited", message: `Too many tries. Wait ${wait} seconds, then try again.` });
    }
    const { invitationId } = req.params;
    if (!INVITATION_ID.test(invitationId)) {
      return reply.code(REFUSAL_STATUS.INVITATION_NOT_FOUND).send({ code: "INVITATION_NOT_FOUND", message: INVITATION_REFUSALS.INVITATION_NOT_FOUND });
    }
    let claim: Awaited<ReturnType<typeof auth.acceptInvitation>>;
    try {
      claim = await timed(req.log, "invitation.accept", () => auth.acceptInvitation(toWebHeaders(req.headers), invitationId));
    } catch (error) {
      if (!(error instanceof VibtraError) || error.code !== "REGISTRY_LIMIT_EXCEEDED") throw error;
      req.log.info({ step: "accept_invitation", code: error.code, detail: error.detail }, "invitation not accepted");
      return reply.code(403).send({ code: error.code, message: error.message });
    }
    if (claim.kind === "signed_out") return reply.code(401).send({ code: "not_signed_in", message: "Sign in to accept your invitation" });
    if (claim.kind === "refused") {
      req.log.info({ step: "accept_invitation", code: claim.code }, "invitation not accepted");
      return reply.code(REFUSAL_STATUS[claim.code]).send({ code: claim.code, message: claim.message });
    }
    req.log.info({ step: "accept_invitation", org_id: claim.orgId, joined: claim.joined }, "invitation accepted");
    return sendConsole(reply, "POST /invitations/:id/accept", { orgId: claim.orgId, role: claim.role });
  });
};
