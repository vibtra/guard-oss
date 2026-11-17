import fastifyCompress from "@fastify/compress";
import { VibtraError, type VibtraErrorCode } from "./errors.js";
import Fastify,{ type FastifyInstance,LogController,type FastifyRequest,type FastifyServerOptions } from "fastify";
import { createRegistryAuth,devTrustedOrigins,type RegistryAuth } from "./auth/better-auth.js";
import { AUTH_BASE_PATH,registerAuthHandler } from "./auth/fastify.js";
import { waitForOidcDiscovery } from "./auth/oidc-discovery.js";
import { peekSession, registerSessionReader } from "./auth/session.js";
import { GUARD_LATE_AFTER_MINUTES_DEFAULT,GUARD_STAFF_NOTICE_TEMPLATE,quickStartGuardOrg,renderStaffNotice } from "@vibtra/guard-contract";
import { gateSigningSecretFor,type KeyBackend,RegistryConfig } from "./config.js";
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
import { createMailer,type MailAdapter,type Mailer,type MailFetch } from "./mail/mailer.js";
import { BUILT_IN_MAIL_ADAPTERS } from "./mail/built-in.js";
import { RESEND_API_KEY_VARIABLE } from "./mail/resend.js";
import { mailSelectionOf } from "./mail/selection.js";
import { registerOnboardingEntryRoutes } from "./onboarding/entry-routes.js";
import { ownInvitations } from "./onboarding/own-invitations.js";
import { hasSsoIdentity, invitationLinkGeneration, liveInvitation, onboardingMemberById } from "./onboarding/invitation-rows.js";
import { createInProcessCoordinator } from "./store/coordination.js";
import { createInvitationDeliverer } from "./onboarding/invitations.js";
import { createOnboardingLinks } from "./onboarding/links.js";
import { createOnboardingService } from "./onboarding/service.js";
import { type HostedBillingEndpoint,type HostedBillingFetch,type HostedBillingModule,loadHostedBilling } from "./hosted-billing.js";
import { defaultGuardConsoleDistDir,type GuardService,registerGuard,registerGuardConsoleApp } from "./guard/index.js";
import { mailRequestArrival } from "./guard/requests/mail.js";
import { registerGuardRequestRoutes } from "./guard/requests/routes.js";
import { createGuardRequestDesk, type GuardRequestDesk } from "./guard/requests/service.js";
import type { PolicyRequestRow } from "./guard/requests/store.js";
import { createLocalSigner } from "./guard/local-signer.js";
import type { GuardAuditEntry } from "./guard/service.js";
import { type GuardSigningKeyStore,signingKeyRefs } from "./guard/store.js";
import type { GuardSigner } from "@vibtra/guard-contract/signing";
import { createVaultSealer,type VaultSealer } from "./vault/seal.js";
import { createCiphertextTripwire,installCiphertextTripwire } from "./vault/tripwire.js";
import { usageNoticeMail } from "./mail/templates.js";
import { type Clock,createTestClock,systemClock,testClockEnabled } from "./metering/clock.js";
import { createMeteringService,DEFAULT_FREE_BUDGET_HOURS,type MeteringService } from "./metering/service.js";
import { actorOf,errorFields,noteSentBytes,REQUEST_ID_HEADER,registryLogLevel,requestIdFor,sentBytesOf } from "./telemetry.js";

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
      ? { level: registryLogLevel(), serializers: registryLogSerializers }
      : { level: logger.level ?? registryLogLevel(), serializers: registryLogSerializers, stream: logger.stream };

const QUIET_ROUTES = new Set(["/healthz"]);

