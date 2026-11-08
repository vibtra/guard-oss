// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GuardClientMode, GuardException, GuardLateAfterMinutes, GuardSettings } from "./bundle.js";
import { GuardCatalogue, GuardFlowAction, GuardService } from "./catalogue.js";
import { GuardEventAction, GuardEventRow } from "./events.js";
import { GUARD_DEVICE_ID, GUARD_ENROL_LINK_HOURS_MAX, GUARD_KEY_ID, GUARD_RULE_ID, GUARD_SERVICE_ID } from "./ids.js";
import { GuardContentAction, GuardDetectorKind, GuardRulesDocument } from "./rules.js";
import { GuardCaFacts, GuardInterceptionHealth, GuardModelHealth } from "./sync.js";

const Person = z.object({ userId: z.string().min(1), email: z.string().min(1), name: z.string().min(1).optional() }).strict();

export const GuardOverviewService = z
  .object({
    serviceId: GUARD_SERVICE_ID,
    name: z.string().min(1).max(80),
    category: z.string().min(1).max(40),
    people: z.number().int().min(0),
    devices: z.number().int().min(0),
    events: z.number().int().min(0),
    blocked: z.number().int().min(0),
    bytes: z.number().int().min(0),
    lastSeenAt: z.string().min(10).max(40).optional(),
  })
  .strict();
export type GuardOverviewService = z.infer<typeof GuardOverviewService>;

export const GuardOverviewPage = z
  .object({
    windowDays: z.union([z.literal(7), z.literal(30)]),
    clientMode: GuardClientMode,
    totals: z
      .object({
        people: z.number().int().min(0),
        devices: z.number().int().min(0),
        quietDevices: z.number().int().min(0),
        services: z.number().int().min(0),
        events: z.number().int().min(0),
        blocked: z.number().int().min(0),
        asked: z.number().int().min(0),
        openRequests: z.number().int().min(0),
      })
      .strict(),
    services: z.array(GuardOverviewService).max(500),
    trend: z.array(z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), events: z.number().int().min(0), blocked: z.number().int().min(0), people: z.number().int().min(0) }).strict()).max(31),
    topBlocks: z.array(z.object({ ruleId: GUARD_RULE_ID.optional(), ruleName: z.string().min(1).max(80), kind: z.enum(["service", "content", "default"]), count: z.number().int().min(0) }).strict()).max(10),
    topApps: z.array(z.object({ app: z.string().min(1).max(120), bundleId: z.string().min(1).max(200).optional(), events: z.number().int().min(0) }).strict()).max(10),
    recent: z.array(GuardEventRow).max(10),
    noDevicesYet: z.boolean(),
  })
  .strict();
export type GuardOverviewPage = z.infer<typeof GuardOverviewPage>;

export const GuardActivityQuery = z
  .object({
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(200).default(50),
    serviceId: GUARD_SERVICE_ID.optional(),
    action: GuardEventAction.optional(),
    deviceId: GUARD_DEVICE_ID.optional(),
    personUserId: z.string().min(1).max(200).optional(),
    q: z.string().max(200).optional(),
  })
  .strict();
export type GuardActivityQuery = z.infer<typeof GuardActivityQuery>;

export const GuardActivityPage = z
  .object({
    rows: z.array(GuardEventRow).max(200),
    nextCursor: z.string().max(200).optional(),
    total: z.number().int().min(0).optional(),
  })
  .strict();
export type GuardActivityPage = z.infer<typeof GuardActivityPage>;

export const GuardRulesPage = z
  .object({
    document: GuardRulesDocument,
    updatedAt: z.string().min(10).max(40).optional(),
    updatedBy: z.string().min(1).max(254).optional(),
    clientMode: GuardClientMode,
    groups: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()).max(500),
    services: z.array(z.object({ serviceId: GUARD_SERVICE_ID, name: z.string().min(1).max(80), category: z.string().min(1).max(40) }).strict()).max(500),
  })
  .strict();
export type GuardRulesPage = z.infer<typeof GuardRulesPage>;

export const GuardRulesUpdate = z
  .object({
    baseVersion: z.number().int().min(0),
    document: GuardRulesDocument.omit({ version: true }).extend({
      serviceRules: z.array(GuardRulesDocument.shape.serviceRules.element.extend({ ruleId: GUARD_RULE_ID.optional() })).max(500),
      contentRules: z.array(GuardRulesDocument.shape.contentRules.element.extend({ ruleId: GUARD_RULE_ID.optional() })).max(200),
    }),
  })
  .strict();
export type GuardRulesUpdate = z.infer<typeof GuardRulesUpdate>;

