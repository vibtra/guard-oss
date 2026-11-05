import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { GUARD_API_PREFIX } from "@vibtra/guard-contract";
import { RequestDeskError } from "./requests/service.js";
import { GuardError, type GuardService } from "./service.js";

export const sendGuardError = (reply: FastifyReply, error: unknown): FastifyReply => {
  if (error instanceof GuardError) return reply.code(error.status).send(error.toJSON());
  if (error instanceof RequestDeskError) return reply.code(error.status).send({ code: error.code, message: error.message });
  throw error;
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
        const d = await guard.authenticate(req.params.deviceId, req.headers.authorization);
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

  app.post<DeviceParams>(`${GUARD_API_PREFIX}/preflight/:deviceId`, device(async (guard, d, req, reply) => reply.send(await guard.preflight(d, req.body))));

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/ruledownload/:deviceId`,
    device(async (guard, d, req, reply) => {
      const { digest: _digest, ...answer } = await guard.ruledownload(d, req.body);
      return reply.send(answer);
    }),
  );

  app.post<DeviceParams>(`${GUARD_API_PREFIX}/eventupload/:deviceId`, device(async (guard, d, req, reply) => reply.send(await guard.eventupload(d, req.body))));

  app.post<DeviceParams>(`${GUARD_API_PREFIX}/postflight/:deviceId`, device(async (guard, d, req, reply) => reply.send(await guard.postflight(d, req.body))));

  app.post<DeviceParams>(
    `${GUARD_API_PREFIX}/requests/:deviceId`,
    device(async (guard, d, req, reply) => {
      const answer = await guard.ask(d, req.body);
      return reply.code(answer.created ? 201 : 200).send(answer);
    }),
  );

  app.get<DeviceParams>(`${GUARD_API_PREFIX}/requests/:deviceId`, device(async (guard, d, _req, reply) => reply.send(await guard.asks(d))));
};
