import { hasGuardSurfaceBlocks, GUARD_SURFACE_IDS, GUARD_SURFACE_SERVICE_IDS, GUARD_ACTIVATABLE_SURFACES, type GuardSurfaceBlocks, type GuardDeviceFacts } from "@vibtra/guard-contract";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  GUARD_CATALOGUE_SEED_VERSION,
  GUARD_DEVICE_ID,
  GUARD_ENROL_LINK_HOURS_DEFAULT,
  GUARD_EVENT_ID,
  GUARD_EVENT_UPLOAD_MAX,
  GUARD_PROTOCOL_VERSION,
  GUARD_REQUEST_KIND,
  GUARD_SNIPPET_MAX,
  GUARD_SYNC_INTERVAL_DEFAULT_S,
  GuardActivityPage,
  GuardActivityQuery,
  GuardAskBody,
  type GuardAskResponse,
  GuardAskSubject,
  type GuardAskView,
  GuardBundle,
  type GuardCatalogue,
  type GuardDetector,
  type GuardDeviceRow,
  type GuardDevicesPage,
  type GuardEnrolLink,
  GuardEnrolLinkCreate,
  type GuardEnrolLinksPage,
  GuardEnrolRequest,
  type GuardEnrolResponse,
  GuardEvent,
  type GuardEventRow,
  type GuardEventUploadResponse,
  type GuardGrantLike,
  type GuardOverviewPage,
  type GuardPerson,
  GuardPostflightRequest,
  type GuardPostflightResponse,
  GuardPreflightRequest,
  type GuardPreflightResponse,
  GuardRuleDownloadRequest,
  type GuardRuleDownloadResponse,
  GuardRulesDocument,
  type GuardRulesPage,
  GuardRuleTestInput,
  type GuardRuleTestResult,
  GuardRulesUpdate,
  type GuardService as GuardCatalogueService,
  GuardServiceCreate,
  type GuardServiceOverride,
  type GuardServiceRow,
  type GuardServicesPage,
  GuardServiceUpdate,
  GuardSettings,
  type GuardSettingsPage,
  GuardSettingsUpdate,
  applyCatalogueOverrides,
  compileGuardBundle,
  decideRequest,
  defaultGuardSettings,
  emptyGuardRules,
  renderStaffNotice,
  runDetector,
  seedCatalogue,
} from "@vibtra/guard-contract";
import { type GuardSigningKeyPair, digestOf, generateGuardSigningKey, mintDeviceToken, mintEnrolToken, mintGuardId, signGuardBundle, signGuardCatalogue, tokenHashOf } from "@vibtra/guard-contract/signing";
import type { VaultSealer } from "../vault/seal.js";
import type { GuardDeviceRecord, GuardEventRecord, GuardStore } from "./store.js";

export const GUARD_SIGNING_SEAL_ORG = "vibtra-guard-signing";
export const GUARD_BATCH_SIZE = GUARD_EVENT_UPLOAD_MAX;
const TEST_DEVICE_ID = "gdev_0000000000000000";
const DAY_MS = 24 * 60 * 60 * 1000;

const supportsSurfaceBlocks = (facts: GuardDeviceFacts, blocks: GuardSurfaceBlocks | undefined): boolean =>
  !hasGuardSurfaceBlocks(blocks) || (facts.capabilities?.surfaceBlocks === 1 && GUARD_SURFACE_IDS.every((id) => blocks?.[id] !== true || facts.supportedSurfaceBlocks?.includes(id)));

export class GuardError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "GuardError";
  }
  toJSON(): { code: string; message: string; detail?: string } {
    return { code: this.code, message: this.message, ...(this.detail === undefined ? {} : { detail: this.detail }) };
  }
}

const zodDetail = (error: z.ZodError): string =>
  error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ")
    .slice(0, 400);

const parseOr = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown, message: string): T => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) throw new GuardError(400, "VALIDATION", message, zodDetail(parsed.error));
  return parsed.data;
};

const checkProtocol = (body: unknown): void => {
  const p = (body as { protocol?: unknown } | null | undefined)?.protocol;
  if (typeof p === "number" && p !== GUARD_PROTOCOL_VERSION) {
    throw new GuardError(400, "GUARD_PROTOCOL_UNSUPPORTED", `This registry speaks Guard protocol ${GUARD_PROTOCOL_VERSION}; the agent sent ${p}`, "update the registry, or run an agent of the same protocol");
  }
};

export type GuardAuditEvent = "guard.rules.changed" | "guard.settings.changed" | "guard.device.enrolled" | "guard.device.revoked" | "guard.enrol_link.minted" | "guard.service.changed";
export interface GuardAuditEntry {
  orgId: string;
  event: GuardAuditEvent;
  actor: string;
  actorKind: "admin" | "door";
  detail: string;
}

export interface GuardPolicyDesk {
  raise(orgId: string, requester: { userId: string; email: string }, input: { kind: "guard"; subject: unknown; why?: string }): Promise<{ request: { id: string; status: string; subject: Record<string, unknown>; createdAt: string; expiresAt: string; decidedAt?: string; decisionNote?: string; grantId?: string }; created: boolean }>;
  myRequests(orgId: string, userId: string): Promise<Array<{ id: string; kind: string; status: string; subject: Record<string, unknown>; createdAt: string; expiresAt: string; decidedAt?: string; decisionNote?: string; grantId?: string }>>;
  listRequests(orgId: string, filter: { status?: "pending"; kind?: "guard" }): Promise<unknown[]>;
  listGrants(orgId: string): Promise<Array<{ id: string; kind: string; scope: "org" | "user"; userId?: string; subject: Record<string, unknown>; expiresAt?: string; revokedAt?: string; live: boolean }>>;
}

export interface GuardServiceOptions {
  store: GuardStore;
  sealer: VaultSealer;
  orgs: { getOrg(orgId: string): Promise<{ orgId: string; name: string; handle?: string; domain?: string; closedAt?: string } | undefined> };
  members: {
    listMembers(orgId: string): Promise<Array<{ userId: string; email: string; name: string | null; role: string }>>;
    listAdmins(orgId: string): Promise<Array<{ userId: string; email: string; name: string | null; role: string }>>;
  };
  groups?: { list(orgId: string): Promise<Array<{ id: string; name: string }>>; groupsOf(orgId: string, email: string): Promise<Array<{ id: string; name: string }>> } | undefined;
  policy?: () => GuardPolicyDesk | undefined;
  newOrg?: { settings: GuardSettings; rules: GuardRulesDocument } | undefined;
  serverUrl: string;
  now?: () => Date;
  audit?: (entry: GuardAuditEntry) => Promise<void>;
}

const normEmail = (e: string): string => e.trim().toLowerCase();
const maxIso = (...values: Array<string | undefined>): string => values.filter((v): v is string => v !== undefined).sort().at(-1) ?? new Date(0).toISOString();
const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

const SNIPPET_PROBES: readonly GuardDetector[] = [{ kind: "au-tfn" }, { kind: "au-abn" }, { kind: "au-acn" }, { kind: "au-medicare" }, { kind: "card-number" }, { kind: "secret" }];
export const snippetLooksRaw = (snippet: string): boolean => SNIPPET_PROBES.some((d) => runDetector(d, { text: snippet }) !== undefined);

const ruleNameOf = (doc: GuardRulesDocument, catalogue: GuardCatalogue, ruleId: string | undefined): string | undefined => {
  if (ruleId === undefined) return undefined;
  const content = doc.contentRules.find((r) => r.ruleId === ruleId);
  if (content) return content.name;
  const service = doc.serviceRules.find((r) => r.ruleId === ruleId);
  if (service) {
    const name = service.serviceId === "*" ? "Every AI service" : (catalogue.services.find((s) => s.serviceId === service.serviceId)?.name ?? service.serviceId);
    return clip(`${name} → ${service.action}`, 80);
  }
  return undefined;
};

