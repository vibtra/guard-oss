import fastifyCompress from "@fastify/compress";
import { VibtraError, type VibtraErrorCode } from "./errors.js";
import Fastify,{ type FastifyInstance,type FastifyRequest,type FastifyServerOptions } from "fastify";
import { createRegistryAuth,devTrustedOrigins,type RegistryAuth } from "./auth/better-auth.js";
import { AUTH_BASE_PATH,registerAuthHandler } from "./auth/fastify.js";
import { waitForOidcDiscovery } from "./auth/oidc-discovery.js";
import { registerSessionReader } from "./auth/session.js";
import { quickStartGuardOrg } from "@vibtra/guard-contract";
import { gateSigningSecretFor,RegistryConfig } from "./config.js";
import { installGuardBoundary,registerGuardEntryPages } from "./guard/product-boundary.js";
import { appendVaultAudit } from "./vault/operations.js";
import { registerConsoleApiRoutes } from "./console-api/routes.js";
import { defaultLandingDistDir,hasBuiltLanding,readBuiltLanding,readBuiltLegalDocuments,registerLandingAssets } from "./landing.js";
import type { RegistryEnterprise } from "./enterprise.js";
import { isBlockedIssuerPath } from "./issuer/provider.js";
import { registerRegistryRoutes } from "./routes.js";
import { registerScimRoutes } from "./scim/routes.js";
import { createRegistryService,type RegistryService } from "./service.js";
import { createMemberDirectory } from "./tenancy/members.js";
import { createGroupStore } from "./groups/store.js";
import { createMailer,type Mailer,type MailFetch } from "./mail/mailer.js";
import { type HostedBillingEndpoint,type HostedBillingFetch,type HostedBillingModule,loadHostedBilling } from "./hosted-billing.js";
import { defaultGuardConsoleDistDir,type GuardService,registerGuard,registerGuardConsoleApp } from "./guard/index.js";
import { mailRequestArrival } from "./guard/requests/mail.js";
import { registerGuardRequestRoutes } from "./guard/requests/routes.js";
import { createGuardRequestDesk, type GuardRequestDesk } from "./guard/requests/service.js";
import type { PolicyRequestRow } from "./guard/requests/store.js";
import { createOpenBaoClientFor } from "./vault/openbao-client.js";
import { createOrgVaultSealer } from "./vault/sealer-ring.js";
import { probeOpenBao } from "./vault/transit-sealer.js";
import { installCiphertextTripwire } from "./vault/tripwire.js";
import { usageNoticeMail } from "./mail/templates.js";
import { type Clock,createTestClock,systemClock,testClockEnabled } from "./metering/clock.js";
import { createMeteringService,DEFAULT_FREE_BUDGET_HOURS,type MeteringService } from "./metering/service.js";

export const DEFAULT_REGISTRY_PORT = 4700;

const LEGACY_BUNDLE_LIMIT_BYTES = 50 * 1024 * 1024;

const RAW_BODY_LIMIT_BYTES = 1024 * 1024;

export const registryLogSerializers = {
  req: (request: {
    method?: string;
    url?: string;
    headers?: Record<string, string | string[] | undefined>;
    host?: string;
    ip?: string;
    socket?: { remotePort?: number };
  }) => ({
    method: request.method,
    url: (request.url ?? "").split("?")[0],
    version: ((v) => (Array.isArray(v) ? v[0] : v))(request.headers?.["accept-version"]),
    host: request.host,
    remoteAddress: request.ip,
    remotePort: request.socket?.remotePort,
  }),
};

export const registryLoggerOptions = (
  logger: RegistryServerOptions["logger"],
): FastifyServerOptions["logger"] =>
  logger === undefined || logger === false
    ? false
    : logger === true
      ? { serializers: registryLogSerializers }
      : { serializers: registryLogSerializers, stream: logger.stream };

export interface RegistryServerOptions {
  port?: number;
  enterprise?: RegistryEnterprise;
  dataDir?: string;
  logger?: boolean | { stream: { write: (line: string) => void } };
  config?: RegistryConfig;
  mailFetch?: MailFetch;
  stripeFetch?: HostedBillingFetch;
  stripeEndpoint?: HostedBillingEndpoint;
  billing?: HostedBillingModule | false;
  clock?: Clock;
  freeBudgetHours?: number;
  guardConsoleDistDir?: string;
  landingDistDir?: string;
}

export interface RegistryServer {
  app: FastifyInstance;
  service: RegistryService;
  auth?: RegistryAuth;
  guard?: GuardService;
  metering?: MeteringService;
  clock?: Clock;
}

