import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GUARD_API_PREFIX } from "@vibtra/guard-contract";
import { RequestDeskError } from "./requests/service.js";
import { GuardError, type GuardService } from "./service.js";
import { noteActor, timed } from "../telemetry.js";

const COMMON_REFUSALS = new Set(["GUARD_TOKEN_INVALID", "GUARD_DEVICE_UNKNOWN", "GUARD_DEVICE_REVOKED"]);

const logRefusal = (req: FastifyRequest, status: number, code: string): void => {
  if (status >= 500) req.log.error({ code, status }, "guard request failed");
  else if (COMMON_REFUSALS.has(code)) req.log.info({ code, status }, "guard request refused");
  else req.log.warn({ code, status }, "guard request refused");
};

export const sendGuardError = (reply: FastifyReply, error: unknown): FastifyReply => {
  const traceId = reply.request.id;
  if (error instanceof GuardError) {
    logRefusal(reply.request, error.status, error.code);
    return reply.code(error.status).send({ ...error.toJSON(), traceId });
  }
  if (error instanceof RequestDeskError) {
    logRefusal(reply.request, error.status, error.code);
    return reply.code(error.status).send({ code: error.code, message: error.message, traceId });
  }
  throw error;
};

const eventSummary = (body: unknown): { actions: Record<string, number>; ruleIds: string[] } => {
  const events = (body as { events?: unknown } | null)?.events;
  const actions: Record<string, number> = {};
  const ruleIds = new Set<string>();
  if (!Array.isArray(events)) return { actions, ruleIds: [] };
  for (const event of events) {
    const { action, ruleId } = (event ?? {}) as { action?: unknown; ruleId?: unknown };
    if (typeof action === "string" && /^[a-z]{1,20}$/.test(action)) actions[action] = (actions[action] ?? 0) + 1;
    if (typeof ruleId === "string" && /^[a-z0-9_]{1,60}$/i.test(ruleId) && ruleIds.size < 20) ruleIds.add(ruleId);
  }
  return { actions, ruleIds: [...ruleIds] };
};

export const GUARD_OFF_BODY = {
  code: "GUARD_OFF",
  message: "This registry does not run Vibtra Guard",
  detail: "Guard signs its rule bundles with a sealed key; set VIBTRA_VAULT_KEY (or OpenBao) on the registry to turn it on",
} as const;

export interface GuardSyncRoutesContext {
  guard: GuardService | undefined;
}

export const registerGuardSyncRoutes = (app: FastifyInstance, ctx: GuardSyncRoutesContext): void => {
  type DeviceParams = { Params: { deviceId: string } };
  const off = (reply: FastifyReply) => reply.code(404).send(GUARD_OFF_BODY);
  const device = (
    handler: (guard: GuardService, d: Awaited<ReturnType<GuardService["authenticate"]>>, req: FastifyRequest<DeviceParams>, reply: FastifyReply) => Promise<unknown>,
  ) =>
    async (req: FastifyRequest<DeviceParams>, reply: FastifyReply) => {
      const guard = ctx.guard;
      if (guard === undefined) return off(reply);
      try {
        const d = await timed(req.log, "authenticate", () => guard.authenticate(req.params.deviceId, req.headers.authorization));
        noteActor(req, { orgId: d.orgId, deviceId: d.deviceId });
        return await handler(guard, d, req, reply);
      } catch (error) {
        return sendGuardError(reply, error);
      }
    };

  app.post(`${GUARD_API_PREFIX}/enrol`, async (req, reply) => {
    const guard = ctx.guard;
    if (guard === undefined) return off(reply);
    try {
      return reply.code(201).send(await guard.enrol(req.body));
    } catch (error) {
      return sendGuardError(reply, error);
    }
  });

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/preflight/:deviceId`,
    device(async (guard, d, req, reply) => {
      const answer = await timed(req.log, "preflight", () => guard.preflight(d, req.body));
      const pending = (req.body as { pendingEvents?: unknown } | null)?.pendingEvents;
      req.log.info(
        { bundle_version: answer.bundleVersion, rules_changed: answer.rulesChanged, clean_sync: answer.cleanSync, client_mode: answer.clientMode, ...(typeof pending === "number" ? { pending_events: pending } : {}) },
        "guard preflight",
      );
      return reply.send(answer);
    }),
  );

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/ruledownload/:deviceId`,
    device(async (guard, d, req, reply) => {
      const { digest: _digest, ...answer } = await timed(req.log, "ruledownload", () => guard.ruledownload(d, req.body));
      return reply.send(answer);
    }),
  );

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/eventupload/:deviceId`,
    device(async (guard, d, req, reply) => {
      const answer = await timed(req.log, "eventupload", () => guard.eventupload(d, req.body));
      const { actions, ruleIds } = eventSummary(req.body);
      req.log.info({ accepted: answer.accepted, rejected: answer.rejected.length, actions, rule_ids: ruleIds }, "guard eventupload");
      return reply.send(answer);
    }),
  );

  app.post<DeviceParams>(`${GUARD_API_PREFIX}/postflight/:deviceId`, device(async (guard, d, req, reply) => reply.send(await timed(req.log, "postflight", () => guard.postflight(d, req.body)))));

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/requests/:deviceId`,
    device(async (guard, d, req, reply) => {
      const answer = await guard.ask(d, req.body);
      return reply.code(answer.created ? 201 : 200).send(answer);
    }),
  );

  app.get<DeviceParams>(`${GUARD_API_PREFIX}/signing/:deviceId`, device(async (guard, d, _req, reply) => reply.send(await guard.signing(d))));

  app.get<DeviceParams>(`${GUARD_API_PREFIX}/requests/:deviceId`, device(async (guard, d, _req, reply) => reply.send(await guard.asks(d))));
};
