// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Vibtra
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { VibtraError } from "../errors.js";
import { SCIM_BASE_PATH } from "@vibtra/console-api";
import { authenticateScimToken, type ScimOrg } from "../auth/guard.js";
import { requireCapability } from "../config.js";
import {
  enterpriseAvailability,
  enterpriseUnavailable,
  type RegistryEnterprise,
  type ScimDirectoryContext,
  type ScimDirectorySync,
  type ScimOutcome,
} from "../enterprise.js";
import type { TenancyStore } from "../tenancy/store.js";
import { SCIM_CONTENT_TYPE, SCIM_ERROR_SCHEMA, SCIM_MAX_PAGE } from "./protocol.js";

export const SCIM_PREFIX = SCIM_BASE_PATH;

export { SCIM_MAX_PAGE };

const scimError = (
  reply: FastifyReply,
  status: number,
  detail: string,
  scimType?: string,
): FastifyReply =>
  reply
    .code(status)
    .type(SCIM_CONTENT_TYPE)
    .send({
      schemas: [SCIM_ERROR_SCHEMA],
      status: String(status),
      ...(scimType === undefined ? {} : { scimType }),
      detail,
    });

const scimOk = (reply: FastifyReply, body: unknown): FastifyReply =>
  reply.code(200).type(SCIM_CONTENT_TYPE).send(body);

const unauthorized = (reply: FastifyReply, error: VibtraError): FastifyReply => {
  void reply.header("www-authenticate", "Bearer");
  return scimError(reply, 401, `${error.message}. ${error.detail ?? ""}`.trim());
};

const planRefused = (reply: FastifyReply, error: VibtraError): FastifyReply =>
  scimError(reply, 403, `${error.message}. ${error.detail ?? ""}`.trim());

export interface ScimRouteContext {
  tenancy: TenancyStore;
  directorySync: ScimDirectoryContext;
  enterprise?: RegistryEnterprise;
  baseUrl: string;
}

export const registerScimRoutes = (app: FastifyInstance, ctx: ScimRouteContext): void => {
  void app.register(async (scope) => {
    scope.addContentTypeParser<string>(
      "application/scim+json",
      { parseAs: "string" },
      (_req, body, done) => {
        try {
          done(null, body === "" ? {} : (JSON.parse(body) as unknown));
        } catch {
          done(null, undefined);
        }
      },
    );
    registerScimRoutesIn(scope, ctx);
  });
};

