import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { APIError } from "better-auth/api";
import { z } from "zod";
import { CONSOLE_API_PREFIX, OnboardingSettings, type OnboardingInviteRow, type OnboardingRow } from "@vibtra/console-api";
import { isOrgAdmin, requireSession, toWebHeaders, type RegistrySession } from "../auth/session.js";
import { VibtraError } from "../errors.js";
import { When } from "../onboarding/invitation-rows.js";
import { recordsSend } from "../onboarding/invitations.js";
import type { OnboardingService } from "../onboarding/service.js";
import { timed } from "../telemetry.js";
import { requireAdmin } from "./guard.js";
import { forbidden, notFound, sendConsole } from "./respond.js";
import type { ConsoleApiContext } from "./routes.js";

const P = `${CONSOLE_API_PREFIX}/people`;

const RenewedInvitation = z.object({
  id: z.string().min(1),
  expiresAt: When,
});

const isPendingInvite =
  (invitationId: string) =>
  (row: OnboardingRow): row is OnboardingInviteRow =>
    row.kind === "invite" && row.invitationId === invitationId;

export const registerConsoleOnboardingRoutes = (app: FastifyInstance, onboarding: OnboardingService, ctx: ConsoleApiContext): void => {
  const adminOf = (req: FastifyRequest, act: string): RegistrySession => {
    const claims = requireSession(req);
    requireAdmin(claims, act, "Nothing was changed.");
    return claims;
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
    const page = await timed(req.log, "onboarding.facts", () => onboarding.page(claims.orgId));
    const pending = page.rows.find(isPendingInvite(req.params.invitationId));
    if (pending === undefined) {
      return notFound(reply, "No such invitation here", "it is not a pending invitation of your organisation; it may have been accepted or cancelled");
    }
    let answer: unknown;
    try {
      answer = await auth.auth.api.createInvitation({
        headers: toWebHeaders(req.headers),
        body: { email: pending.email, role: pending.role, organizationId: claims.orgId, resend: true },
      });
    } catch (error) {
      if (!(error instanceof APIError)) throw error;
      return forbidden(reply, `${pending.email} could not be invited again`, `Better Auth's organization plugin refused this: ${String(error.status)}`);
    }
    const renewed = RenewedInvitation.safeParse(answer);
    if (!renewed.success) {
      throw new VibtraError({ code: "INTERNAL", message: "That invitation was not renewed", detail: "Better Auth returned an invitation row with no id or expiry" });
    }
    const { id: invitationId, expiresAt } = renewed.data;
    if (invitationId !== pending.invitationId) {
      await timed(req.log, "invitation.cancel_expired", () =>
        auth.auth.api.cancelInvitation({ headers: toWebHeaders(req.headers), body: { invitationId: pending.invitationId } }),
      );
    }
    const outcome = await timed(req.log, "invitation.deliver", () =>
      invitations.deliver({ orgId: claims.orgId, invitationId, email: pending.email, invitedBy: claims.email, expiresAt }),
    );
    if (recordsSend(outcome)) await timed(req.log, "invitation.record_sent", () => onboarding.recordInviteSent(claims.orgId, invitationId));
    return sendConsole(reply, "POST /people/invitations/:id/resend", {
      invitationId,
      email: pending.email,
      role: pending.role,
      expiresAt,
      emailed: outcome.delivery === "emailed",
      ...outcome,
    });
  });
};
