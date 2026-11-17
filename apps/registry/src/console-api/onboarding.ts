import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { CONSOLE_API_PREFIX, ConsoleInviteRole, OnboardingSettings } from "@vibtra/console-api";
import { isOrgAdmin, requireSession, toWebHeaders, type RegistrySession } from "../auth/session.js";
import { VibtraError } from "../errors.js";
import { onboardingMemberOf, pendingInvitation, When } from "../onboarding/invitation-rows.js";
import { recordsSend } from "../onboarding/invitations.js";
import type { OnboardingService } from "../onboarding/service.js";
import type { Coordinator } from "../store/coordination.js";
import { timed } from "../telemetry.js";
import { requireAdmin } from "./guard.js";
import { forbidden, notFound, refuseWithStatus, sendConsole } from "./respond.js";
import type { ConsoleApiContext } from "./routes.js";

const P = `${CONSOLE_API_PREFIX}/people`;

const SENDS_PER_PERSON_PER_HOUR = 5;

const HOUR_MS = 3_600_000;

const RenewedInvitation = z.object({ id: z.string().min(1), expiresAt: When });

const authRefusalStatus = (error: APIError): number => (error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : 403);

export const registerConsoleOnboardingRoutes = (app: FastifyInstance, onboarding: OnboardingService, ctx: ConsoleApiContext, limiter: Coordinator): void => {
  const adminOf = (req: FastifyRequest, act: string): RegistrySession => {
    const claims = requireSession(req);
    requireAdmin(claims, act, "Nothing was changed.");
    return claims;
  };

  const sendAllowed = async (req: FastifyRequest, reply: FastifyReply, orgId: string, email: string): Promise<boolean> => {
    const take = await timed(req.log, "rate_limit", () => limiter.take(`onboarding-send:${orgId}:${email}`, SENDS_PER_PERSON_PER_HOUR, HOUR_MS));
    if (take.ok) return true;
    if (take.firstRefusal) req.log.warn({ route: req.routeOptions.url, count: take.count }, "onboarding send rate limited");
    void refuseWithStatus(
      reply.header("retry-after", String(take.retryAfterSeconds)),
      429,
      "REGISTRY_LIMIT_EXCEEDED",
      "That person was sent enough email for now",
      `Guard sends one person at most ${String(SENDS_PER_PERSON_PER_HOUR)} onboarding emails an hour. Try again in ${String(take.retryAfterSeconds)} seconds. Nothing was sent.`,
    );
    return false;
  };

  app.get(`${P}/onboarding`, async (req, reply) => {
    const claims = adminOf(req, "see where each person is in onboarding");
    return sendConsole(reply, "GET /people/onboarding", await timed(req.log, "onboarding.facts", () => onboarding.page(claims.orgId)));
  });

  app.get(`${P}/onboarding/chase`, async (req, reply) => {
    const claims = adminOf(req, "see who needs chasing");
    return sendConsole(reply, "GET /people/onboarding/chase", await timed(req.log, "onboarding.facts", () => onboarding.chaseList(claims.orgId)));
  });

  app.get(`${P}/onboarding/settings`, async (req, reply) => {
    const claims = requireSession(req);
    return sendConsole(reply, "GET /people/onboarding/settings", { ...(await onboarding.settings(claims.orgId)), mayEdit: isOrgAdmin(claims.role) });
  });

  app.put(`${P}/onboarding/settings`, async (req, reply) => {
    const claims = adminOf(req, "change when people are chased");
    const parsed = OnboardingSettings.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new VibtraError({
        code: "VALIDATION",
        message: "chaseAfterDays must be a whole number of days from 1 to 365",
        detail: `Send { "chaseAfterDays": 7 }. Nothing was changed. ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      });
    }
    const saved = await timed(req.log, "orgs.chase_after_days", () => onboarding.setChaseAfterDays(claims.orgId, parsed.data.chaseAfterDays));
    return sendConsole(reply, "PUT /people/onboarding/settings", { ...saved, mayEdit: true });
  });

  app.post<{ Params: { invitationId: string } }>(`${P}/invitations/:invitationId/resend`, async (req, reply): Promise<FastifyReply> => {
    const claims = adminOf(req, "re-send an invitation");
    const auth = ctx.auth;
    const invitations = ctx.invitations;
    if (auth === undefined || invitations === undefined) return notFound(reply, "This registry has no directory", "invitations are Better Auth's, and this build has none");
    const adapter = await auth.adapter();
    const pending = await timed(req.log, "invitation.lookup", () => pendingInvitation(adapter, claims.orgId, req.params.invitationId));
    if (pending === undefined) {
      return notFound(reply, "No such invitation here", "it is not a pending invitation of your organisation; it may have been accepted or cancelled");
    }
    const role = ConsoleInviteRole.safeParse(pending.role ?? "member");
    if (!role.success) return forbidden(reply, `${pending.email} cannot be invited again from here`, "only member and admin invitations are re-sent from the console");
    if (!(await sendAllowed(req, reply, claims.orgId, pending.email))) return reply;
    let answer: unknown;
    try {
      answer = await auth.auth.api.createInvitation({
        headers: toWebHeaders(req.headers),
        body: { email: pending.email, role: role.data, organizationId: claims.orgId, resend: true },
      });
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      const body = error.body as { message?: unknown } | undefined;
      const message = typeof body?.message === "string" && body.message !== "" ? body.message : `${pending.email} could not be invited again`;
      return refuseWithStatus(reply, authRefusalStatus(error), "VALIDATION", message, `Better Auth's organization plugin refused this: ${String(error.status)}. Nothing was sent.`);
    }
    const renewed = RenewedInvitation.safeParse(answer);
    if (!renewed.success) {
      throw new VibtraError({ code: "INTERNAL", message: "That invitation was not renewed", detail: "Better Auth returned an invitation row with no id or expiry" });
    }
    const { id: invitationId, expiresAt } = renewed.data;
    if (invitationId !== pending.id) {
      await timed(req.log, "invitation.cancel_expired", () => auth.auth.api.cancelInvitation({ headers: toWebHeaders(req.headers), body: { invitationId: pending.id } }));
    }
    const { outcome, sentAt } = await timed(req.log, "invitation.deliver", () =>
      invitations.deliver({ orgId: claims.orgId, invitationId, email: pending.email, invitedBy: claims.email, expiresAt }),
    );
    if (recordsSend(outcome)) await timed(req.log, "invitation.record_sent", () => onboarding.recordInviteSent(claims.orgId, invitationId, sentAt));
    return sendConsole(reply, "POST /people/invitations/:id/resend", {
      invitationId,
      email: pending.email,
      role: role.data,
      expiresAt,
      emailed: outcome.delivery === "emailed",
      ...outcome,
    });
  });

  app.post<{ Params: { userId: string } }>(`${P}/:userId/onboarding/remind`, async (req, reply): Promise<FastifyReply> => {
    const claims = adminOf(req, "remind somebody to enrol their Mac");
    const auth = ctx.auth;
    const invitations = ctx.invitations;
    if (auth === undefined || invitations === undefined) return notFound(reply, "This registry has no directory", "membership is Better Auth's, and this build has none");
    const adapter = await auth.adapter();
    const member = await timed(req.log, "member.lookup", () => onboardingMemberOf(adapter, claims.orgId, req.params.userId));
    if (member === undefined) return notFound(reply, "No such person here", "they are not a member of your organisation. Nothing was sent.");
    const position = (await timed(req.log, "onboarding.facts", () => onboarding.positions(claims.orgId))).get(member.userId);
    if (position?.stage !== "signed_in") {
      return refuseWithStatus(
        reply,
        409,
        "VALIDATION",
        `${member.email} is not waiting to enrol a Mac`,
        `A reminder goes to somebody who has signed in and has no Mac enrolled yet; ${member.email} is ${position?.stage ?? "not in onboarding"}. Nothing was sent.`,
      );
    }
    if (!(await sendAllowed(req, reply, claims.orgId, member.email))) return reply;
    const { outcome, sentAt } = await timed(req.log, "reminder.deliver", () =>
      invitations.remind({ orgId: claims.orgId, memberId: member.memberId, email: member.email, remindedBy: claims.email, linkGeneration: member.linkGeneration }),
    );
    const recorded = recordsSend(outcome);
    if (recorded) await timed(req.log, "reminder.record_sent", () => onboarding.recordReminderSent(claims.orgId, member.userId, sentAt));
    return sendConsole(reply, "POST /people/:id/onboarding/remind", {
      userId: member.userId,
      email: member.email,
      ...(recorded ? { lastSentAt: sentAt } : {}),
      ...outcome,
    });
  });
};