const bodyTooLarge = (err: unknown): VibtraError | undefined => {
  if (err instanceof VibtraError) return undefined;
  const e = err as { code?: unknown; statusCode?: unknown };
  if (e.code !== "FST_ERR_CTP_BODY_TOO_LARGE" && e.statusCode !== 413) return undefined;
  return new VibtraError({
    code: "VALIDATION",
    message: "That request body is too large for this door",
    detail:
      "the body was refused at the parser, before the handler ran — nothing was read, nothing was built and " +
      `nothing was sent. POST /v1/deploys accepts a bundle up to ${LEGACY_BUNDLE_LIMIT_BYTES} bytes; every other door on ` +
      "this registry accepts 1 MiB.",
  });
};

const statusFor = (code: VibtraErrorCode): number => {
  if (code === "VALIDATION") return 400;
  if (code === "DEPLOY_AUTH_EXPIRED") return 401;
  if (code === "REGISTRY_LIMIT_EXCEEDED") return 403;
  if (code === "POLICY_REFUSED") return 403;
  if (code === "UPSTREAM_REFUSED") return 502;
  if (code === "CHECK_FAILED") return 422;
  return 500;
};

const rawBody = (_req: FastifyRequest, body: Buffer, done: (err: Error | null, body?: unknown) => void): void => {
  done(null, body);
};