export const GuardRuleTestInput = z
  .object({
    serviceId: GUARD_SERVICE_ID.optional(),
    host: z.string().min(1).max(253).optional(),
    bundleId: z.string().min(1).max(200).optional(),
    personEmail: z.string().min(3).max(254).optional(),
    text: z.string().max(200_000).optional(),
    filenames: z.array(z.string().min(1).max(255)).max(50).optional(),
  })
  .strict()
  .refine((v) => v.serviceId !== undefined || v.host !== undefined, { message: "name a service or a host" });
export type GuardRuleTestInput = z.infer<typeof GuardRuleTestInput>;

export const GuardRuleTestMatch = z
  .object({
    ruleId: GUARD_RULE_ID,
    ruleName: z.string().min(1).max(80),
    matchType: GuardDetectorKind,
    count: z.number().int().min(0),
    action: GuardContentAction,
    example: z.string().max(80).optional(),
    excepted: z.boolean(),
  })
  .strict();

export const GuardRuleTestResult = z
  .object({
    serviceId: GUARD_SERVICE_ID.optional(),
    serviceName: z.string().min(1).max(80).optional(),
    intercepted: z.boolean(),
    flow: z.object({ action: GuardFlowAction, ruleId: GUARD_RULE_ID.optional(), source: z.enum(["rule", "default", "exception"]) }).strict().optional(),
    content: z.array(GuardRuleTestMatch).max(200),
    verdict: z.enum(["allowed", "blocked", "asked", "not-intercepted"]),
    explanation: z.string().min(1).max(400),
    enforced: z.boolean(),
  })
  .strict();
export type GuardRuleTestResult = z.infer<typeof GuardRuleTestResult>;

export const GUARD_DEVICE_STATUSES = ["active", "revoked"] as const;
export const GuardDeviceStatus = z.enum(GUARD_DEVICE_STATUSES);
export type GuardDeviceStatus = z.infer<typeof GuardDeviceStatus>;

export const GuardDeviceRow = z
  .object({
    deviceId: GUARD_DEVICE_ID,
    hostname: z.string().min(1).max(253),
    serialNumber: z.string().min(1).max(64).optional(),
    modelIdentifier: z.string().min(1).max(64).optional(),
    osVersion: z.string().min(1).max(40),
    agentVersion: z.string().min(1).max(40),
    primaryUser: z.string().min(1).max(120).optional(),
    person: Person,
    status: GuardDeviceStatus,
    clientMode: GuardClientMode,
    enrolledAt: z.string().min(10).max(40),
    lastSeenAt: z.string().min(10).max(40).optional(),
    lastPostflightAt: z.string().min(10).max(40).optional(),
    bundleVersion: z.number().int().min(0).optional(),
    bundleDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    catalogueVersion: z.string().min(1).max(80).optional(),
    ca: GuardCaFacts.optional(),
    health: z.object({ caTrusted: z.boolean().optional(), proxyListening: z.boolean().optional(), extensionActive: z.boolean().optional(), model: GuardModelHealth.optional(), interception: GuardInterceptionHealth.optional() }).strict().optional(),
    quiet: z.boolean(),
    late: z.boolean(),
    quietForMinutes: z.number().int().min(0).optional(),
    eventsLast24h: z.number().int().min(0),
    revokedAt: z.string().min(10).max(40).optional(),
    revokedBy: z.string().min(1).max(254).optional(),
  })
  .strict();
export type GuardDeviceRow = z.infer<typeof GuardDeviceRow>;

export const GuardDevicesPage = z
  .object({
    rows: z.array(GuardDeviceRow).max(5000),
    quietAfterMinutes: z.number().int().min(5),
    lateAfterMinutes: GuardLateAfterMinutes,
    serverUrl: z.string().url(),
  })
  .strict();
export type GuardDevicesPage = z.infer<typeof GuardDevicesPage>;

export const GuardEnrolLinkCreate = z
  .object({
    personEmail: z.string().min(3).max(254),
    expiresInHours: z.number().int().min(1).max(GUARD_ENROL_LINK_HOURS_MAX).optional(),
    note: z.string().max(120).optional(),
  })
  .strict();
export type GuardEnrolLinkCreate = z.infer<typeof GuardEnrolLinkCreate>;

export const GuardEnrolLink = z
  .object({
    token: z.string().regex(/^genr_[0-9a-f]{32}$/),
    url: z.string().min(1).max(1000),
    command: z.string().min(1).max(1000),
    personEmail: z.string().min(3).max(254),
    expiresAt: z.string().min(10).max(40),
  })
  .strict();
