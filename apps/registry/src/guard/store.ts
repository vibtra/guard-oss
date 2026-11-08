import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  GUARD_DEVICE_ID,
  GUARD_EVENT_ID,
  GUARD_KEY_ID,
  GUARD_RULE_ID,
  GUARD_SERVICE_ID,
  GUARD_SNIPPET_MAX,
  GuardCaFacts,
  GuardClientMode,
  GuardDetectorKind,
  GuardDeviceFacts,
  GuardEventAction,
  GuardEventApp,
  GuardEventKind,
  GuardEventWouldAction,
  GuardInterceptionHealth,
  GuardModelHealth,
  GuardRulesDocument,
  GuardServiceOverride,
  GuardSettings,
} from "@vibtra/guard-contract";

const ISO = z.string().min(10).max(40);
const HEX64 = z.string().regex(/^[0-9a-f]{64}$/);
const ORG_ID = z.string().min(1).max(100);
const USER_ID = z.string().min(1).max(200);
const EMAIL = z.string().min(3).max(254);

export const GuardSigningKeyRow = z
  .object({ keyId: GUARD_KEY_ID, publicKeyPem: z.string().min(100).max(1000), sealedPrivateKey: z.string().min(1), createdAt: ISO })
  .strict();
export type GuardSigningKeyRow = z.infer<typeof GuardSigningKeyRow>;

export const GuardEnrolLinkRecord = z
  .object({
    tokenSha256: HEX64,
    tokenPrefix: z.string().regex(/^[0-9a-f]{8}$/),
    orgId: ORG_ID,
    personUserId: USER_ID,
    personEmail: EMAIL,
    note: z.string().max(120).optional(),
    createdBy: z.string().min(1).max(254),
    createdAt: ISO,
    expiresAt: ISO,
    usedAt: ISO.optional(),
    usedByDevice: GUARD_DEVICE_ID.optional(),
  })
  .strict();
export type GuardEnrolLinkRecord = z.infer<typeof GuardEnrolLinkRecord>;

export const GuardDeviceHealth = z
  .object({
    caTrusted: z.boolean().optional(),
    proxyListening: z.boolean().optional(),
    extensionActive: z.boolean().optional(),
    uptimeSeconds: z.number().int().min(0).optional(),
    model: GuardModelHealth.optional(),
    interception: GuardInterceptionHealth.optional(),
  })
  .strict();
export type GuardDeviceHealth = z.infer<typeof GuardDeviceHealth>;

export const GuardDeviceRecord = z
  .object({
    deviceId: GUARD_DEVICE_ID,
    orgId: ORG_ID,
    personUserId: USER_ID,
    personEmail: EMAIL,
    tokenSha256: HEX64,
    facts: GuardDeviceFacts,
    ca: GuardCaFacts.optional(),
    health: GuardDeviceHealth.optional(),
    status: z.enum(["active", "revoked"]),
    clientMode: GuardClientMode,
    enrolledAt: ISO,
    lastSeenAt: ISO.optional(),
    lastPostflightAt: ISO.optional(),
    bundleVersion: z.number().int().min(0).optional(),
    bundleDigest: HEX64.optional(),
    catalogueVersion: z.string().min(1).max(80).optional(),
    revokedAt: ISO.optional(),
    revokedBy: z.string().min(1).max(254).optional(),
  })
  .strict();
export type GuardDeviceRecord = z.infer<typeof GuardDeviceRecord>;

export const GuardRulesRecord = z
  .object({ orgId: ORG_ID, version: z.number().int().min(0), document: GuardRulesDocument, updatedAt: ISO, updatedBy: z.string().min(1).max(254) })
  .strict();
export type GuardRulesRecord = z.infer<typeof GuardRulesRecord>;

export const GuardSettingsRecord = z.object({ orgId: ORG_ID, settings: GuardSettings, updatedAt: ISO, updatedBy: z.string().min(1).max(254) }).strict();
export type GuardSettingsRecord = z.infer<typeof GuardSettingsRecord>;

export const GuardOverridesRecord = z
  .object({ orgId: ORG_ID, overrides: z.array(GuardServiceOverride).max(500), version: z.number().int().min(0), updatedAt: ISO, updatedBy: z.string().min(1).max(254) })
  .strict();
export type GuardOverridesRecord = z.infer<typeof GuardOverridesRecord>;

