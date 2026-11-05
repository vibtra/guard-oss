import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { VibtraError } from "../errors.js";
import { CONSOLE_API_PREFIX, type ConsoleSession } from "@vibtra/console-api";
import type { RegistryAuth } from "../auth/better-auth.js";
import { wireRole, type RegistrySession } from "../auth/session.js";
import { connectionLimitFor, planFor, registrationOf, userLimitFor, type HostedConfig } from "../config.js";
import { billingStatusOf } from "../tenancy/billing-status.js";
import { fallbackHandleOf } from "../tenancy/handle.js";
import type { RegistryService } from "../service.js";
import { joinPolicyOf, type OrgRow, type TenancyStore } from "../tenancy/store.js";
import type { GroupStore } from "../groups/store.js";
import type { Mailer } from "../mail/mailer.js";
import type { VaultStore } from "../vault/store.js";
import type { HostedBilling } from "../hosted-billing.js";
import { registerConsoleGroupRoutes } from "./groups.js";
import { registerConsoleAccountRoutes } from "./account.js";
import { registerConsoleOrgSettingsRoutes } from "./org-settings.js";
import { consolePeoplePage, registerConsolePeopleRoutes } from "./people.js";
import { registerConsoleSsoRoutes } from "./sso.js";
import { registerConsoleRegistrationRoutes } from "./registration.js";
import { sendConsole } from "./respond.js";
import {
  ensureCsrfCookie,
  requireConsoleSession,
  requireCsrf,
  requirePathOrg,
  type ConsoleGuardContext,
} from "./guard.js";

export interface ConsoleApiContext extends ConsoleGuardContext {
  issuer: string;
  defaultConnectionLimit?: number;
  mailer?: Mailer;
  startCheckout?: (args: { orgId: string; planId: string; handle?: string | undefined }) => Promise<{ url: string } | undefined>;
  selfServePlanIds?: readonly string[];
  billing?: HostedBilling;
  now?: () => Date;
  auth?: RegistryAuth;
  groups?: GroupStore;
  registration?: HostedConfig["registration"];
}

const CLOSED_ORG_REFUSAL = (org: OrgRow): { message: string; detail: string } => ({
  message: "This organisation is closed",
  detail:
    `${org.name} was closed on ${(org.closedAt ?? "").slice(0, 10)}` +
    `${org.closedBy === undefined ? "" : ` by ${org.closedBy}`}. ` +
    "Its door tokens are revoked and its stored credentials are destroyed. Records and receipts stay readable " +
    `until ${(org.purgeAfter ?? "").slice(0, 10)}, after which an operator deletes them.`,
});

export const registerConsoleApiRoutes = (app: FastifyInstance, service: RegistryService, ctx: ConsoleApiContext): void => {
  const tenancy = service.tenancy;
  if (tenancy === undefined) return;
  const orgs: TenancyStore = tenancy;
  const vault: VaultStore | undefined = service.vault;
  const operatorDomain = registrationOf({ registration: ctx.registration }).operatorDomain;
  const peoplePage = consolePeoplePage(service, ctx);

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(req.url.split("?")[0] ?? "");
    } catch {
      return reply.code(400).send({ code: "BAD_PATH", message: "The request path has a malformed percent-encoding" });
    }
    const matched = req.routeOptions.url ?? "";
    const isConsole = (p: string): boolean => p === CONSOLE_API_PREFIX || p.startsWith(`${CONSOLE_API_PREFIX}/`);
    if (!isConsole(decodedPath) && !isConsole(matched)) return;
    const claims = requireConsoleSession(ctx, req);
    requireCsrf(ctx, req);
    ensureCsrfCookie(ctx, req, reply);
    const closable = await orgs.getOrg(claims.orgId);
    if (closable?.closedAt !== undefined) {
      const { message, detail } = CLOSED_ORG_REFUSAL(closable);
      throw new VibtraError({ code: "POLICY_REFUSED", message, detail });
    }

    await requirePathOrg(req, closable, (orgId) => orgs.listOrgHandleAliases(orgId));
  });

  const sessionOf = (req: FastifyRequest): RegistrySession => requireConsoleSession(ctx, req);

  const usageFor = async (orgId: string) => {
    const org = await orgs.getOrg(orgId);
    return {
      plan: planFor(org?.plan).id,
      planName: planFor(org?.plan).name,
      users: await orgs.countUsers(orgId),
      userLimit: userLimitFor(org),
      ...(vault === undefined
        ? {}
        : {
            connections: await vault.countConnections(orgId),
            connectionLimit: connectionLimitFor(org, ctx.defaultConnectionLimit),
          }),
      billingStatus: billingStatusOf(org),
      ...(org?.billingStatusAt === undefined ? {} : { billingStatusAt: org.billingStatusAt }),
    };
  };

  const sessionView = async (claims: RegistrySession): Promise<ConsoleSession> => {
    const org = await orgs.getOrg(claims.orgId);
    return {
      email: claims.email,
      issuer: ctx.issuer,
      orgId: claims.orgId,
      orgName: org?.name ?? claims.orgId,
      handle: org?.handle ?? fallbackHandleOf(claims.orgId),
      ...(org?.domain === undefined ? {} : { orgDomain: org.domain }),
      role: wireRole(claims.role),
      orgRole: claims.role,
      joinPolicy: joinPolicyOf(org?.joinPolicy),
      ...(operatorDomain !== undefined && org?.domain === operatorDomain ? { operator: true } : {}),
      features: { builder: false },
      usage: await usageFor(claims.orgId),
    };
  };

  app.get(`${CONSOLE_API_PREFIX}/session`, async (req, reply) => {
    return sendConsole(reply, "GET /session", await sessionView(sessionOf(req)));
  });

  registerConsolePeopleRoutes(app, service, ctx);
  registerConsoleSsoRoutes(app, service, ctx);
  registerConsoleRegistrationRoutes(app, service, ctx);
  registerConsoleAccountRoutes(app, service, ctx, sessionOf);
  ctx.billing?.registerConsoleRoutes(app, service, ctx, sessionOf);
  registerConsoleOrgSettingsRoutes(app, service, ctx, sessionOf, sessionView);

  app.get(`${CONSOLE_API_PREFIX}/people`, async (req, reply) => {
    const claims = sessionOf(req);
    return sendConsole(reply, "GET /people", await peoplePage(claims));
  });

  registerConsoleGroupRoutes(app, service, ctx, sessionOf);
};