const hostOfService = (service: GuardCatalogueService): string => service.domains.find((d) => !d.includes("*")) ?? (service.domains[0] ?? "").replace(/\*/g, "example");

const cursorOf = (row: GuardEventRecord): string => Buffer.from(JSON.stringify([row.occurredAt, row.eventId]), "utf8").toString("base64url");
const CursorShape = z.tuple([z.string().min(10).max(40), GUARD_EVENT_ID]);
const decodeCursor = (cursor: string): { occurredAt: string; eventId: string } => {
  try {
    const [occurredAt, eventId] = CursorShape.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
    return { occurredAt, eventId };
  } catch {
    throw new GuardError(400, "VALIDATION", "That cursor is not one this page handed out", "start again without a cursor");
  }
};

export const eventRowOf = (r: GuardEventRecord): GuardEventRow => ({
  eventId: r.eventId,
  occurredAt: r.occurredAt,
  kind: r.kind,
  action: r.action,
  ...(r.serviceId === undefined ? {} : { serviceId: r.serviceId }),
  ...(r.host === undefined ? {} : { host: r.host }),
  ...(r.port === undefined ? {} : { port: r.port }),
  ...(r.method === undefined ? {} : { method: r.method }),
  ...(r.pathHint === undefined ? {} : { pathHint: r.pathHint }),
  ...(r.app === undefined ? {} : { app: r.app }),
  ...(r.ruleId === undefined ? {} : { ruleId: r.ruleId }),
  ...(r.ruleKind === undefined ? {} : { ruleKind: r.ruleKind }),
  ...(r.matchType === undefined ? {} : { matchType: r.matchType }),
  ...(r.matchCount === undefined ? {} : { matchCount: r.matchCount }),
  ...(r.snippet === undefined ? {} : { snippet: r.snippet }),
  ...(r.bytes === undefined ? {} : { bytes: r.bytes }),
  ...(r.requestId === undefined ? {} : { requestId: r.requestId }),
  ...(r.bundleVersion === undefined ? {} : { bundleVersion: r.bundleVersion }),
  ...(r.reason === undefined ? {} : { reason: r.reason }),
  deviceId: r.deviceId,
  ...(r.hostname === undefined ? {} : { hostname: r.hostname }),
  person: { userId: r.personUserId, email: r.personEmail, ...(r.personName === undefined ? {} : { name: r.personName }) },
  ...(r.serviceName === undefined ? {} : { serviceName: r.serviceName }),
  ...(r.ruleName === undefined ? {} : { ruleName: r.ruleName }),
  receivedAt: r.receivedAt,
});

const appLabelOf = (r: GuardEventRecord): string | undefined => r.app?.name ?? r.app?.cli ?? r.app?.bundleId;