const registerScimRoutesIn = (app: FastifyInstance, ctx: ScimRouteContext): void => {
  const authed = async (
    reply: FastifyReply,
    authorization: string | undefined,
  ): Promise<ScimOrg | undefined> => {
    let org: ScimOrg;
    try {
      org = await authenticateScimToken(ctx.tenancy, authorization);
    } catch (error) {
      void unauthorized(
        reply,
        error instanceof VibtraError
          ? error
          : new VibtraError({
              code: "DEPLOY_AUTH_EXPIRED",
              message: "This SCIM token could not be verified",
              detail: "the registry could not check the presented token; nothing was changed",
            }),
      );
      return undefined;
    }

    try {
      requireCapability(await ctx.tenancy.getOrg(org.orgId), "scim");
    } catch (error) {
      void planRefused(
        reply,
        error instanceof VibtraError
          ? error
          : new VibtraError({
              code: "REGISTRY_LIMIT_EXCEEDED",
              message: "This organisation's plan could not be checked",
              detail: "the registry could not read the organisation's bucket; nothing was changed",
            }),
      );
      return undefined;
    }
    return org;
  };

  app.get(`${SCIM_PREFIX}/ServiceProviderConfig`, async (_req, reply) =>
    scimOk(reply, {
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: SCIM_MAX_PAGE },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description:
            "A per-organisation SCIM token (vbs_…), minted once by an org owner or admin through the Vibtra " +
            "console's developer-token door with kind \"scim\", and shown exactly once. It authenticates this " +
            "endpoint and no other door on this registry — the /v1 doors refuse it by name.",
          primary: true,
        },
      ],
      meta: { resourceType: "ServiceProviderConfig", location: `${ctx.baseUrl}${SCIM_PREFIX}/ServiceProviderConfig` },
    }),
  );

  const unavailable = (reply: FastifyReply, reason: string): FastifyReply => notImplemented(reply, reason);

  const directorySync = (): { sync: ScimDirectorySync } | { reason: string } => {
    const verdict = enterpriseAvailability(ctx.enterprise, "scim");
    if (!verdict.ok) return { reason: verdict.reason };
    if (ctx.enterprise?.scim === undefined) {
      return { reason: enterpriseUnavailable("scim", "the loaded ee/ module has no directory sync") };
    }
    if (bound === undefined) {
      try {
        bound = ctx.enterprise.scim(ctx.directorySync);
      } catch {
        return { reason: enterpriseUnavailable("scim", "the ee/ directory sync could not start") };
      }
    }
    return { sync: bound };
  };
  let bound: ScimDirectorySync | undefined;

  const answer = async (
    reply: FastifyReply,
    log: FastifyRequest["log"],
    run: (sync: ScimDirectorySync) => Promise<ScimOutcome>,
  ): Promise<FastifyReply> => {
    const resolved = directorySync();
    if ("reason" in resolved) return unavailable(reply, resolved.reason);
    let outcome: ScimOutcome;
    try {
      outcome = await run(resolved.sync);
    } catch (error) {
      log.error({ err: error }, "scim: the ee/ directory sync threw; answered as unavailable");
      return unavailable(reply, enterpriseUnavailable("scim", "the ee/ directory sync failed on this request"));
    }
    if (outcome.status !== 200) return scimError(reply, outcome.status, outcome.error, outcome.scimType);
    if (outcome.log !== undefined) log.info(outcome.log, "scim: user deactivated, sessions ended");
    return scimOk(reply, outcome.body);
  };

  app.get<{ Querystring: { filter?: string; startIndex?: string; count?: string } }>(
    `${SCIM_PREFIX}/Users`,
    async (req, reply) => {
      const org = await authed(reply, req.headers.authorization);
      if (org === undefined) return reply;
      return answer(reply, req.log, (sync) => sync.listUsers(org.orgId, req.query));
    },
  );

  app.get<{ Params: { id: string } }>(`${SCIM_PREFIX}/Users/:id`, async (req, reply) => {
    const org = await authed(reply, req.headers.authorization);
    if (org === undefined) return reply;
    return answer(reply, req.log, (sync) => sync.getUser(org.orgId, req.params.id));
  });

  app.patch<{ Params: { id: string } }>(`${SCIM_PREFIX}/Users/:id`, async (req, reply) => {
    const org = await authed(reply, req.headers.authorization);
    if (org === undefined) return reply;
    return answer(reply, req.log, async (sync) => {
      const outcome = await sync.patchUser(org.orgId, req.params.id, req.body);
      return outcome.status === 200 && outcome.log !== undefined
        ? { ...outcome, log: { ...outcome.log, orgId: org.orgId, tokenId: org.tokenId } }
        : outcome;
    });
  });

  const notImplemented = (reply: FastifyReply, detail: string): FastifyReply =>
    scimError(reply, 501, detail);

  const GROUPS_ARE_OURS =
    "This registry implements SCIM /Users only. Groups here are this workspace's own — an admin makes them on " +
    "the console's Groups page, and the policies and audiences that read them are enforced from there — so " +
    "/Groups and group push are not synced from an identity provider. Turn group push off for this application.";

  for (const path of [`${SCIM_PREFIX}/Groups`, `${SCIM_PREFIX}/Groups/:id`]) {
    app.route({
      method: ["GET", "POST", "PUT", "PATCH", "DELETE"],
      url: path,
      handler: async (_req, reply) => notImplemented(reply, GROUPS_ARE_OURS),
    });
  }

  app.post(`${SCIM_PREFIX}/Users`, async (_req, reply) =>
    notImplemented(
      reply,
      "This registry does not create people from a directory. Somebody joins this organisation by signing in " +
        "on a verified address at its claimed domain (the claims-or-joins rule), and an admin invites them from " +
        "the console's People page. Deprovisioning IS synced: PATCH active:false ends every session they hold.",
    ),
  );

  app.delete<{ Params: { id: string } }>(`${SCIM_PREFIX}/Users/:id`, async (_req, reply) =>
    notImplemented(
      reply,
      "This registry does not remove people from a directory. PATCH active:false ends every session the person " +
        "holds, which is what deprovisioning needs; removing them from the organisation is an owner's or " +
        "admin's act on the console's People page, because it also decides what happens to what they own.",
    ),
  );
};
