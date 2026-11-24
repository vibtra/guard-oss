import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { CONSOLE_API_PREFIX } from "@vibtra/console-api";
import { access } from "../../auth/access.js";
import { requireSession } from "../../auth/session.js";
import { RequestDeskError, type GuardRequestDesk } from "./service.js";
import { POLICY_REQUEST_ROW_KINDS, POLICY_REQUEST_STATUSES } from "./store.js";

const ApproveBody = z
  .object({
    grant: z
      .object({ days: z.number().int().min(1).max(90).optional(), hours: z.number().int().min(1).max(23).optional(), scope: z.enum(["user", "org"]).optional() })
      .strict()
      .refine((g) => g.days === undefined || g.hours === undefined, { message: "a grant lasts days or hours, not both" })
      .optional(),
    note: z.string().max(280).optional(),
    binding: z.object({ env: z.string().max(64).optional(), host: z.string().max(253).optional(), access: z.enum(["read", "write"]).optional() }).strict().optional(),
  })
  .strict();
const DeclineBody = z.object({ note: z.string().max(280).optional() }).strict();
const ListQuery = z.object({ status: z.enum(POLICY_REQUEST_STATUSES).optional(), kind: z.enum(POLICY_REQUEST_ROW_KINDS).optional() }).strict();

const validation = (reply: FastifyReply, error: z.ZodError) =>
  reply.code(400).send({ code: "VALIDATION", message: error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") });

export const registerGuardRequestRoutes = (app: FastifyInstance, desk: GuardRequestDesk): void => {
  const P = CONSOLE_API_PREFIX;
  const guarded =
    (fn: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await fn(req, reply);
      } catch (error) {
        if (error instanceof RequestDeskError) return reply.code(error.status).send({ code: error.code, message: error.message });
        throw error;
      }
    };

  app.get(
    `${P}/policy-requests`,
    access.admin("read the policy request desk"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      const parsed = ListQuery.safeParse(req.query ?? {});
      if (!parsed.success) return validation(reply, parsed.error);
      return reply.send({ requests: await desk.listRequests(claims.orgId, parsed.data) });
    }),
  );
  app.get(
    `${P}/policy-requests/mine`,
    access.member,
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      return reply.send({ requests: (await desk.myRequests(claims.orgId, claims.userId)).map((r) => desk.requestView(r)) });
    }),
  );
  app.get<{ Params: { id: string } }>(
    `${P}/policy-requests/:id`,
    access.admin("read a policy request"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      return reply.send(await desk.getRequest(claims.orgId, (req.params as { id: string }).id));
    }),
  );
  app.post<{ Params: { id: string } }>(
    `${P}/policy-requests/:id/approve`,
    access.admin("approve a policy request"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      const parsed = ApproveBody.safeParse(req.body ?? {});
      if (!parsed.success) return validation(reply, parsed.error);
      const input = { ...(parsed.data.grant ? { grant: parsed.data.grant } : {}), ...(parsed.data.note ? { note: parsed.data.note } : {}) };
      return reply.send(await desk.approve(claims.orgId, { userId: claims.userId, email: claims.email }, (req.params as { id: string }).id, input));
    }),
  );
  app.post<{ Params: { id: string } }>(
    `${P}/policy-requests/:id/decline`,
    access.admin("decline a policy request"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      const parsed = DeclineBody.safeParse(req.body ?? {});
      if (!parsed.success) return validation(reply, parsed.error);
      return reply.send(await desk.decline(claims.orgId, { userId: claims.userId, email: claims.email }, (req.params as { id: string }).id, parsed.data.note ? { note: parsed.data.note } : {}));
    }),
  );
  app.get(
    `${P}/policy-grants`,
    access.admin("read the policy grants"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      return reply.send({ grants: await desk.listGrants(claims.orgId) });
    }),
  );
  app.post<{ Params: { id: string } }>(
    `${P}/policy-grants/:id/revoke`,
    access.admin("revoke a policy grant"),
    guarded(async (req, reply) => {
      const claims = requireSession(req);
      return reply.send(await desk.revokeGrant(claims.orgId, { userId: claims.userId, email: claims.email }, (req.params as { id: string }).id));
    }),
  );
};