export const createRegistryServer = async (options: RegistryServerOptions = {}): Promise<RegistryServer> => {
  const config = options.config !== undefined ? RegistryConfig.parse(options.config) : undefined;
  const mode = config?.mode ?? "single";
  const hostedConfig = config?.hosted;
  if (mode !== "hosted" || hostedConfig === undefined) {
    throw new VibtraError({
      code: "VALIDATION",
      message: "Guard requires hosted mode",
      detail: "createRegistryServer needs config.mode 'hosted' and config.hosted — loadRegistryConfig() builds both from REGISTRY_MODE=hosted",
    });
  }
  const dataDir = options.dataDir ?? config?.dataDir ?? new URL("../data", import.meta.url).pathname;

  let registryAuth: RegistryAuth | undefined;
  let requestDesk: GuardRequestDesk | undefined;
  let guardOut: GuardService | undefined;
  let meteringOut: MeteringService | undefined;
  const meteringRef: { current?: MeteringService } = {};
  const registryClock: Clock = options.clock ?? (testClockEnabled(process.env) ? createTestClock() : systemClock());
  const members = createMemberDirectory(async () => {
    if (registryAuth === undefined) {
      throw new VibtraError({
        code: "INTERNAL",
        message: "The registry's member directory was used before sign-in was configured",
        detail: "createMemberDirectory resolved its adapter before createRegistryAuth ran — this is a wiring bug in server.ts",
      });
    }
    return registryAuth.adapter();
  });

  const service = await createRegistryService({
    dataDir,
    databaseUrl: config?.databaseUrl,
    tenancy: true,
    members,
  });

  const app = Fastify({ logger: registryLoggerOptions(options.logger) });
  installGuardBoundary(app, { testAuth: hostedConfig.testAuth === true });

  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?")[0] ?? "";
    req.log.info(`Route ${req.method}:${pathname} not found`);
    void reply.code(404).send({ message: `Route ${req.method}:${pathname} not found`, error: "Not Found", statusCode: 404 });
  });

  app.setErrorHandler((err, req, reply) => {
    const tooLarge = bodyTooLarge(err);
    if (tooLarge !== undefined) {
      void reply.status(413).send(tooLarge.toJSON());
      return;
    }
    if (!(err instanceof VibtraError)) {
      req.log.error({ err }, "unhandled error");
      void reply.status(500).send({ code: "INTERNAL", message: "Something went wrong" });
      return;
    }
    void reply.status(statusFor(err.code)).send(err.toJSON());
  });

  let openbaoProbe: { at: number; word: "reachable" | "unreachable" } | undefined;
  const openbaoHealth = async (): Promise<"reachable" | "unreachable" | "not-configured"> => {
    const addr = hostedConfig.openbaoAddr;
    if (addr === undefined) return "not-configured";
    const cached = openbaoProbe;
    if (cached !== undefined && Date.now() - cached.at < 2_000) return cached.word;
    const word = await probeOpenBao(addr);
    openbaoProbe = { at: Date.now(), word };
    return word;
  };
  app.get("/healthz", async (_req, reply) => reply.send({ ok: true, mode, openbao: await openbaoHealth() }));

  const landingDistDir =
    options.landingDistDir ?? process.env.VIBTRA_LANDING_DIST ?? defaultLandingDistDir();
  const legalDocuments = readBuiltLegalDocuments(landingDistDir);

  const baseUrl = hostedConfig.baseUrl.replace(/\/+$/, "");
  const tenancy = service.tenancy;
  if (tenancy === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "Hosted mode built no tenancy store",
      detail: "createRegistryService({ tenancy: true }) returned no tenancy — this is a wiring bug in server.ts",
    });
  }

  const extraTrustedOrigins = [
    ...new Set([...devTrustedOrigins(baseUrl), ...(hostedConfig.extraTrustedOrigins ?? [])]),
  ];

  const billingModule = options.billing === false ? undefined : (options.billing ?? (await loadHostedBilling()));
  const billing = billingModule?.create({
    config: hostedConfig,
    baseUrl,
    tenancy,
    vault: service.vault,
    meteringStore: service.workspaces === undefined ? undefined : service.metering,
    metering: () => meteringRef.current,
    clock: registryClock,
    log: (line) => app.log.info(line),
    stripeFetch: options.stripeFetch,
    stripeEndpoint: options.stripeEndpoint,
  });

  const openbaoClient = createOpenBaoClientFor(hostedConfig);
  const vaultSealer = createOrgVaultSealer(hostedConfig, openbaoClient);
  if (hostedConfig.oidc.provider === "oidc") {
    await waitForOidcDiscovery(hostedConfig.oidc.issuer, { log: (line) => console.error(`[vibtra-registry] ${line}`) });
  }
  registryAuth = createRegistryAuth({
    baseUrl,
    secret: hostedConfig.sessionSecret,
    gateSigningSecret: gateSigningSecretFor(hostedConfig),
    ...(vaultSealer === undefined ? {} : { sealer: vaultSealer }),
    ...(service.pool !== undefined ? { pool: service.pool } : {}),
    google: { clientId: hostedConfig.oidc.clientId, clientSecret: hostedConfig.oidc.clientSecret },
    ...(hostedConfig.oidc.provider === "oidc" ? { oidc: { issuer: hostedConfig.oidc.issuer } } : {}),
    orgs: tenancy,
    members,
    waitlist: async (org) =>
      org.domain !== undefined && org.domain === hostedConfig.registration?.operatorDomain ? false : ((await meteringRef.current?.shouldWaitlist()) ?? false),
    secureCookies: baseUrl.startsWith("https://"),
    ...(hostedConfig.testAuth === true ? { testAuth: true } : {}),
    extraTrustedOrigins,
    ...(billing?.overflowSeats === true ? { overflowSeats: true } : {}),
    ...(hostedConfig.noPeopleLimit === true ? { noPeopleLimit: true } : {}),
    ...(hostedConfig.singleOrg === true ? { singleOrg: { orgExists: async () => (await tenancy.listOrgs()).length > 0 } } : {}),
    ...(hostedConfig.ownerEmail === undefined ? {} : { ownerEmail: hostedConfig.ownerEmail }),
    ...(hostedConfig.registration?.mode === "allowlist" && service.registrationAllowlist !== undefined
      ? {
          registration: {
            mode: "allowlist" as const,
            ...(hostedConfig.registration.operatorDomain === undefined
              ? {}
              : { operatorDomain: hostedConfig.registration.operatorDomain }),
            ...(hostedConfig.registration.contactEmail === undefined
              ? {}
              : { contactEmail: hostedConfig.registration.contactEmail }),
            isAllowed: (email: string) => service.registrationAllowlist!.isAllowed(email),
          },
        }
      : {}),
  });
  registerAuthHandler(app, registryAuth.auth);
  registerSessionReader(app, {
    resolve: registryAuth.resolveSession,
    skipPrefixes: [AUTH_BASE_PATH],
  });

  const policyMailRef: { current?: (row: PolicyRequestRow, requester: { userId: string; email: string }) => Promise<void> } = {};
  if (service.guardRequests !== undefined) {
    requestDesk = createGuardRequestDesk({
      store: service.guardRequests,
      now: () => registryClock.now(),
      notify: async (row, requester) => policyMailRef.current?.(row, requester),
      ...(service.vault === undefined
        ? {}
        : {
            audit: async (entry) => {
              await appendVaultAudit(service.vault!, { orgId: entry.orgId, event: entry.event, actor: entry.actor, actorKind: "admin", outcome: entry.outcome ?? "allowed", detail: entry.detail }, registryClock.now().toISOString());
            },
          }),
    });
    registerGuardRequestRoutes(app, requestDesk);
  }

  const mailer: Mailer = createMailer({
    ...(hostedConfig.resendApiKey === undefined ? {} : { apiKey: hostedConfig.resendApiKey }),
    from: hostedConfig.mailFrom ?? "",
    ...(options.mailFetch === undefined ? {} : { fetchImpl: options.mailFetch }),
    log: (line) => app.log.info(line),
  });
  policyMailRef.current = async (row, requester) => {
    await mailRequestArrival(service.tenancy, mailer, baseUrl, row, requester);
  };

  if (service.metering !== undefined && service.workspaces !== undefined) {
    const meteringStore = service.metering;
    const freeBudgetEnv = Number((process.env.REGISTRY_FREE_BUDGET_HOURS ?? "").trim() || Number.NaN);
    meteringOut = createMeteringService({
      store: meteringStore,
      workspaces: service.workspaces,
      tenancy,
      clock: registryClock,
      freeBudgetHours: options.freeBudgetHours ?? (Number.isFinite(freeBudgetEnv) && freeBudgetEnv >= 0 ? freeBudgetEnv : DEFAULT_FREE_BUDGET_HOURS),
      mailAdmins: async (org, kind, sentence) => {
        if (mailer === undefined || !mailer.enabled || service.tenancy === undefined) return;
        for (const admin of await service.tenancy.listAdmins(org.orgId)) {
          await mailer.send(usageNoticeMail({ baseUrl, handle: org.handle, orgName: org.name, to: admin.email, kind, sentence }));
        }
      },
      ...(billing?.report === undefined ? {} : { report: billing.report }),
      log: (line) => app.log.info(line),
    });
    meteringRef.current = meteringOut;
  }

  const groups = createGroupStore({
    adapterOf: () => registryAuth!.adapter(),
    authOf: () => registryAuth!,
    members,
    ...(service.tools === undefined ? {} : { tools: service.tools }),
    ...(service.vault === undefined ? {} : { vault: service.vault }),
  });

  const landingDocument = readBuiltLanding(landingDistDir);

  registerRegistryRoutes(app, {
    landingDocument,
    legalDocuments,
  });
  installCiphertextTripwire(app);
  app.addHook("onRequest", async (req, reply) => {
    const pathname = req.url.split("?")[0] ?? "";
    if (!isBlockedIssuerPath(pathname)) return;
    await reply.code(404).header("cache-control", "no-store").send({ error: "not_found" });
  });
  app.addContentTypeParser("application/gzip", { parseAs: "buffer", bodyLimit: RAW_BODY_LIMIT_BYTES }, rawBody);
  app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: RAW_BODY_LIMIT_BYTES }, rawBody);

  registerScimRoutes(app, {
    tenancy,
    directorySync: { directory: members, authAdapter: () => registryAuth!.adapter(), baseUrl },
    ...(options.enterprise === undefined ? {} : { enterprise: options.enterprise }),
    baseUrl,
  });

  billing?.registerRoutes(app);

  const consoleCtx: Parameters<typeof registerConsoleApiRoutes>[2] & { metering?: MeteringService } = {
    baseUrl,
    secureCookies: baseUrl.startsWith("https://"),
    extraTrustedOrigins,
    issuer: hostedConfig.oidc.issuer,
    auth: registryAuth,
    groups,
    ...(hostedConfig.defaultConnectionLimit === undefined
      ? {}
      : { defaultConnectionLimit: hostedConfig.defaultConnectionLimit }),
    mailer,
    ...(billing === undefined ? {} : { ...billing.console, billing }),
    ...(meteringOut === undefined ? {} : { metering: meteringOut }),
    ...(hostedConfig.registration === undefined ? {} : { registration: hostedConfig.registration }),
  };
  {
    const guardVault = service.vault;
    guardOut = registerGuard(app, {
      store: service.guard,
      sealer: vaultSealer,
      orgs: tenancy,
      members,
      groups,
      policy: () => requestDesk,
      ...(hostedConfig.guardQuickStart === true ? { newOrg: quickStartGuardOrg() } : {}),
      serverUrl: (process.env.VIBTRA_GUARD_SERVER_URL ?? "").trim().replace(/\/+$/, "") || baseUrl,
      now: () => registryClock.now(),
      ...(guardVault === undefined
        ? {}
        : {
            audit: async (entry) => {
              await appendVaultAudit(guardVault, { orgId: entry.orgId, event: "policy.changed", actor: entry.actor, actorKind: entry.actorKind, outcome: "allowed", detail: `${entry.event}: ${entry.detail}` }, registryClock.now().toISOString());
            },
          }),
    });
  }
  registerConsoleApiRoutes(app, service, consoleCtx);

  if (await hasBuiltLanding(landingDistDir)) await registerLandingAssets(app, landingDistDir);

  await registerGuardConsoleApp(app, { distDir: options.guardConsoleDistDir ?? process.env.VIBTRA_GUARD_CONSOLE_DIST ?? defaultGuardConsoleDistDir() });
  registerGuardEntryPages(
    app,
    hostedConfig.oidc.provider === "oidc"
      ? { provider: "oidc", label: hostedConfig.oidc.name ?? "your identity provider" }
      : { provider: "google", label: "Google" },
  );

  app.addHook("onClose", async () => {
    await service.close();
  });

  return {
    app,
    service,
    auth: registryAuth,
    ...(guardOut !== undefined ? { guard: guardOut } : {}),
    ...(meteringOut !== undefined ? { metering: meteringOut } : {}),
    clock: registryClock,
  };
};
