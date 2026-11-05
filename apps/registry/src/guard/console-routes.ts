import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GUARD_CONSOLE_API_PREFIX, GUARD_CONSOLE_RESPONSE_SCHEMAS, type GuardConsoleDoor } from "@vibtra/guard-contract";
import { requireSession, type RegistrySession } from "../auth/session.js";
import { requireAdmin } from "../console-api/guard.js";
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
  const admin =
    <R extends FastifyRequest>(act: string, handler: Handler<R>) =>
    async (req: R, reply: FastifyReply) => {
      const claims = requireSession(req);
      requireAdmin(claims, act);
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
    admin("read Guard's exposure report", async (guard, claims, req, reply) => {
      const raw = req.query.days ?? "7";
      if (raw !== "7" && raw !== "30") throw new GuardError(400, "VALIDATION", "The overview covers 7 or 30 days", `days=${raw}`);
      return sendGuard(reply, "GET /guard/overview", await guard.overview(claims.orgId, raw === "30" ? 30 : 7));
    }),
  );

  app.get<{ Querystring: Record<string, unknown> }>(
    `${P}/activity`,
    admin("read Guard's activity", async (guard, claims, req, reply) => sendGuard(reply, "GET /guard/activity", await guard.activity(claims.orgId, activityQueryOf(req.query ?? {})))),
  );

  app.get(`${P}/rules`, admin("read Guard's rules", async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/rules", await guard.rulesPage(claims.orgId))));
  app.put(`${P}/rules`, admin("change Guard's rules", async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/rules", await guard.putRules(claims.orgId, actor(claims), req.body))));
  app.post(`${P}/rules/test`, admin("test Guard's rules", async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/rules/test", await guard.testRules(claims.orgId, req.body))));

  app.get(`${P}/devices`, admin("list Guard's devices", async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/devices", await guard.devicesPage(claims.orgId))));
  app.post(
    `${P}/devices/enrol-links`,
    admin("mint a Guard enrol link", async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/devices/enrol-links", await guard.mintEnrolLink(claims.orgId, actor(claims), req.body), 201)),
  );
  app.get(`${P}/devices/enrol-links`, admin("list Guard's enrol links", async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/devices/enrol-links", await guard.enrolLinks(claims.orgId))));
  app.post<{ Params: { id: string } }>(
    `${P}/devices/:id/revoke`,
    admin("revoke a Guard device", async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/devices/:id/revoke", await guard.revokeDevice(claims.orgId, actor(claims), req.params.id))),
  );

  app.get(`${P}/services`, admin("read Guard's AI services", async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/services", await guard.servicesPage(claims.orgId))));
  app.post(`${P}/services`, admin("add an AI service", async (guard, claims, req, reply) => sendGuard(reply, "POST /guard/services", await guard.createService(claims.orgId, actor(claims), req.body), 201)));
  app.put<{ Params: { id: string } }>(
    `${P}/services/:id`,
    admin("change an AI service", async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/services/:id", await guard.updateService(claims.orgId, actor(claims), req.params.id, req.body))),
  );
  app.delete<{ Params: { id: string } }>(
    `${P}/services/:id`,
    admin("remove an AI service", async (guard, claims, req, reply) => sendGuard(reply, "DELETE /guard/services/:id", await guard.deleteService(claims.orgId, actor(claims), req.params.id))),
  );

  app.get(`${P}/settings`, admin("read Guard's settings", async (guard, claims, _req, reply) => sendGuard(reply, "GET /guard/settings", await guard.settingsPage(claims.orgId))));
  app.put(`${P}/settings`, admin("change Guard's settings", async (guard, claims, req, reply) => sendGuard(reply, "PUT /guard/settings", await guard.putSettings(claims.orgId, actor(claims), req.body))));
};
