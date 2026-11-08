// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GuardCatalogue, GuardFlowAction } from "./catalogue.js";
import { GUARD_DEVICE_ID, GUARD_KEY_ID, GUARD_LATE_AFTER_MINUTES, GUARD_LATE_AFTER_MINUTES_DEFAULT, GUARD_PROTOCOL_VERSION, GUARD_QUIET_AFTER_MINUTES_DEFAULT, GUARD_RULE_ID, GUARD_SERVICE_ID, GUARD_SNIPPET_MAX } from "./ids.js";
import { GUARD_STARTER_CONTENT_RULES, GuardContentAction, GuardDetector, GuardRulesDocument, GuardSurfaceBlocks } from "./rules.js";
import { GUARD_STAFF_NOTICE_TEMPLATE } from "./staff-notice.js";

export const GUARD_CLIENT_MODES = ["monitor", "enforce"] as const;
export const GuardClientMode = z.enum(GUARD_CLIENT_MODES);
export type GuardClientMode = z.infer<typeof GuardClientMode>;

export const GuardLateAfterMinutes = z.union([z.literal(GUARD_LATE_AFTER_MINUTES[0]), z.literal(GUARD_LATE_AFTER_MINUTES[1])]);
export type GuardLateAfterMinutes = z.infer<typeof GuardLateAfterMinutes>;

export const GuardSettings = z
  .object({
    clientMode: GuardClientMode.default("monitor"),
    quietAfterMinutes: z.number().int().min(5).max(60 * 24 * 90).default(GUARD_QUIET_AFTER_MINUTES_DEFAULT),
    lateAfterMinutes: GuardLateAfterMinutes.default(GUARD_LATE_AFTER_MINUTES_DEFAULT),
    requestsEnabled: z.boolean().default(true),
    unreproducibleTls: z.enum(["block", "tunnel"]).default("block"),
    workspaceRedirect: z.object({ enabled: z.boolean().default(false), url: z.string().url().max(500).optional() }).strict().default({ enabled: false }),
    snippetPolicy: z.enum(["none", "redacted"]).default("redacted"),
    staffNotice: z
      .object({
        template: z.string().max(10_000).default(GUARD_STAFF_NOTICE_TEMPLATE),
        updatedAt: z.string().min(10).max(40).optional(),
        updatedBy: z.string().min(1).max(254).optional(),
      })
      .strict()
      .default({ template: GUARD_STAFF_NOTICE_TEMPLATE }),
  })
  .strict();
export type GuardSettings = z.infer<typeof GuardSettings>;
export type GuardSettingsInput = z.input<typeof GuardSettings>;
export const defaultGuardSettings = (): GuardSettings => GuardSettings.parse({});

export const quickStartGuardOrg = (): { settings: GuardSettings; rules: GuardRulesDocument } => ({
  settings: GuardSettings.parse({ clientMode: "enforce" }),
  rules: GuardRulesDocument.parse({
    version: 0,
    defaultAction: "allow",
    serviceRules: [],
    contentRules: GUARD_STARTER_CONTENT_RULES.map((rule, i) => ({ ...rule, ruleId: `gcr_${(i + 1).toString(16).padStart(8, "0")}`, services: "*", audience: { kind: "org" }, enabled: true })),
  }),
});

export const GuardBundleServiceDecision = z
  .object({ action: GuardFlowAction, ruleId: GUARD_RULE_ID.optional(), note: z.string().max(200).optional() })
  .strict();
export type GuardBundleServiceDecision = z.infer<typeof GuardBundleServiceDecision>;

export const GuardBundleContentRule = z
  .object({
    ruleId: GUARD_RULE_ID,
    name: z.string().min(1).max(80),
    detector: GuardDetector,
    services: z.union([z.literal("*"), z.array(GUARD_SERVICE_ID).min(1).max(100)]),
    action: GuardContentAction,
    note: z.string().max(200).optional(),
  })
  .strict();
export type GuardBundleContentRule = z.infer<typeof GuardBundleContentRule>;

export const GuardException = z
  .object({
    grantId: z.string().min(1).max(60),
    scope: z.enum(["org", "user"]),
    serviceId: GUARD_SERVICE_ID,
    ruleId: GUARD_RULE_ID.optional(),
    expiresAt: z.string().min(10).max(40).optional(),
  })
  .strict();
export type GuardException = z.infer<typeof GuardException>;

export const GuardBundle = z
  .object({
    protocol: z.literal(GUARD_PROTOCOL_VERSION),
    orgId: z.string().min(1).max(100),
    deviceId: GUARD_DEVICE_ID,
    bundleVersion: z.number().int().min(0),
    catalogueVersion: z.string().min(1).max(80),
    generatedAt: z.string().min(10).max(40),
    person: z.object({ userId: z.string().min(1), email: z.string().min(1) }).strict(),
    clientMode: GuardClientMode,
    defaultAction: GuardFlowAction,
    services: z.record(GUARD_SERVICE_ID, GuardBundleServiceDecision),
    contentRules: z.array(GuardBundleContentRule).max(200),
    surfaceBlocks: GuardSurfaceBlocks.optional(),
    exceptions: z.array(GuardException).max(500),
    settings: z
      .object({
        requestsEnabled: z.boolean(),
        unreproducibleTls: z.enum(["block", "tunnel"]).optional(),
        workspaceRedirect: z.object({ enabled: z.boolean(), url: z.string().url().max(500).optional() }).strict(),
        snippetPolicy: z.enum(["none", "redacted"]),
        snippetMax: z.literal(GUARD_SNIPPET_MAX),
      })
      .strict(),
  })
  .strict();
export type GuardBundle = z.infer<typeof GuardBundle>;

export const GuardSignature = z
  .object({
    keyId: GUARD_KEY_ID,
    alg: z.literal("ES256"),
    jws: z.string().min(20).max(4000),
  })
  .strict();
export type GuardSignature = z.infer<typeof GuardSignature>;

export const SignedGuardBundle = z.object({ bundle: GuardBundle, signature: GuardSignature }).strict();
export type SignedGuardBundle = z.infer<typeof SignedGuardBundle>;

export const SignedGuardCatalogue = z.object({ catalogue: GuardCatalogue, signature: GuardSignature }).strict();
export type SignedGuardCatalogue = z.infer<typeof SignedGuardCatalogue>;

export const GuardSignaturePayload = z
  .object({
    kind: z.enum(["bundle", "catalogue"]),
    keyId: GUARD_KEY_ID,
    iat: z.number().int().min(0),
    orgId: z.string().min(1).max(100),
    deviceId: GUARD_DEVICE_ID.optional(),
    version: z.union([z.number().int().min(0), z.string().min(1).max(80)]),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export type GuardSignaturePayload = z.infer<typeof GuardSignaturePayload>;

export const GUARD_SIGNATURE_TYP = "vibtra-guard+jwt";

export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isInteger(value)) throw new Error("canonicalJson: a signed Guard document carries integers only");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
};