export const createGuardService = (options: GuardServiceOptions) => {
  const { store, sealer } = options;
  const now = options.now ?? (() => new Date());
  const audit = options.audit ?? (async () => undefined);
  const policy = () => options.policy?.();

  let opened: Promise<GuardSigningKeyPair> | undefined;
  const signingKey = (): Promise<GuardSigningKeyPair> => {
    if (opened !== undefined) return opened;
    const load = (async () => {
      let row = await store.getSigningKey();
      if (row === undefined) {
        const fresh = generateGuardSigningKey();
        const sealed = await sealer.seal(fresh.privateKeyPem, { orgId: GUARD_SIGNING_SEAL_ORG, connectionId: fresh.keyId });
        row = await store.putSigningKeyIfAbsent({ keyId: fresh.keyId, publicKeyPem: fresh.publicKeyPem, sealedPrivateKey: sealed, createdAt: now().toISOString() });
      }
      const privateKeyPem = await sealer.open(row.sealedPrivateKey, { orgId: GUARD_SIGNING_SEAL_ORG, connectionId: row.keyId });
      return { keyId: row.keyId, publicKeyPem: row.publicKeyPem, privateKeyPem };
    })();
    opened = load;
    load.catch(() => {
      if (opened === load) opened = undefined;
    });
    return load;
  };

  const seed = () => seedCatalogue();
  const catalogueOf = async (orgId: string): Promise<{ catalogue: GuardCatalogue; overrides: GuardServiceOverride[]; version: number; updatedAt?: string }> => {
    const row = await store.getOverrides(orgId);
    const s = seed();
    return {
      catalogue: applyCatalogueOverrides(s, row?.overrides ?? [], row?.version ?? 0, row?.updatedAt ?? s.generatedAt),
      overrides: row?.overrides ?? [],
      version: row?.version ?? 0,
      ...(row?.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
    };
  };
  const rulesOf = async (orgId: string) => {
    const row = await store.getRules(orgId);
    return { document: row?.document ?? options.newOrg?.rules ?? emptyGuardRules(), ...(row === undefined ? {} : { updatedAt: row.updatedAt, updatedBy: row.updatedBy, stored: row.version }) };
  };
  const settingsOf = async (orgId: string) => {
    const row = await store.getSettings(orgId);
    return { settings: row?.settings ?? options.newOrg?.settings ?? defaultGuardSettings(), ...(row === undefined ? {} : { updatedAt: row.updatedAt }) };
  };
  const personOf = async (orgId: string, userId: string, email: string): Promise<GuardPerson> => {
    const groups = options.groups === undefined ? [] : await options.groups.groupsOf(orgId, email);
    return { userId, email: normEmail(email), groupIds: groups.map((g) => g.id) };
  };
  const GrantSubject = z.object({ serviceId: z.string().min(1), ruleId: z.string().min(1).optional() }).passthrough();
  const grantsOf = async (orgId: string): Promise<GuardGrantLike[]> => {
    const desk = policy();
    if (desk === undefined) return [];
    const out: GuardGrantLike[] = [];
    for (const g of await desk.listGrants(orgId)) {
      if (g.kind !== GUARD_REQUEST_KIND || !g.live) continue;
      const subject = GrantSubject.safeParse(g.subject);
      if (!subject.success) continue;
      out.push({
        id: g.id,
        scope: g.scope,
        ...(g.userId === undefined ? {} : { userId: g.userId }),
        subject: { serviceId: subject.data.serviceId, ...(subject.data.ruleId === undefined ? {} : { ruleId: subject.data.ruleId }) },
        ...(g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt }),
        ...(g.revokedAt === undefined ? {} : { revokedAt: g.revokedAt }),
      });
    }
    return out;
  };
  const memberByEmail = async (orgId: string, email: string) => (await options.members.listMembers(orgId)).find((m) => normEmail(m.email) === normEmail(email));

  const requireSurfaceCatalogue = (blocks: GuardSurfaceBlocks | undefined, catalogue: GuardCatalogue) => {
    const unavailable = GUARD_SURFACE_IDS.filter((id) => blocks?.[id] === true && !catalogue.services.some((row) => row.serviceId === GUARD_SURFACE_SERVICE_IDS[id] && row.enabled));
    if (unavailable.length) throw new GuardError(409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE", "Surface blocks require their AI catalogue service to remain enabled", `enable the related AI service or clear these surface controls: ${unavailable.join(", ")}`);
  };

  const bundleFor = async (device: GuardDeviceRecord) => {
    const [rules, cat, settings, grants, person] = await Promise.all([
      rulesOf(device.orgId),
      catalogueOf(device.orgId),
      settingsOf(device.orgId),
      grantsOf(device.orgId),
      personOf(device.orgId, device.personUserId, device.personEmail),
    ]);
    requireSurfaceCatalogue(rules.document.surfaceBlocks, cat.catalogue);
    if (!supportsSurfaceBlocks(device.facts, rules.document.surfaceBlocks)) {
      throw new GuardError(409, "GUARD_UPGRADE_REQUIRED", "This policy requires an agent supporting independent surface blocks", "upgrade this device before syncing; the registry will not send an unenforced surface policy");
    }
    const compiled = compileGuardBundle({ document: rules.document, catalogue: cat.catalogue, person, settings: settings.settings, grants, orgId: device.orgId, deviceId: device.deviceId, now: now() });
    const bundle = GuardBundle.parse({ ...compiled, generatedAt: maxIso(rules.updatedAt, settings.updatedAt, cat.updatedAt, device.enrolledAt) });
    return { bundle, digest: digestOf(bundle), catalogue: cat.catalogue, settings: settings.settings };
  };

  const authenticate = async (deviceId: string, authorization: string | undefined): Promise<GuardDeviceRecord> => {
    const bearer = /^Bearer\s+(gdt_[0-9a-f]{48})\s*$/.exec(authorization ?? "")?.[1];
    if (bearer === undefined) throw new GuardError(401, "GUARD_TOKEN_INVALID", "Send the device token as Authorization: Bearer gdt_…", "the token was minted at enrol and is in the agent's data directory");
    if (!GUARD_DEVICE_ID.safeParse(deviceId).success) throw new GuardError(404, "GUARD_DEVICE_UNKNOWN", "No such device on this registry", "enrol this laptop again");
    const device = await store.getDeviceForSync(deviceId);
    if (device === undefined) throw new GuardError(404, "GUARD_DEVICE_UNKNOWN", "No such device on this registry", "enrol this laptop again");
    const presented = Buffer.from(tokenHashOf(bearer), "hex");
    const stored = Buffer.from(device.tokenSha256, "hex");
    if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) throw new GuardError(401, "GUARD_TOKEN_INVALID", "That device token is not this device's", "enrol this laptop again");
    if (device.status === "revoked") throw new GuardError(401, "GUARD_DEVICE_REVOKED", "IT removed this laptop from Guard", "the agent stops enforcing; ask IT for a new enrol link");
    const org = await options.orgs.getOrg(device.orgId);
    if (org === undefined || org.closedAt !== undefined) throw new GuardError(401, "GUARD_DEVICE_REVOKED", "This laptop's organisation no longer runs Guard here", "the organisation was closed");
    return device;
  };

  const service = {
    signingKey,

    async enrol(body: unknown): Promise<GuardEnrolResponse> {
      checkProtocol(body);
      const input = parseOr(GuardEnrolRequest, body, "Send { protocol, enrolToken, device, ca }");
      const at = now();
      const deviceId = mintGuardId("gdev");
      const link = await store.consumeEnrolLink(tokenHashOf(input.enrolToken), at.toISOString(), deviceId);
      if (link === undefined) throw new GuardError(400, "GUARD_ENROL_TOKEN_INVALID", "That enrol link is unknown, used or expired", "ask IT for a new one on the Devices page");
      const org = await options.orgs.getOrg(link.orgId);
      if (org === undefined || org.closedAt !== undefined) throw new GuardError(400, "GUARD_ENROL_TOKEN_INVALID", "That enrol link's organisation is closed", "ask IT");
      const member = (await options.members.listMembers(link.orgId)).find((m) => m.userId === link.personUserId);
      if (member === undefined) throw new GuardError(400, "GUARD_ENROL_TOKEN_INVALID", "The person this link was minted for is no longer in the organisation", "ask IT for a new link");
      if (!supportsSurfaceBlocks(input.device, (await rulesOf(link.orgId)).document.surfaceBlocks)) {
        throw new GuardError(409, "GUARD_UPGRADE_REQUIRED", "This organisation requires an agent supporting independent surface blocks", "upgrade Guard and ask IT for a fresh enrolment link");
      }
      const settings = (await settingsOf(link.orgId)).settings;
      const deviceToken = mintDeviceToken();
      await store.insertDevice({
        deviceId,
        orgId: link.orgId,
        personUserId: link.personUserId,
        personEmail: normEmail(link.personEmail),
        tokenSha256: tokenHashOf(deviceToken),
        facts: input.device,
        ...(input.ca === undefined ? {} : { ca: input.ca }),
        status: "active",
        clientMode: settings.clientMode,
        enrolledAt: at.toISOString(),
        lastSeenAt: at.toISOString(),
      });
      const key = await signingKey();
      await audit({ orgId: link.orgId, event: "guard.device.enrolled", actor: link.personEmail, actorKind: "door", detail: `device ${deviceId} (${clip(input.device.hostname, 80)}, agent ${input.device.agentVersion}) enrolled for ${link.personEmail} with link ${link.tokenPrefix}` });
      return {
        deviceId,
        deviceToken,
        orgId: link.orgId,
        orgHandle: org.handle ?? link.orgId,
        orgName: org.name,
        person: { userId: link.personUserId, email: normEmail(link.personEmail), ...(member.name ? { name: member.name } : {}) },
        server: { baseUrl: options.serverUrl, syncIntervalSeconds: GUARD_SYNC_INTERVAL_DEFAULT_S, batchSize: GUARD_BATCH_SIZE },
        signing: { keyId: key.keyId, alg: "ES256", publicKeyPem: key.publicKeyPem },
        clientMode: settings.clientMode,
      };
    },

    authenticate,

    async preflight(device: GuardDeviceRecord, body: unknown): Promise<GuardPreflightResponse> {
      checkProtocol(body);
      const input = parseOr(GuardPreflightRequest, body, "Send the preflight body (protocol, device, ca, clientMode, pendingEvents)");
      const at = now().toISOString();
      const updated =
        (await store.updateDevice(device.orgId, device.deviceId, { facts: input.device, clientMode: input.clientMode, lastSeenAt: at, ...(input.ca === undefined ? {} : { ca: input.ca }), ...(input.health === undefined ? {} : { health: input.health }) })) ?? device;
      const { bundle, digest, catalogue, settings } = await bundleFor(updated);
      const key = await signingKey();
      const holdsNothing = input.bundleVersion === undefined || updated.bundleDigest === undefined;
      return {
        clientMode: settings.clientMode,
        syncIntervalSeconds: GUARD_SYNC_INTERVAL_DEFAULT_S,
        batchSize: GUARD_BATCH_SIZE,
        cleanSync: input.requestCleanSync || holdsNothing,
        bundleVersion: bundle.bundleVersion,
        catalogueVersion: catalogue.version,
        rulesChanged: input.requestCleanSync || holdsNothing || updated.bundleDigest !== digest || input.bundleVersion !== bundle.bundleVersion,
        catalogueChanged: input.requestCleanSync || input.catalogueVersion !== catalogue.version,
        signingKeyId: key.keyId,
        person: { userId: updated.personUserId, email: updated.personEmail },
        serverTime: at,
      };
    },

    async ruledownload(device: GuardDeviceRecord, body: unknown): Promise<GuardRuleDownloadResponse & { digest: string }> {
      checkProtocol(body);
      const input = parseOr(GuardRuleDownloadRequest, body, "Send { protocol, bundleVersion?, catalogueVersion? }");
      const { bundle, digest, catalogue } = await bundleFor(device);
      const key = await signingKey();
      const at = now();
      const sendBundle = input.bundleVersion === undefined || input.bundleVersion !== bundle.bundleVersion || device.bundleDigest !== digest;
      const sendCatalogue = input.catalogueVersion === undefined || input.catalogueVersion !== catalogue.version;
      return {
        ...(sendBundle ? { bundle: signGuardBundle(bundle, key, at) } : {}),
        ...(sendCatalogue ? { catalogue: signGuardCatalogue(catalogue, device.orgId, key, at) } : {}),
        digest,
      };
    },

    async eventupload(device: GuardDeviceRecord, body: unknown): Promise<GuardEventUploadResponse> {
      checkProtocol(body);
      const envelope = parseOr(
        z.object({ protocol: z.literal(GUARD_PROTOCOL_VERSION), events: z.array(z.unknown()).min(1).max(GUARD_EVENT_UPLOAD_MAX) }).strict(),
        body,
        `Send { protocol, events } with 1 to ${GUARD_EVENT_UPLOAD_MAX} events`,
      );
      const [rules, cat, settings, members] = await Promise.all([rulesOf(device.orgId), catalogueOf(device.orgId), settingsOf(device.orgId), options.members.listMembers(device.orgId)]);
      const personName = members.find((m) => m.userId === device.personUserId)?.name ?? undefined;
      const receivedAt = now().toISOString();
      const rejected: GuardEventUploadResponse["rejected"] = [];
      const rows: GuardEventRecord[] = [];
      for (const raw of envelope.events) {
        const rawId = (raw as { eventId?: unknown } | null)?.eventId;
        const id = GUARD_EVENT_ID.safeParse(rawId).success ? (rawId as string) : undefined;
        const parsed = GuardEvent.safeParse(raw);
        if (!parsed.success) {
          if (id !== undefined) rejected.push({ eventId: id, reason: clip(zodDetail(parsed.error), 200) });
          continue;
        }
        const e = parsed.data;
        const occurred = new Date(e.occurredAt);
        if (Number.isNaN(occurred.getTime())) {
          rejected.push({ eventId: e.eventId, reason: "occurredAt is not an instant" });
          continue;
        }
        const snippet = e.snippet === undefined || settings.settings.snippetPolicy === "none" || snippetLooksRaw(e.snippet) ? undefined : e.snippet.slice(0, GUARD_SNIPPET_MAX);
        const serviceName = e.serviceId === undefined ? undefined : cat.catalogue.services.find((s) => s.serviceId === e.serviceId)?.name;
        const ruleName = e.reason === "tls-client-hello-unreproducible" || e.reason === "upstream-replay-failed" || e.reason === "tls-address-without-sni" || e.reason === "tls-client-hello-unparseable" ? "Inspection unavailable (TLS)" : e.reason === "websocket-coverage" || e.reason === "http-coverage" ? "Inspection unavailable" : ruleNameOf(rules.document, cat.catalogue, e.ruleId);
        const { snippet: _dropped, occurredAt: _o, wouldAction, ...rest } = e;
        rows.push({
          ...rest,
          ...(wouldAction === undefined || e.action !== "observed" ? {} : { wouldAction }),
          orgId: device.orgId,
          deviceId: device.deviceId,
          personUserId: device.personUserId,
          personEmail: device.personEmail,
          ...(personName ? { personName } : {}),
          hostname: device.facts.hostname,
          occurredAt: occurred.toISOString(),
          receivedAt,
          ...(snippet === undefined ? {} : { snippet }),
          ...(serviceName === undefined ? {} : { serviceName }),
          ...(ruleName === undefined ? {} : { ruleName }),
        });
      }
      await store.insertEvents(rows);
      await store.updateDevice(device.orgId, device.deviceId, { lastSeenAt: receivedAt });
      return { accepted: rows.length, rejected };
    },

    async postflight(device: GuardDeviceRecord, body: unknown): Promise<GuardPostflightResponse> {
      checkProtocol(body);
      const input = parseOr(GuardPostflightRequest, body, "Send the postflight body (protocol, bundleVersion, catalogueVersion, rulesReceived, rulesProcessed, clientMode)");
      if (!supportsSurfaceBlocks(device.facts, (await rulesOf(device.orgId)).document.surfaceBlocks)) {
        throw new GuardError(409, "GUARD_UPGRADE_REQUIRED", "This device cannot report surface policy activation after losing required capability", "upgrade and sync before reporting the policy as applied");
      }
      const at = now().toISOString();
      await store.updateDevice(device.orgId, device.deviceId, {
        bundleVersion: input.bundleVersion,
        catalogueVersion: input.catalogueVersion,
        clientMode: input.clientMode,
        lastPostflightAt: at,
        lastSeenAt: at,
        ...(input.bundleDigest === undefined ? {} : { bundleDigest: input.bundleDigest }),
      });
      return { ok: true, nextSyncInSeconds: GUARD_SYNC_INTERVAL_DEFAULT_S };
    },

    async ask(device: GuardDeviceRecord, body: unknown): Promise<GuardAskResponse> {
      const input = parseOr(GuardAskBody, body, "Send { serviceId, ruleId?, matchType?, eventId?, app?, note? }");
      const desk = policy();
      if (desk === undefined) throw new GuardError(404, "GUARD_OFF", "This registry has no request desk", "IT approves Guard asks on the policy desk; it is not running here");
      const settings = (await settingsOf(device.orgId)).settings;
      if (!settings.requestsEnabled) throw new GuardError(403, "GUARD_REQUESTS_OFF", "Your organisation does not take access requests from the block page", "ask IT directly");
      const [rules, cat] = await Promise.all([rulesOf(device.orgId), catalogueOf(device.orgId)]);
      const svc = cat.catalogue.services.find((s) => s.serviceId === input.serviceId);
      if (svc === undefined) throw new GuardError(400, "VALIDATION", "That AI service is not in your organisation's catalogue", input.serviceId);
      const contentRule = input.ruleId === undefined ? undefined : rules.document.contentRules.find((r) => r.ruleId === input.ruleId);
      const subject = GuardAskSubject.parse({
        serviceId: svc.serviceId,
        serviceName: svc.name,
        ...(contentRule === undefined ? {} : { ruleId: contentRule.ruleId, ruleName: contentRule.name, matchType: input.matchType ?? contentRule.detector.kind }),
        deviceId: device.deviceId,
        hostname: device.facts.hostname,
        ...(input.eventId === undefined ? {} : { eventId: input.eventId }),
        ...(input.app === undefined ? {} : { app: input.app }),
      });
      const raised = await desk.raise(device.orgId, { userId: device.personUserId, email: device.personEmail }, { kind: GUARD_REQUEST_KIND, subject, ...(input.note === undefined || input.note.trim() === "" ? {} : { why: input.note }) });
      return { request: await askViewOf(device.orgId, raised.request), created: raised.created };
    },

    async asks(device: GuardDeviceRecord): Promise<{ requests: GuardAskView[] }> {
      const desk = policy();
      if (desk === undefined) return { requests: [] };
      const mine = (await desk.myRequests(device.orgId, device.personUserId)).filter((r) => r.kind === GUARD_REQUEST_KIND);
      const out: GuardAskView[] = [];
      for (const r of mine) out.push(await askViewOf(device.orgId, r));
      return { requests: out };
    },

    async overview(orgId: string, days: 7 | 30): Promise<GuardOverviewPage> {
      const at = now();
      const startDay = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()) - (days - 1) * DAY_MS);
      const [events, devices, settings, cat, rules, open] = await Promise.all([
        store.listEvents(orgId, { since: startDay.toISOString(), limit: 200_000 }),
        store.listDevices(orgId),
        settingsOf(orgId),
        catalogueOf(orgId),
        rulesOf(orgId),
        (async () => (await policy()?.listRequests(orgId, { status: "pending", kind: "guard" }))?.length ?? 0)(),
      ]);
      const active = devices.filter((d) => d.status === "active");
      const quietCut = at.getTime() - settings.settings.quietAfterMinutes * 60_000;
      const quiet = active.filter((d) => new Date(d.lastSeenAt ?? d.enrolledAt).getTime() < quietCut).length;
      const perService = new Map<string, { people: Set<string>; devices: Set<string>; events: number; blocked: number; bytes: number; last?: string }>();
      const perDay = new Map<string, { events: number; blocked: number; people: Set<string> }>();
      const blocks = new Map<string, { ruleId?: string; ruleName: string; kind: "service" | "content" | "default"; count: number }>();
      const apps = new Map<string, { app: string; bundleId?: string; events: number }>();
      const people = new Set<string>();
      const monitor = settings.settings.clientMode === "monitor";
      const wouldBlock = (e: GuardEventRecord): boolean => e.action === "blocked" || (monitor && e.wouldAction === "blocked");
      let blocked = 0;
      let asked = 0;
      for (const e of events) {
        people.add(e.personUserId);
        if (wouldBlock(e)) blocked += 1;
        if (e.action === "asked") asked += 1;
        if (e.serviceId !== undefined) {
          const s = perService.get(e.serviceId) ?? { people: new Set<string>(), devices: new Set<string>(), events: 0, blocked: 0, bytes: 0 };
          s.people.add(e.personUserId);
          s.devices.add(e.deviceId);
          s.events += 1;
          if (wouldBlock(e)) s.blocked += 1;
          s.bytes += e.bytes ?? 0;
          if (s.last === undefined || e.occurredAt > s.last) s.last = e.occurredAt;
          perService.set(e.serviceId, s);
        }
        const day = e.occurredAt.slice(0, 10);
        const d = perDay.get(day) ?? { events: 0, blocked: 0, people: new Set<string>() };
        d.events += 1;
        if (wouldBlock(e)) d.blocked += 1;
        d.people.add(e.personUserId);
        perDay.set(day, d);
        if ((wouldBlock(e) || e.action === "asked" || (monitor && e.wouldAction === "asked")) && e.ruleKind !== "exception") {
          const kind: "service" | "content" | "default" = e.ruleKind === "content" || e.ruleKind === "service" ? e.ruleKind : e.ruleId?.startsWith("gcr_") ? "content" : e.ruleId?.startsWith("gsr_") ? "service" : "default";
          const key = e.reason === "tls-client-hello-unreproducible" || e.reason === "upstream-replay-failed" || e.reason === "tls-address-without-sni" || e.reason === "tls-client-hello-unparseable" ? "coverage:tls" : e.reason === "websocket-coverage" ? "coverage:websocket" : e.reason === "http-coverage" ? "coverage:http" : e.ruleId ?? `default:${kind}`;
          const name = e.ruleName ?? ruleNameOf(rules.document, cat.catalogue, e.ruleId) ?? (kind === "default" ? "The default action" : (e.ruleId ?? "A rule"));
          const b = blocks.get(key) ?? { ...(e.ruleId === undefined ? {} : { ruleId: e.ruleId }), ruleName: clip(name, 80), kind, count: 0 };
          b.count += 1;
          blocks.set(key, b);
        }
        const label = appLabelOf(e);
        if (label !== undefined) {
          const a = apps.get(label) ?? { app: clip(label, 120), ...(e.app?.bundleId === undefined ? {} : { bundleId: e.app.bundleId }), events: 0 };
          a.events += 1;
          apps.set(label, a);
        }
      }
      const trend: GuardOverviewPage["trend"] = [];
      for (let i = 0; i < days; i += 1) {
        const day = new Date(startDay.getTime() + i * DAY_MS).toISOString().slice(0, 10);
        const d = perDay.get(day);
        trend.push({ day, events: d?.events ?? 0, blocked: d?.blocked ?? 0, people: d?.people.size ?? 0 });
      }
      const services: GuardOverviewPage["services"] = [...perService.entries()]
        .map(([serviceId, s]) => {
          const row = cat.catalogue.services.find((c) => c.serviceId === serviceId);
          return {
            serviceId,
            name: row?.name ?? serviceId,
            category: row?.category ?? "chat",
            people: s.people.size,
            devices: s.devices.size,
            events: s.events,
            blocked: s.blocked,
            bytes: s.bytes,
            ...(s.last === undefined ? {} : { lastSeenAt: s.last }),
          };
        })
        .sort((a, b) => b.events - a.events || a.name.localeCompare(b.name))
        .slice(0, 500);
      return {
        windowDays: days,
        clientMode: settings.settings.clientMode,
        totals: { people: people.size, devices: active.length, quietDevices: quiet, services: perService.size, events: events.length, blocked, asked, openRequests: open },
        services,
        trend,
        topBlocks: [...blocks.values()].sort((a, b) => b.count - a.count).slice(0, 10),
        topApps: [...apps.values()].sort((a, b) => b.events - a.events).slice(0, 10),
        recent: events.slice(0, 10).map(eventRowOf),
        noDevicesYet: !devices.some((d) => d.lastSeenAt !== undefined),
      };
    },

    async activity(orgId: string, query: unknown): Promise<GuardActivityPage> {
      const q = parseOr(GuardActivityQuery, query, "Activity filters: cursor, limit (1–200), serviceId, action, deviceId, personUserId, q");
      const rows = await store.listEvents(orgId, {
        limit: q.limit + 1,
        ...(q.cursor === undefined ? {} : { before: decodeCursor(q.cursor) }),
        ...(q.serviceId === undefined ? {} : { serviceId: q.serviceId }),
        ...(q.action === undefined ? {} : { action: q.action }),
        ...(q.deviceId === undefined ? {} : { deviceId: q.deviceId }),
        ...(q.personUserId === undefined ? {} : { personUserId: q.personUserId }),
        ...(q.q === undefined || q.q.trim() === "" ? {} : { q: q.q.trim() }),
      });
      const page = rows.slice(0, q.limit);
      const last = page.at(-1);
      return { rows: page.map(eventRowOf), ...(rows.length > q.limit && last !== undefined ? { nextCursor: cursorOf(last) } : {}) };
    },

    async rulesPage(orgId: string): Promise<GuardRulesPage> {
      const [rules, settings, cat, groups] = await Promise.all([rulesOf(orgId), settingsOf(orgId), catalogueOf(orgId), options.groups?.list(orgId) ?? Promise.resolve([])]);
      return {
        document: rules.document,
        ...(rules.updatedAt === undefined ? {} : { updatedAt: rules.updatedAt }),
        ...(rules.updatedBy === undefined ? {} : { updatedBy: rules.updatedBy }),
        clientMode: settings.settings.clientMode,
        groups: groups.map((g) => ({ id: g.id, name: g.name })).slice(0, 500),
        services: cat.catalogue.services.filter((s) => s.enabled).map((s) => ({ serviceId: s.serviceId, name: s.name, category: s.category })),
      };
    },

    async putRules(orgId: string, actor: { email: string }, body: unknown): Promise<GuardRulesPage> {
      const input = parseOr(GuardRulesUpdate, body, "Send { baseVersion, document }");
      const [current, cat] = await Promise.all([store.getRules(orgId), catalogueOf(orgId)]);
      const currentVersion = current?.version ?? 0;
      if (input.baseVersion !== currentVersion) throw new GuardError(409, "STALE_BASE", `The rules changed since you loaded them (now version ${currentVersion}, yours ${input.baseVersion})`, "reload the rules and make your change again");
      if (GUARD_SURFACE_IDS.some((id) => input.document.surfaceBlocks?.[id] === true && current?.document.surfaceBlocks?.[id] !== true && !GUARD_ACTIVATABLE_SURFACES.includes(id))) {
        throw new GuardError(409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE", "Native app surface blocks await verified route capture", "Claude macOS and ChatGPT macOS controls cannot be enabled until their request routes are verified");
      }
      const enablingSurface = GUARD_SURFACE_IDS.some((id) => input.document.surfaceBlocks?.[id] === true && current?.document.surfaceBlocks?.[id] !== true);
      if (enablingSurface) {
        requireSurfaceCatalogue(input.document.surfaceBlocks, cat.catalogue);
        const unsupported = (await store.listDevices(orgId)).filter((d) => d.status !== "revoked" && !supportsSurfaceBlocks(d.facts, input.document.surfaceBlocks));
        if (unsupported.length > 0) throw new GuardError(409, "GUARD_UPGRADE_REQUIRED", "Upgrade all active Guard agents before enabling surface blocks", `${unsupported.length} active device(s) have not reported surface-block support; sync upgraded agents first`);
      }
      const known = new Set(cat.catalogue.services.map((s) => s.serviceId));
      const unknown = [...input.document.serviceRules.map((r) => r.serviceId), ...input.document.contentRules.flatMap((r) => (r.services === "*" ? [] : r.services))].filter((id) => id !== "*" && !known.has(id));
      if (unknown.length > 0) throw new GuardError(400, "VALIDATION", "A rule names an AI service that is not in your catalogue", [...new Set(unknown)].join(", "));
      const groupIds = [...input.document.serviceRules, ...input.document.contentRules].flatMap((r) => (r.audience.kind === "groups" ? r.audience.groupIds : []));
      if (groupIds.length > 0) {
        const groups = new Set(((await options.groups?.list(orgId)) ?? []).map((g) => g.id));
        const missing = groupIds.filter((g) => !groups.has(g));
        if (missing.length > 0) throw new GuardError(400, "VALIDATION", "A rule names a group this organisation does not have", [...new Set(missing)].join(", "));
      }
      const document = GuardRulesDocument.parse({
        version: currentVersion + 1,
        defaultAction: input.document.defaultAction,
        ...(input.document.surfaceBlocks === undefined ? {} : { surfaceBlocks: input.document.surfaceBlocks }),
        serviceRules: input.document.serviceRules.map((r) => ({ ...r, ruleId: r.ruleId ?? mintGuardId("gsr", 4), ...(r.audience.kind === "people" ? { audience: { kind: "people", emails: r.audience.emails.map(normEmail) } } : {}) })),
        contentRules: input.document.contentRules.map((r) => ({ ...r, ruleId: r.ruleId ?? mintGuardId("gcr", 4), ...(r.audience.kind === "people" ? { audience: { kind: "people", emails: r.audience.emails.map(normEmail) } } : {}) })),
      });
      const ids = [...document.serviceRules.map((r) => r.ruleId), ...document.contentRules.map((r) => r.ruleId)];
      if (new Set(ids).size !== ids.length) throw new GuardError(400, "VALIDATION", "Two rules share an id", "drop the ruleId from a copied row and the registry mints a new one");
      const at = now().toISOString();
      const ok = await store.casRules({ orgId, version: document.version, document, updatedAt: at, updatedBy: actor.email }, current?.version);
      if (!ok) throw new GuardError(409, "STALE_BASE", "Someone saved the rules at the same moment", "reload the rules and make your change again");
      await audit({ orgId, event: "guard.rules.changed", actor: actor.email, actorKind: "admin", detail: `Guard rules v${currentVersion} -> v${document.version}: ${document.serviceRules.length} service rule(s), ${document.contentRules.length} content rule(s), ${Object.values(document.surfaceBlocks ?? {}).filter(Boolean).length} surface block(s), default ${document.defaultAction}` });
      return service.rulesPage(orgId);
    },

    async testRules(orgId: string, body: unknown): Promise<GuardRuleTestResult> {
      const input = parseOr(GuardRuleTestInput, body, "Name a service or a host, and optionally the person, the text and the file names");
      const [rules, cat, settings, grants] = await Promise.all([rulesOf(orgId), catalogueOf(orgId), settingsOf(orgId), grantsOf(orgId)]);
      let person: GuardPerson = { userId: "guard-test", email: "nobody@guard.test", groupIds: [] };
      if (input.personEmail !== undefined) {
        const member = await memberByEmail(orgId, input.personEmail);
        if (member === undefined) throw new GuardError(400, "VALIDATION", "That address is not a member of this organisation", input.personEmail);
        person = await personOf(orgId, member.userId, member.email);
      }
      const named = input.serviceId === undefined ? undefined : cat.catalogue.services.find((s) => s.serviceId === input.serviceId);
      if (input.serviceId !== undefined && named === undefined) throw new GuardError(400, "VALIDATION", "That AI service is not in your catalogue", input.serviceId);
      const host = input.host ?? hostOfService(named!);
      const bundle = compileGuardBundle({ document: rules.document, catalogue: cat.catalogue, person, settings: settings.settings, grants, orgId, deviceId: TEST_DEVICE_ID, now: now() });
      const v = decideRequest(bundle, cat.catalogue, { host, ...(input.bundleId === undefined ? {} : { bundleId: input.bundleId }), ...(input.text === undefined ? {} : { text: input.text }), ...(input.filenames === undefined ? {} : { filenames: input.filenames }) });
      const content = (v.content?.matches ?? []).map((m) => ({
        ruleId: m.rule.ruleId,
        ruleName: m.rule.name,
        matchType: m.match.kind,
        count: m.match.count,
        action: m.rule.action,
        ...(m.match.examples[0] === undefined ? {} : { example: m.match.examples[0].slice(0, 80) }),
        excepted: m.excepted,
      }));
      const svcName = v.service?.name ?? host;
      let explanation: string;
      if (v.verdict === "not-intercepted") explanation = `${host} is not an AI service in your catalogue, so the agent passes it through without looking.`;
      else if (v.flow !== undefined && v.flow.action !== "allow") {
        const why = v.flow.source === "rule" ? `the rule "${ruleNameOf(rules.document, cat.catalogue, v.flow.ruleId) ?? v.flow.ruleId}"` : "the default action";
        explanation = v.flow.action === "block" ? `${svcName} is blocked for this person by ${why}.` : `${svcName} needs IT's OK for this person (${why}); the block page offers Request access.`;
      } else if (v.content?.decidedBy !== undefined) {
        const m = v.content.matches.find((x) => x.rule.ruleId === v.content?.decidedBy?.ruleId);
        explanation = `The rule "${v.content.decidedBy.name}" found ${m?.match.count ?? 1} match(es) of ${v.content.decidedBy.detector.kind} and ${v.verdict === "blocked" ? "blocks" : "asks IT about"} sending it to ${svcName}.`;
      } else {
        const recorded = content.filter((c) => !c.excepted).length;
        const excepted = content.filter((c) => c.excepted).length;
        explanation = `Allowed: ${svcName} is open to this person${v.flow?.source === "exception" ? " (a live grant)" : ""}${recorded > 0 ? `; ${recorded} rule(s) only record what they found` : "; no content rule fired"}${excepted > 0 ? `; ${excepted} rule(s) are excepted by a live grant` : ""}.`;
      }
      if (!v.enforced && (v.verdict === "blocked" || v.verdict === "asked")) explanation += " Guard is in monitor mode: the agent records this and lets it through.";
      return {
        ...(v.service === undefined ? {} : { serviceId: v.service.serviceId, serviceName: v.service.name }),
        intercepted: v.intercepted,
        ...(v.flow === undefined ? {} : { flow: { action: v.flow.action, source: v.flow.source, ...(v.flow.ruleId === undefined ? {} : { ruleId: v.flow.ruleId }) } }),
        content,
        verdict: v.verdict,
        explanation: clip(explanation, 400),
        enforced: v.enforced,
      };
    },

    async devicesPage(orgId: string): Promise<GuardDevicesPage> {
      const [devices, settings, members, recent] = await Promise.all([
        store.listDevices(orgId),
        settingsOf(orgId),
        options.members.listMembers(orgId),
        store.listEvents(orgId, { since: new Date(now().getTime() - DAY_MS).toISOString(), limit: 200_000 }),
      ]);
      const counts = new Map<string, number>();
      for (const e of recent) counts.set(e.deviceId, (counts.get(e.deviceId) ?? 0) + 1);
      const names = new Map(members.map((m) => [m.userId, m.name] as const));
      return {
        rows: devices.map((d) => deviceRowOf(d, settings.settings.quietAfterMinutes, names.get(d.personUserId) ?? undefined, counts.get(d.deviceId) ?? 0)),
        quietAfterMinutes: settings.settings.quietAfterMinutes,
        serverUrl: options.serverUrl,
      };
    },

    async mintEnrolLink(orgId: string, actor: { email: string }, body: unknown): Promise<GuardEnrolLink> {
      const input = parseOr(GuardEnrolLinkCreate, body, "Name the person the laptop enrols as (personEmail), and optionally expiresInHours (1–168) and a note");
      const member = await memberByEmail(orgId, input.personEmail);
      if (member === undefined) throw new GuardError(400, "VALIDATION", "An enrol link is bound to one person in this organisation, and that address is not one", input.personEmail);
      const token = mintEnrolToken();
      const hash = tokenHashOf(token);
      const at = now();
      const expiresAt = new Date(at.getTime() + (input.expiresInHours ?? GUARD_ENROL_LINK_HOURS_DEFAULT) * 3_600_000).toISOString();
      await store.insertEnrolLink({
        tokenSha256: hash,
        tokenPrefix: hash.slice(0, 8),
        orgId,
        personUserId: member.userId,
        personEmail: normEmail(member.email),
        ...(input.note === undefined || input.note === "" ? {} : { note: input.note }),
        createdBy: actor.email,
        createdAt: at.toISOString(),
        expiresAt,
      });
      await audit({ orgId, event: "guard.enrol_link.minted", actor: actor.email, actorKind: "admin", detail: `enrol link ${hash.slice(0, 8)} for ${normEmail(member.email)}, until ${expiresAt}` });
      return {
        token,
        url: `vibtra-guard://enrol?server=${encodeURIComponent(options.serverUrl)}&token=${token}`,
        command: `vibtra-guard enrol --server ${options.serverUrl} --token ${token}`,
        personEmail: normEmail(member.email),
        expiresAt,
      };
    },

    async enrolLinks(orgId: string): Promise<GuardEnrolLinksPage> {
      const rows = await store.listEnrolLinks(orgId);
      return {
        rows: rows.slice(0, 1000).map((r) => ({
          tokenPrefix: r.tokenPrefix,
          personEmail: r.personEmail,
          ...(r.note === undefined ? {} : { note: r.note }),
          createdBy: r.createdBy,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
          ...(r.usedAt === undefined ? {} : { usedAt: r.usedAt }),
          ...(r.usedByDevice === undefined ? {} : { usedByDevice: r.usedByDevice }),
        })),
      };
    },

    async revokeDevice(orgId: string, actor: { email: string }, deviceId: string): Promise<GuardDeviceRow> {
      const found = await store.getDevice(orgId, deviceId);
      if (found === undefined) throw new GuardError(404, "NOT_FOUND", "No such device in this organisation", deviceId);
      const revoked = found.status === "revoked" ? found : await store.revokeDevice(orgId, deviceId, actor.email, now().toISOString());
      const row = revoked ?? (await store.getDevice(orgId, deviceId)) ?? found;
      if (found.status === "active") await audit({ orgId, event: "guard.device.revoked", actor: actor.email, actorKind: "admin", detail: `device ${deviceId} (${clip(found.facts.hostname, 80)}, ${found.personEmail}) revoked; it stops syncing at its next call` });
      const settings = (await settingsOf(orgId)).settings;
      const name = (await options.members.listMembers(orgId)).find((m) => m.userId === row.personUserId)?.name ?? undefined;
      return deviceRowOf(row, settings.quietAfterMinutes, name, 0);
    },

    async servicesPage(orgId: string): Promise<GuardServicesPage> {
      const [cat, events] = await Promise.all([catalogueOf(orgId), store.listEvents(orgId, { since: new Date(now().getTime() - 30 * DAY_MS).toISOString(), limit: 200_000 })]);
      const stats = new Map<string, { people: Set<string>; devices: Set<string>; events: number }>();
      for (const e of events) {
        if (e.serviceId === undefined) continue;
        const s = stats.get(e.serviceId) ?? { people: new Set<string>(), devices: new Set<string>(), events: 0 };
        s.people.add(e.personUserId);
        s.devices.add(e.deviceId);
        s.events += 1;
        stats.set(e.serviceId, s);
      }
      return {
        rows: cat.catalogue.services.map((s) => serviceRowOf(s, stats.get(s.serviceId))),
        catalogueVersion: cat.catalogue.version,
        seedVersion: GUARD_CATALOGUE_SEED_VERSION,
      };
    },

    async createService(orgId: string, actor: { email: string }, body: unknown): Promise<GuardServiceRow> {
      const input = parseOr(GuardServiceCreate, body, "Send { slug, name, vendor, category, domains, bundleIds, cliNames, defaultAction?, docsUrl?, note? }");
      const serviceId = `custom-${input.slug}`;
      const cat = await catalogueOf(orgId);
      if (seed().services.some((s) => s.serviceId === serviceId) || cat.catalogue.services.some((s) => s.serviceId === serviceId)) {
        throw new GuardError(409, "SERVICE_EXISTS", "That service id is already in your catalogue", serviceId);
      }
      const { slug: _slug, ...row } = input;
      const override: GuardServiceOverride = { serviceId, enabled: true, ...(input.defaultAction === undefined ? {} : { defaultAction: input.defaultAction }), custom: { ...row, serviceId, enabled: true } };
      await writeOverrides(orgId, actor, [...cat.overrides, override], cat.version, `custom service ${serviceId} (${input.name}) added: ${input.domains.join(", ")}`);
      const page = await service.servicesPage(orgId);
      return page.rows.find((r) => r.serviceId === serviceId)!;
    },

    async updateService(orgId: string, actor: { email: string }, serviceId: string, body: unknown): Promise<GuardServiceRow> {
      const input = parseOr(GuardServiceUpdate, body, "Send { enabled?, defaultAction? }");
      const cat = await catalogueOf(orgId);
      if (!cat.catalogue.services.some((s) => s.serviceId === serviceId)) throw new GuardError(404, "NOT_FOUND", "No such AI service in your catalogue", serviceId);
      if (input.enabled === false) {
        const rules = await rulesOf(orgId);
        const affected = GUARD_SURFACE_IDS.filter((id) => GUARD_SURFACE_SERVICE_IDS[id] === serviceId && rules.document.surfaceBlocks?.[id] === true);
        if (affected.length) throw new GuardError(409, "GUARD_SURFACE_COVERAGE_UNAVAILABLE", "Clear the related surface blocks before disabling this AI service", affected.join(", "));
      }
      const existing = cat.overrides.find((o) => o.serviceId === serviceId);
      const next: GuardServiceOverride = { ...(existing ?? { serviceId }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }), ...(input.defaultAction === undefined ? {} : { defaultAction: input.defaultAction }) };
      const overrides = existing === undefined ? [...cat.overrides, next] : cat.overrides.map((o) => (o.serviceId === serviceId ? next : o));
      await writeOverrides(orgId, actor, overrides, cat.version, `service ${serviceId}: ${input.enabled === undefined ? "" : input.enabled ? "enabled " : "disabled "}${input.defaultAction === undefined ? "" : `default ${input.defaultAction}`}`.trim());
      const page = await service.servicesPage(orgId);
      return page.rows.find((r) => r.serviceId === serviceId)!;
    },

    async deleteService(orgId: string, actor: { email: string }, serviceId: string): Promise<GuardServicesPage> {
      const cat = await catalogueOf(orgId);
      const row = cat.catalogue.services.find((s) => s.serviceId === serviceId);
      if (row === undefined) throw new GuardError(404, "NOT_FOUND", "No such AI service in your catalogue", serviceId);
      if (!row.custom) throw new GuardError(409, "SERVICE_NOT_CUSTOM", "Only a service your organisation added can be removed", "switch a catalogue row off instead");
      await writeOverrides(orgId, actor, cat.overrides.filter((o) => o.serviceId !== serviceId), cat.version, `custom service ${serviceId} removed`);
      return service.servicesPage(orgId);
    },

    async settingsPage(orgId: string): Promise<GuardSettingsPage> {
      const [settings, org, admins, devices, key] = await Promise.all([settingsOf(orgId), options.orgs.getOrg(orgId), options.members.listAdmins(orgId), store.listDevices(orgId), store.getSigningKey()]);
      const orgName = org?.name ?? orgId;
      const contact = admins.find((a) => a.role === "owner")?.email ?? admins[0]?.email;
      return {
        settings: settings.settings,
        ...(key === undefined ? {} : { signingKeyId: key.keyId }),
        staffNoticeRendered: renderStaffNotice(settings.settings.staffNotice.template, { orgName, ...(contact === undefined ? {} : { contact }) }).slice(0, 12_000),
        org: { orgId, name: orgName, handle: org?.handle ?? orgId, ...(org?.domain === undefined ? {} : { domain: org.domain }) },
        devices: devices.filter((d) => d.status === "active").length,
      };
    },

    async putSettings(orgId: string, actor: { email: string }, body: unknown): Promise<GuardSettingsPage> {
      const input = parseOr(GuardSettingsUpdate, body, "Send the settings to change (any of clientMode, quietAfterMinutes, requestsEnabled, workspaceRedirect, snippetPolicy, staffNotice)");
      const current = (await settingsOf(orgId)).settings;
      const at = now().toISOString();
      const noticeChanged = input.staffNotice !== undefined && input.staffNotice.template !== current.staffNotice.template;
      const next = GuardSettings.parse({
        ...current,
        ...input,
        staffNotice: noticeChanged ? { template: input.staffNotice!.template, updatedAt: at, updatedBy: actor.email } : current.staffNotice,
      });
      if (next.workspaceRedirect.enabled && next.workspaceRedirect.url === undefined) throw new GuardError(400, "VALIDATION", "Name where the company Vibtra workspace is before turning the redirect on", "workspaceRedirect.url");
      await store.putSettings({ orgId, settings: next, updatedAt: at, updatedBy: actor.email });
      const changed = (Object.keys(input) as Array<keyof typeof input>).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(next[k]));
      if (changed.length > 0) {
        const devices = (await store.listDevices(orgId)).filter((d) => d.status === "active").length;
        const mode = current.clientMode !== next.clientMode ? `; mode ${current.clientMode} -> ${next.clientMode} on ${devices} enrolled device(s)` : "";
        await audit({ orgId, event: "guard.settings.changed", actor: actor.email, actorKind: "admin", detail: `Guard settings changed: ${changed.join(", ")}${mode}` });
      }
      return service.settingsPage(orgId);
    },
  };

  const writeOverrides = async (orgId: string, actor: { email: string }, overrides: GuardServiceOverride[], baseVersion: number, detail: string): Promise<void> => {
    const ok = await store.casOverrides({ orgId, overrides, version: baseVersion + 1, updatedAt: now().toISOString(), updatedBy: actor.email }, baseVersion === 0 ? undefined : baseVersion);
    if (!ok) throw new GuardError(409, "STALE_BASE", "Someone changed the AI services at the same moment", "reload and try again");
    await audit({ orgId, event: "guard.service.changed", actor: actor.email, actorKind: "admin", detail: clip(detail, 400) });
  };

  const askViewOf = async (
    orgId: string,
    r: { id: string; status: string; subject: Record<string, unknown>; createdAt: string; expiresAt: string; decidedAt?: string; decisionNote?: string; grantId?: string },
  ): Promise<GuardAskView> => {
    let grantExpiresAt: string | undefined;
    if (r.grantId !== undefined) grantExpiresAt = (await policy()?.listGrants(orgId))?.find((g) => g.id === r.grantId)?.expiresAt;
    return {
      requestId: r.id,
      kind: GUARD_REQUEST_KIND,
      status: r.status as GuardAskView["status"],
      subject: GuardAskSubject.parse(r.subject),
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      ...(r.decidedAt === undefined ? {} : { decidedAt: r.decidedAt }),
      ...(r.decisionNote === undefined ? {} : { decisionNote: r.decisionNote }),
      ...(grantExpiresAt === undefined ? {} : { grantExpiresAt }),
    };
  };

  const deviceRowOf = (d: GuardDeviceRecord, quietAfterMinutes: number, name: string | undefined, eventsLast24h: number): GuardDeviceRow => {
    const seen = new Date(d.lastSeenAt ?? d.enrolledAt).getTime();
    const silentMin = Math.max(0, Math.floor((now().getTime() - seen) / 60_000));
    const quiet = d.status === "active" && silentMin >= quietAfterMinutes;
    const health = d.health === undefined ? undefined : Object.fromEntries(Object.entries({ caTrusted: d.health.caTrusted, proxyListening: d.health.proxyListening, extensionActive: d.health.extensionActive, model: d.health.model, interception: d.health.interception }).filter(([, v]) => v !== undefined));
    return {
      deviceId: d.deviceId,
      hostname: d.facts.hostname,
      ...(d.facts.serialNumber === undefined ? {} : { serialNumber: d.facts.serialNumber }),
      ...(d.facts.modelIdentifier === undefined ? {} : { modelIdentifier: d.facts.modelIdentifier }),
      osVersion: d.facts.osVersion,
      agentVersion: d.facts.agentVersion,
      ...(d.facts.primaryUser === undefined ? {} : { primaryUser: d.facts.primaryUser }),
      person: { userId: d.personUserId, email: d.personEmail, ...(name ? { name } : {}) },
      status: d.status,
      clientMode: d.clientMode,
      enrolledAt: d.enrolledAt,
      ...(d.lastSeenAt === undefined ? {} : { lastSeenAt: d.lastSeenAt }),
      ...(d.lastPostflightAt === undefined ? {} : { lastPostflightAt: d.lastPostflightAt }),
      ...(d.bundleVersion === undefined ? {} : { bundleVersion: d.bundleVersion }),
      ...(d.bundleDigest === undefined ? {} : { bundleDigest: d.bundleDigest }),
      ...(d.catalogueVersion === undefined ? {} : { catalogueVersion: d.catalogueVersion }),
      ...(d.ca === undefined ? {} : { ca: d.ca }),
      ...(health === undefined ? {} : { health }),
      quiet,
      ...(quiet ? { quietForMinutes: silentMin } : {}),
      eventsLast24h,
      ...(d.revokedAt === undefined ? {} : { revokedAt: d.revokedAt }),
      ...(d.revokedBy === undefined ? {} : { revokedBy: d.revokedBy }),
    };
  };

  return service;
};

const serviceRowOf = (s: GuardCatalogueService, stats: { people: Set<string>; devices: Set<string>; events: number } | undefined): GuardServiceRow => ({
  ...s,
  people30d: stats?.people.size ?? 0,
  devices30d: stats?.devices.size ?? 0,
  events30d: stats?.events ?? 0,
});

export type GuardService = ReturnType<typeof createGuardService>;