const installRequestTelemetry = (app: FastifyInstance): void => {
  app.addHook("onRequest", async (req, reply) => {
    void reply.header(REQUEST_ID_HEADER, req.id);
  });
  app.addHook("preSerialization", async (req, reply, payload: unknown) => {
    if (reply.statusCode < 400 || payload === null || typeof payload !== "object" || Array.isArray(payload)) return payload;
    const body = payload as Record<string, unknown>;
    if (typeof body.code !== "string" || typeof body.message !== "string" || body.traceId !== undefined) return payload;
    return { ...body, traceId: req.id };
  });
  app.addHook("onSend", async (req, _reply, payload) => {
    noteSentBytes(req, payload);
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    const route = req.routeOptions.url ?? "(unmatched)";
    const session = peekSession(req);
    const actor = actorOf(req);
    const orgId = actor.orgId ?? session?.orgId;
    const bytes = sentBytesOf(req, reply.getHeader("content-length"));
    const line = {
      method: req.method,
      route,
      status: reply.statusCode,
      duration_ms: Math.round(reply.elapsedTime * 1000) / 1000,
      ...(bytes === undefined ? {} : { bytes }),
      ...(orgId === undefined ? {} : { org_id: orgId }),
      ...(actor.deviceId === undefined ? {} : { device_id: actor.deviceId }),
    };
    if (QUIET_ROUTES.has(route) && reply.statusCode < 400) req.log.debug(line, "request");
    else req.log.info(line, "request");
  });
};