export const GuardEventRecord = z
  .object({
    orgId: ORG_ID,
    eventId: GUARD_EVENT_ID,
    deviceId: GUARD_DEVICE_ID,
    personUserId: USER_ID,
    personEmail: EMAIL,
    personName: z.string().min(1).max(200).optional(),
    hostname: z.string().min(1).max(253).optional(),
    occurredAt: ISO,
    receivedAt: ISO,
    kind: GuardEventKind,
    action: GuardEventAction,
    serviceId: GUARD_SERVICE_ID.optional(),
    serviceName: z.string().min(1).max(80).optional(),
    host: z.string().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    method: z.string().regex(/^[A-Z]{3,10}$/).optional(),
    pathHint: z.string().max(40).optional(),
    app: GuardEventApp.optional(),
    ruleId: GUARD_RULE_ID.optional(),
    ruleName: z.string().min(1).max(80).optional(),
    ruleKind: z.enum(["service", "content", "default", "exception"]).optional(),
    matchType: GuardDetectorKind.optional(),
    matchCount: z.number().int().min(0).max(1_000_000).optional(),
    snippet: z.string().max(GUARD_SNIPPET_MAX).optional(),
    bytes: z.number().int().min(0).optional(),
    requestId: z.string().min(1).max(60).optional(),
    bundleVersion: z.number().int().min(0).optional(),
    reason: z.string().max(60).optional(),
    wouldAction: GuardEventWouldAction.optional(),
  })
  .strict();
export type GuardEventRecord = z.infer<typeof GuardEventRecord>;

export interface GuardEventQuery {
  since?: string;
  before?: { occurredAt: string; eventId: string };
  limit: number;
  serviceId?: string;
  action?: string;
  deviceId?: string;
  personUserId?: string;
  q?: string;
}

export type GuardDevicePatch = Partial<
  Pick<GuardDeviceRecord, "facts" | "ca" | "health" | "clientMode" | "lastSeenAt" | "lastPostflightAt" | "bundleVersion" | "bundleDigest" | "catalogueVersion">
>;

export interface GuardStore {
  getSigningKey(): Promise<GuardSigningKeyRow | undefined>;
  putSigningKeyIfAbsent(row: GuardSigningKeyRow): Promise<GuardSigningKeyRow>;

  insertEnrolLink(row: GuardEnrolLinkRecord): Promise<void>;
  consumeEnrolLink(tokenSha256: string, now: string, deviceId: string): Promise<GuardEnrolLinkRecord | undefined>;
  listEnrolLinks(orgId: string): Promise<GuardEnrolLinkRecord[]>;

  insertDevice(row: GuardDeviceRecord): Promise<void>;
  getDeviceForSync(deviceId: string): Promise<GuardDeviceRecord | undefined>;
  getDevice(orgId: string, deviceId: string): Promise<GuardDeviceRecord | undefined>;
  listDevices(orgId: string): Promise<GuardDeviceRecord[]>;
  updateDevice(orgId: string, deviceId: string, patch: GuardDevicePatch): Promise<GuardDeviceRecord | undefined>;
  revokeDevice(orgId: string, deviceId: string, by: string, at: string): Promise<GuardDeviceRecord | undefined>;

  getRules(orgId: string): Promise<GuardRulesRecord | undefined>;
  casRules(row: GuardRulesRecord, baseVersion: number | undefined): Promise<boolean>;

  getSettings(orgId: string): Promise<GuardSettingsRecord | undefined>;
  putSettings(row: GuardSettingsRecord): Promise<void>;

  getOverrides(orgId: string): Promise<GuardOverridesRecord | undefined>;
  casOverrides(row: GuardOverridesRecord, baseVersion: number | undefined): Promise<boolean>;

  insertEvents(rows: readonly GuardEventRecord[]): Promise<number>;
  listEvents(orgId: string, query: GuardEventQuery): Promise<GuardEventRecord[]>;
}

interface FileShape {
  signingKey?: GuardSigningKeyRow;
  enrolLinks: GuardEnrolLinkRecord[];
  devices: GuardDeviceRecord[];
  rules: Record<string, GuardRulesRecord>;
  settings: Record<string, GuardSettingsRecord>;
  overrides: Record<string, GuardOverridesRecord>;
  events: GuardEventRecord[];
}

const empty = (): FileShape => ({ enrolLinks: [], devices: [], rules: {}, settings: {}, overrides: {}, events: [] });

export const createFileGuardStore = async (file: string): Promise<GuardStore> => {
  let state: FileShape;
  try {
    state = { ...empty(), ...(JSON.parse(await readFile(file, "utf8")) as Partial<FileShape>) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = empty();
  }
  let chain: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return chain;
  };
  return createGuardStoreOver(() => state, save);
};

export const createMemoryGuardStore = (): GuardStore => {
  const state = empty();
  return createGuardStoreOver(() => state, async () => undefined);
};

const copy = <T>(row: T): T => structuredClone(row);

export const eventMatches = (row: GuardEventRecord, orgId: string, q: GuardEventQuery): boolean => {
  if (row.orgId !== orgId) return false;
  if (q.since !== undefined && row.occurredAt < q.since) return false;
  if (q.before !== undefined && !(row.occurredAt < q.before.occurredAt || (row.occurredAt === q.before.occurredAt && row.eventId < q.before.eventId))) return false;
  if (q.serviceId !== undefined && row.serviceId !== q.serviceId) return false;
  if (q.action !== undefined && row.action !== q.action) return false;
  if (q.deviceId !== undefined && row.deviceId !== q.deviceId) return false;
  if (q.personUserId !== undefined && row.personUserId !== q.personUserId) return false;
  if (q.q !== undefined && q.q !== "") {
    const needle = q.q.toLowerCase();
    const hay = [row.host, row.app?.name, row.serviceName, row.ruleName, row.personEmail];
    if (!hay.some((h) => h !== undefined && h.toLowerCase().includes(needle))) return false;
  }
  return true;
};