export type GuardEnrolLink = z.infer<typeof GuardEnrolLink>;

export const GuardEnrolLinkRow = z
  .object({
    tokenPrefix: z.string().regex(/^[0-9a-f]{8}$/),
    personEmail: z.string().min(3).max(254),
    note: z.string().max(120).optional(),
    createdBy: z.string().min(1).max(254),
    createdAt: z.string().min(10).max(40),
    expiresAt: z.string().min(10).max(40),
    usedAt: z.string().min(10).max(40).optional(),
    usedByDevice: GUARD_DEVICE_ID.optional(),
  })
  .strict();
export const GuardEnrolLinksPage = z.object({ rows: z.array(GuardEnrolLinkRow).max(1000) }).strict();
export type GuardEnrolLinksPage = z.infer<typeof GuardEnrolLinksPage>;

export const GuardServiceRow = GuardService.extend({
  people30d: z.number().int().min(0),
  devices30d: z.number().int().min(0),
  events30d: z.number().int().min(0),
  seedDefaultAction: GuardFlowAction.optional(),
}).strict();
export type GuardServiceRow = z.infer<typeof GuardServiceRow>;

export const GuardServicesPage = z
  .object({ rows: z.array(GuardServiceRow).max(500), catalogueVersion: z.string().min(1).max(80), seedVersion: z.string().min(1).max(80) })
  .strict();
export type GuardServicesPage = z.infer<typeof GuardServicesPage>;

export const GuardServiceUpdate = z.object({ enabled: z.boolean().optional(), defaultAction: GuardFlowAction.optional() }).strict();
export type GuardServiceUpdate = z.infer<typeof GuardServiceUpdate>;

export const GuardServiceCreate = GuardService.omit({ serviceId: true, custom: true, enabled: true, note: true, markId: true })
  .extend({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(48), note: z.string().max(400).optional() })
  .strict();
export type GuardServiceCreate = z.infer<typeof GuardServiceCreate>;

export const GuardSettingsPage = z
  .object({
    settings: GuardSettings,
    signingKeyId: GUARD_KEY_ID.optional(),
    staffNoticeRendered: z.string().max(12_000),
    org: z.object({ orgId: z.string().min(1), name: z.string().min(1), handle: z.string().min(1), domain: z.string().min(1).optional() }).strict(),
    devices: z.number().int().min(0),
  })
  .strict();
export type GuardSettingsPage = z.infer<typeof GuardSettingsPage>;

export const GuardSettingsUpdate = GuardSettings.partial().strict();
export type GuardSettingsUpdate = z.infer<typeof GuardSettingsUpdate>;

export { GuardException };

export const GUARD_CONSOLE_RESPONSE_SCHEMAS = {
  "GET /guard/overview": GuardOverviewPage,
  "GET /guard/activity": GuardActivityPage,
  "GET /guard/rules": GuardRulesPage,
  "PUT /guard/rules": GuardRulesPage,
  "POST /guard/rules/test": GuardRuleTestResult,
  "GET /guard/devices": GuardDevicesPage,
  "POST /guard/devices/enrol-links": GuardEnrolLink,
  "GET /guard/devices/enrol-links": GuardEnrolLinksPage,
  "POST /guard/devices/:id/revoke": GuardDeviceRow,
  "GET /guard/services": GuardServicesPage,
  "POST /guard/services": GuardServiceRow,
  "PUT /guard/services/:id": GuardServiceRow,
  "DELETE /guard/services/:id": GuardServicesPage,
  "GET /guard/settings": GuardSettingsPage,
  "PUT /guard/settings": GuardSettingsPage,
} as const;
export type GuardConsoleDoor = keyof typeof GUARD_CONSOLE_RESPONSE_SCHEMAS;

export const GUARD_BANNED_FIELD_FRAGMENTS: readonly string[] = ["secret", "credential", "password", "passphrase", "sealed", "ciphertext", "privatekey", "apikey", "accesstoken", "refreshtoken", "idtoken", "bearer", "tokenhash", "rawtoken", "envvalue", "body", "content", "prompt"];
export const GUARD_BANNED_FIELD_NAMES: readonly string[] = ["token", "key", "value", "values", "env", "text"];
export const GUARD_NON_SECRET_FIELDS: ReadonlyArray<{ door: GuardConsoleDoor; field: string; why: string }> = [
  { door: "POST /guard/devices/enrol-links", field: "token", why: "a single-use enrol token, shown once, SHA-256 at rest (the hosts enrolment door's own exception)" },
];
export const GUARD_CONTENT_NAMED_FIELDS: readonly string[] = ["contentRules", "content", "snippetPolicy"];