export interface RegistryServerOptions {
  port?: number;
  enterprise?: RegistryEnterprise;
  dataDir?: string;
  logger?: boolean | { stream: { write: (line: string) => void }; level?: string };
  config?: RegistryConfig;
  mailFetch?: MailFetch;
  mailAdapters?: readonly MailAdapter[];
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
  vaultSealer?: VaultSealer;
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

const refuseKeyBackend = (why: string): VibtraError =>
  new VibtraError({
    code: "VALIDATION",
    message: "VIBTRA_KEY_BACKEND=enterprise, but the enterprise key backend is not available",
    detail:
      `${why}. This registry refuses to start rather than fall back to local keys. Load a licensed ee/ module ` +
      "that provides the key backend, or set VIBTRA_KEY_BACKEND=local.",
  });

interface KeyMaterial {
  signingKeys: GuardSigningKeyStore;
  localSealer: VaultSealer | undefined;
  now: () => Date;
  audit: (entry: GuardAuditEntry) => Promise<void>;
}

type KeyBackends = (keys: KeyMaterial) => { vaultSealer: VaultSealer | undefined; guardSigner: GuardSigner | undefined };

const keyBackendsFor = (backend: KeyBackend, enterprise: RegistryEnterprise | undefined): KeyBackends => {
  if (backend === "local") {
    return ({ signingKeys, localSealer, now }) => ({
      vaultSealer: localSealer,
      guardSigner: localSealer === undefined ? undefined : createLocalSigner({ store: signingKeys, sealer: localSealer, now }),
    });
  }
  if (enterprise === undefined) throw refuseKeyBackend("the ee/ module is not loaded");
  if (!enterprise.status.licensed) throw refuseKeyBackend(`the ee/ module is not licensed: ${enterprise.status.reason ?? "no reason given"}`);
  const { guardSigner, vaultSealer } = enterprise;
  if (guardSigner === undefined || vaultSealer === undefined) throw refuseKeyBackend("the ee/ module provides no guardSigner or no vaultSealer factory");
  return ({ signingKeys, localSealer, now, audit }) => {
    const sealer = vaultSealer({ localSealer, now, audit });
    const local = createLocalSigner({ store: signingKeys, sealer, now });
    return { vaultSealer: sealer, guardSigner: guardSigner({ local, signingKeys: signingKeyRefs(signingKeys), now, audit }) };
  };
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
  const keyBackends = keyBackendsFor(hostedConfig.keyBackend ?? "local", options.enterprise);

  let registryAuth: RegistryAuth | undefined;
  let requestDesk: GuardRequestDesk | undefined;
  let guardOut: GuardService | undefined;
  let meteringOut: MeteringService | undefined;
  const meteringRef: { current?: MeteringService } = {};
  const registryClock: Clock = options.clock ?? (testClockEnabled({ VIBTRA_TEST_CLOCK: process.env.VIBTRA_TEST_CLOCK, NODE_ENV: process.env.NODE_ENV }) ? createTestClock() : systemClock());
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
    now: () => registryClock.now().getTime(),
  });

  const app = Fastify({
    logger: registryLoggerOptions(options.logger),
    genReqId: requestIdFor,
    logController: new LogController({ requestIdLogLabel: "request_id", disableRequestLogging: true }),
  });
  installRequestTelemetry(app);
  installGuardBoundary(app, { testAuth: hostedConfig.testAuth === true });

  await app.register(fastifyCompress, { global: true, threshold: 1024 });

  app.setNotFoundHandler((req, reply) => {
    const pathname = req.url.split("?")[0] ?? "";
    req.log.debug({ path: pathname }, "no route");
    void reply.code(404).send({ message: `Route ${req.method}:${pathname} not found`, error: "Not Found", statusCode: 404, traceId: req.id });
  });

  app.setErrorHandler((err, req, reply) => {
    const tooLarge = bodyTooLarge(err);
    if (tooLarge !== undefined) {
      req.log.warn({ code: tooLarge.code, reason: "body-too-large" }, "request refused");
      void reply.status(413).send({ ...tooLarge.toJSON(), traceId: req.id });
      return;
    }
    if (!(err instanceof VibtraError)) {
      req.log.error({ err: errorFields(err, "stack") }, "unhandled error");
      void reply.status(500).send({ code: "INTERNAL", message: "Something went wrong", traceId: req.id });
      return;
    }
    const status = statusFor(err.code);
    const cause = err.cause === undefined ? {} : { cause: errorFields(err.cause, status >= 500 ? "stack" : "type") };
    if (status >= 500) req.log.error({ code: err.code, ...cause, err: errorFields(err, "stack") }, "request failed");
    else req.log.warn({ code: err.code, ...cause }, "request refused");
    void reply.status(status).send({ ...err.toJSON(), traceId: req.id });
  });

  app.get("/healthz", async (_req, reply) => reply.send({ ok: true, mode }));

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

  const guardStore = service.guard;
  if (guardStore === undefined) {
    throw new VibtraError({
      code: "INTERNAL",
      message: "Hosted mode built no Guard store",
      detail: "createRegistryService({ tenancy: true }) returned no guard store — this is a wiring bug in server.ts",
    });
  }
  const guardVault = service.vault;
  const guardAudit = async (entry: GuardAuditEntry): Promise<void> => {
    if (guardVault === undefined) return;
    await appendVaultAudit(guardVault, { orgId: entry.orgId, event: "policy.changed", actor: entry.actor, actorKind: entry.actorKind, outcome: "allowed", detail: `${entry.event}: ${entry.detail}` }, registryClock.now().toISOString());
  };
  const { vaultSealer, guardSigner } = keyBackends({
    signingKeys: guardStore,
    localSealer: hostedConfig.vaultKey === undefined ? undefined : createVaultSealer(hostedConfig.vaultKey, hostedConfig.vaultKeyPrevious ?? []),
    now: () => registryClock.now(),
    audit: guardAudit,
  });
  const tripwire = createCiphertextTripwire(vaultSealer);
  if (hostedConfig.oidc.provider === "oidc") {
    await waitForOidcDiscovery(hostedConfig.oidc.issuer, { log: (line) => app.log.warn({ issuer: hostedConfig.oidc.issuer }, line) });
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
    log: app.log,
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
    selection: mailSelectionOf(hostedConfig),
    builtIn: BUILT_IN_MAIL_ADAPTERS,
    adapters: [...(options.mailAdapters ?? []), ...(options.enterprise?.mailAdapters ?? [])],
    env: { ...hostedConfig.mailEnv, ...(hostedConfig.resendApiKey === undefined ? {} : { [RESEND_API_KEY_VARIABLE]: hostedConfig.resendApiKey }) },
    fetch: options.mailFetch ?? ((url, init) => fetch(url, init)),
    log: app.log,
  });
  app.log.info({ mail_adapter: mailer.enabled ? mailer.adapter : "none" }, "mail");
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
        if (!mailer.enabled || service.tenancy === undefined) return;
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
  installCiphertextTripwire(app, tripwire);
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
    ...(billing === undefined ? {} : { ...billing.console, billing }),
    ...(meteringOut === undefined ? {} : { metering: meteringOut }),
    ...(hostedConfig.registration === undefined ? {} : { registration: hostedConfig.registration }),
  };
  guardOut = registerGuard(app, {
    store: guardStore,
    signer: guardSigner,
    orgs: tenancy,
    members,
    groups,
    policy: () => requestDesk,
    ...(hostedConfig.guardQuickStart === true ? { newOrg: quickStartGuardOrg() } : {}),
    serverUrl: (process.env.VIBTRA_GUARD_SERVER_URL ?? "").trim().replace(/\/+$/, "") || baseUrl,
    now: () => registryClock.now(),
    audit: guardAudit,
  });
  const onboardingLinks = createOnboardingLinks({ secret: hostedConfig.sessionSecret, baseUrl, now: () => registryClock.now() });
  const guardForOnboarding = guardOut;
  consoleCtx.invitations = createInvitationDeliverer({
    mailer,
    links: onboardingLinks,
    baseUrl,
    orgs: tenancy,
    staffNotice:
      guardForOnboarding === undefined
        ? async (orgId) => renderStaffNotice(GUARD_STAFF_NOTICE_TEMPLATE, { orgName: (await tenancy.getOrg(orgId))?.name ?? orgId })
        : (orgId) => guardForOnboarding.staffNotice(orgId),
    now: () => registryClock.now(),
  });
  const onboardingLimiter = tenancy.coordinator ?? createInProcessCoordinator(() => registryClock.now().getTime());
  consoleCtx.sendLimiter = onboardingLimiter;
  const onboardingStore = service.onboarding;
  if (onboardingStore !== undefined) {
    consoleCtx.onboarding = createOnboardingService({
      store: onboardingStore,
      orgs: tenancy,
      lateAfterMs: guardForOnboarding === undefined ? async () => GUARD_LATE_AFTER_MINUTES_DEFAULT * 60_000 : (orgId) => guardForOnboarding.lateAfterMs(orgId),
      now: () => registryClock.now(),
    });
  }
  registerOnboardingEntryRoutes(app, {
    links: onboardingLinks,
    baseUrl,
    downloadUrl: hostedConfig.guardDownloadUrl,
    limiter: onboardingLimiter,
    now: () => registryClock.now(),
    holderOf: async (subject) => {
      const adapter = await registryAuth.adapter();
      if (subject.kind === "member") {
        const member = await onboardingMemberById(adapter, subject.id);
        return member === undefined ? undefined : { orgId: member.orgId, email: member.email, linkGeneration: member.linkGeneration, pendingInvitationId: undefined };
      }
      const invitation = await liveInvitation(adapter, subject.id);
      if (invitation === undefined) return undefined;
      const member = (await members.listMembers(invitation.organizationId)).find((m) => m.email.trim().toLowerCase() === invitation.email);
      if (member?.lastRemindedAt !== undefined) return undefined;
      const joined = invitation.status === "accepted" || member !== undefined;
      return {
        orgId: invitation.organizationId,
        email: invitation.email,
        linkGeneration: invitationLinkGeneration(invitation),
        pendingInvitationId: joined ? undefined : invitation.id,
      };
    },
    verifiedIdentity: async (session, orgId) => session.emailVerified || hasSsoIdentity(await registryAuth.adapter(), session.userId, orgId),
    account: (headers) => registryAuth.resolveAccount(headers),
    orgName: async (orgId) => (await tenancy.getOrg(orgId))?.name,
    invitationsFor: async (email) =>
      ownInvitations({ adapter: await registryAuth.adapter(), org: (orgId) => tenancy.getOrg(orgId), now: () => new Date() }, email),
    enrol:
      guardForOnboarding === undefined
        ? undefined
        : {
            mint: ({ orgId, personEmail, actorEmail, via }) =>
              guardForOnboarding.mintEnrolLink(orgId, { email: actorEmail, kind: "member" }, { personEmail, note: via === "email" ? "from an onboarding email" : "from the enrol page" }),
          },
  });
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
    ...(vaultSealer !== undefined ? { vaultSealer } : {}),
    ...(guardOut !== undefined ? { guard: guardOut } : {}),
    ...(meteringOut !== undefined ? { metering: meteringOut } : {}),
    clock: registryClock,
  };
};