const newestFirst = (a: GuardEventRecord, b: GuardEventRecord): number =>
  a.occurredAt === b.occurredAt ? (a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0) : a.occurredAt < b.occurredAt ? 1 : -1;

const createGuardStoreOver = (get: () => FileShape, save: () => Promise<void>): GuardStore => ({
  async getSigningKey() {
    const row = get().signingKey;
    return row ? copy(row) : undefined;
  },
  async putSigningKeyIfAbsent(row) {
    const state = get();
    if (state.signingKey === undefined) {
      state.signingKey = GuardSigningKeyRow.parse(row);
      await save();
    }
    return copy(state.signingKey);
  },
  async insertEnrolLink(row) {
    get().enrolLinks.push(GuardEnrolLinkRecord.parse(row));
    await save();
  },
  async consumeEnrolLink(tokenSha256, now, deviceId) {
    const row = get().enrolLinks.find((l) => l.tokenSha256 === tokenSha256);
    if (!row || row.usedAt !== undefined || row.expiresAt <= now) return undefined;
    row.usedAt = now;
    row.usedByDevice = deviceId;
    await save();
    return copy(row);
  },
  async listEnrolLinks(orgId) {
    return get()
      .enrolLinks.filter((l) => l.orgId === orgId)
      .map(copy)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  },
  async insertDevice(row) {
    const state = get();
    if (state.devices.some((d) => d.deviceId === row.deviceId)) throw new Error(`guard device ${row.deviceId} exists`);
    state.devices.push(GuardDeviceRecord.parse(row));
    await save();
  },
  async getDeviceForSync(deviceId) {
    const row = get().devices.find((d) => d.deviceId === deviceId);
    return row ? copy(row) : undefined;
  },
  async getDevice(orgId, deviceId) {
    const row = get().devices.find((d) => d.deviceId === deviceId && d.orgId === orgId);
    return row ? copy(row) : undefined;
  },
  async listDevices(orgId) {
    return get()
      .devices.filter((d) => d.orgId === orgId)
      .map(copy)
      .sort((a, b) => (a.enrolledAt === b.enrolledAt ? (a.deviceId < b.deviceId ? -1 : 1) : a.enrolledAt < b.enrolledAt ? -1 : 1));
  },
  async updateDevice(orgId, deviceId, patch) {
    const row = get().devices.find((d) => d.deviceId === deviceId && d.orgId === orgId);
    if (!row) return undefined;
    const next = GuardDeviceRecord.parse({ ...row, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) });
    Object.assign(row, next);
    await save();
    return copy(row);
  },
  async revokeDevice(orgId, deviceId, by, at) {
    const row = get().devices.find((d) => d.deviceId === deviceId && d.orgId === orgId);
    if (!row || row.status !== "active") return undefined;
    row.status = "revoked";
    row.revokedAt = at;
    row.revokedBy = by;
    await save();
    return copy(row);
  },
  async getRules(orgId) {
    const row = get().rules[orgId];
    return row ? copy(row) : undefined;
  },
  async casRules(row, baseVersion) {
    const state = get();
    const current = state.rules[row.orgId];
    if ((current?.version ?? undefined) !== baseVersion) return false;
    state.rules[row.orgId] = GuardRulesRecord.parse(row);
    await save();
    return true;
  },
  async getSettings(orgId) {
    const row = get().settings[orgId];
    return row ? GuardSettingsRecord.parse(copy(row)) : undefined;
  },
  async putSettings(row) {
    get().settings[row.orgId] = GuardSettingsRecord.parse(row);
    await save();
  },
  async getOverrides(orgId) {
    const row = get().overrides[orgId];
    return row ? copy(row) : undefined;
  },
  async casOverrides(row, baseVersion) {
    const state = get();
    const current = state.overrides[row.orgId];
    if ((current?.version ?? undefined) !== baseVersion) return false;
    state.overrides[row.orgId] = GuardOverridesRecord.parse(row);
    await save();
    return true;
  },
  async insertEvents(rows) {
    const state = get();
    const seen = new Set(state.events.map((e) => `${e.orgId} ${e.eventId}`));
    let added = 0;
    for (const raw of rows) {
      const row = GuardEventRecord.parse(raw);
      const key = `${row.orgId} ${row.eventId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      state.events.push(row);
      added += 1;
    }
    if (added > 0) await save();
    return added;
  },
  async listEvents(orgId, query) {
    return get()
      .events.filter((e) => eventMatches(e, orgId, query))
      .sort(newestFirst)
      .slice(0, query.limit)
      .map(copy);
  },
});
