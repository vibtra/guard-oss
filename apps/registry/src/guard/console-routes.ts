import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GUARD_CONSOLE_API_PREFIX, GUARD_CONSOLE_RESPONSE_SCHEMAS, GUARD_PROTECTION_API_PREFIX, type GuardConsoleDoor } from "@vibtra/guard-contract";
import { access } from "../auth/access.js";
import { requireSession, type RegistrySession } from "../auth/session.js";
import { GuardError, type GuardService } from "./service.js";
import { GUARD_OFF_BODY, sendGuardError } from "./sync-routes.js";

export const sendGuard = <D extends GuardConsoleDoor>(reply: FastifyReply, door: D, value: unknown, status = 200): FastifyReply =>
  reply.code(status).send(GUARD_CONSOLE_RESPONSE_SCHEMAS[door].parse(value));

export interface GuardConsoleRoutesContext {
  guard: GuardService | undefined;
}

const activityQueryOf = (raw: Record<string, unknown>): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || v === "") continue;
    out[k] = k === "limit" ? Number(v) : v;
  }
  return out;
};

export const registerGuardConsoleRoutes = (app: FastifyInstance, ctx: GuardConsoleRoutesContext): void => {
  const P = GUARD_CONSOLE_API_PREFIX;
  type Handler<R extends FastifyRequest> = (guard: GuardService, claims: RegistrySession, req: R, reply: FastifyReply) => Promise<unknown>;
  const withGuard =
    <R extends FastifyRequest>(handler: Handler<R>) =>
    async (req: R, reply: FastifyReply) => {
      const claims = requireSession(req);
      const guard = ctx.guard;
      if (guard === undefined) return reply.code(404).send(GUARD_OFF_BODY);
      try {
        return await handler(guard, claims, req, reply);
      } catch (error) {
        return sendGuardError(reply, error);
      }
    };
  const actor = (claims: RegistrySession) => ({ email: claims.email });

  app.get<{ Querystring: { days?: string } }>(
    `${P}/overview`,
    access.admin("read Guard's exposure report"),
    withGuard(async (guard, claims, req, reply) => {
      const raw = req.query.days ?? "7";
      if (raw !== "7" && raw !== "30") throw new GuardError(400, "VALIDATION", "The overview covers 7 or 30 days", `days=${raw}`);
      return sendGuard(reply, "GET /guard/overview", await guard.overview(claims.orgId, raw === "30" ? 30 : 7));
    }),
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    `${P}/activity`,
    access.admin("read Guard's activity"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "GET /guard/activity", await guard.activity(claims.orgId, activityQueryOf(req.query ?? {})))),
  );

  app.get(`${P}/rules`, access.admin("read Guard's rules"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/rules", await guard.rulesPage(claims.orgId))));
  app.put(`${P}/rules`, access.admin("change Guard's rules"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/rules", await guard.putRules(claims.orgId, actor(claims), req.body))));
  app.post(`${P}/rules/test`, access.admin("test Guard's rules"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/rules/test", await guard.testRules(claims.orgId, req.body))));

  app.get(`${P}/devices`, access.admin("list Guard's devices"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/devices", await guard.devicesPage(claims.orgId))));
  app.post(
    `${P}/devices/enrol-links`,
    access.admin("mint a Guard enrol link"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/devices/enrol-links", await guard.mintEnrolLink(claims.orgId, actor(claims), req.body), 201)),
  );
  app.get(`${P}/devices/enrol-links`, access.admin("list Guard's enrol links"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/devices/enrol-links", await guard.enrolLinks(claims.orgId))));
  app.post<{ Params: { id: string } }>(
    `${P}/devices/:id/revoke`,
    access.admin("revoke a Guard device"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/devices/:id/revoke", await guard.revokeDevice(claims.orgId, actor(claims), req.params.id))),
  );

  app.get(`${P}/services`, access.admin("read Guard's AI services"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/services", await guard.servicesPage(claims.orgId))));
  app.post(`${P}/services`, access.admin("add an AI service"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/services", await guard.createService(claims.orgId, actor(claims), req.body), 201)));
  app.put<{ Params: { id: string } }>(
    `${P}/services/:id`,
    access.admin("change an AI service"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/services/:id", await guard.updateService(claims.orgId, actor(claims), req.params.id, req.body))),
  );
  app.delete<{ Params: { id: string } }>(
    `${P}/services/:id`,
    access.admin("remove an AI service"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "DELETE /guard/services/:id", await guard.deleteService(claims.orgId, actor(claims), req.params.id))),
  );

  app.get(`${P}/settings`, access.admin("read Guard's settings"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/settings", await guard.settingsPage(claims.orgId))));
  app.put(`${P}/settings`, access.admin("change Guard's settings"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/settings", await guard.putSettings(claims.orgId, actor(claims), req.body))));

  const PP = GUARD_PROTECTION_API_PREFIX;
  app.get(PP, access.admin("read each person's protection"), withGuard(async (guard, claims, _req, reply) => sendGuard(reply, "GET /people/protection", await guard.protectionPage(claims.orgId))));
  app.post(`${PP}/preview`, access.admin("preview a protection change"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /people/protection/preview", await guard.previewProtection(claims.orgId, req.body))));
  app.post(`${PP}/apply`, access.admin("change people's protection"), withGuard(async (guard, claims, req, reply) => sendGuard(reply, "POST /people/protection/apply", await guard.applyProtection(claims.orgId, actor(claims), req.body))));
  app.get<{ Querystring: Record<string, unknown> }>(
    `${PP}/rollout`,
    access.admin("follow a protection change"),
    withGuard(async (guard, claims, req, reply) => sendGuard(reply, "GET /people/protection/rollout", await guard.protectionRollout(claims.orgId, req.query ?? {}))),
  );
};
