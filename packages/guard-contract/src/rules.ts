// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GUARD_CONTENT_RULE_ID, GUARD_SERVICE_ID, GUARD_SERVICE_RULE_ID } from "./ids.js";
import { GuardFlowAction } from "./catalogue.js";

export const GuardAudience = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("org") }).strict(),
  z.object({ kind: z.literal("groups"), groupIds: z.array(z.string().min(1).max(100)).min(1).max(100) }).strict(),
  z.object({ kind: z.literal("people"), emails: z.array(z.string().min(3).max(254)).min(1).max(500) }).strict(),
]);
export type GuardAudience = z.infer<typeof GuardAudience>;

export const GuardServiceRule = z
  .object({
    ruleId: GUARD_SERVICE_RULE_ID,
    serviceId: z.union([GUARD_SERVICE_ID, z.literal("*")]),
    audience: GuardAudience,
    action: GuardFlowAction,
    enabled: z.boolean().default(true),
    note: z.string().max(200).optional(),
  })
  .strict();
export type GuardServiceRule = z.infer<typeof GuardServiceRule>;

export const GUARD_DETECTOR_KINDS = [
  "au-tfn",
  "au-abn",
  "au-acn",
  "au-medicare",
  "card-number",
  "identifiers",
  "secret",
  "email-bulk",
  "phone-bulk",
  "keyword",
  "file-type",
] as const;
export const GuardDetectorKind = z.enum(GUARD_DETECTOR_KINDS);
export type GuardDetectorKind = z.infer<typeof GuardDetectorKind>;

export const GUARD_SECRET_RULE_IDS = [
  "aws-access-token",
  "github-pat",
  "github-fine-grained-pat",
  "github-app-token",
  "openai-api-key",
  "anthropic-api-key",
  "slack-token",
  "stripe-access-token",
  "gcp-api-key",
  "gcp-oauth-token",
  "gcp-client-secret",
  "slack-webhook-url",
  "private-key",
  "jwt",
  "sendgrid-api-token",
] as const;
export const GuardSecretRuleId = z.enum(GUARD_SECRET_RULE_IDS);
export type GuardSecretRuleId = z.infer<typeof GuardSecretRuleId>;

export const GuardDetector = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("au-tfn"), requireContext: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("au-abn") }).strict(),
  z.object({ kind: z.literal("au-acn"), requireContext: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("au-medicare"), requireContext: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("card-number") }).strict(),
  z.object({ kind: z.literal("identifiers"), rules: z.array(z.string().regex(/^[a-zA-Z0-9-]{2,60}$/)).max(300).optional() }).strict(),
  z.object({ kind: z.literal("secret"), rules: z.array(GuardSecretRuleId).max(50).optional() }).strict(),
  z.object({ kind: z.literal("email-bulk"), threshold: z.number().int().min(2).max(10_000).default(10) }).strict(),
  z.object({ kind: z.literal("phone-bulk"), threshold: z.number().int().min(2).max(10_000).default(10) }).strict(),
  z
    .object({
      kind: z.literal("keyword"),
      keywords: z.array(z.string().min(1).max(100)).min(1).max(200),
      wholeWord: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      kind: z.literal("file-type"),
      extensions: z.array(z.string().regex(/^[a-z0-9]{1,12}$/)).min(1).max(100),
    })
    .strict(),
]);
export type GuardDetector = z.infer<typeof GuardDetector>;
export type GuardDetectorInput = z.input<typeof GuardDetector>;

export const GUARD_CONTENT_ACTIONS = ["block", "ask", "allow"] as const;
export const GuardContentAction = z.enum(GUARD_CONTENT_ACTIONS);
export type GuardContentAction = z.infer<typeof GuardContentAction>;

export const GuardContentRule = z
  .object({
    ruleId: GUARD_CONTENT_RULE_ID,
    name: z.string().min(1).max(80),
    detector: GuardDetector,
    services: z.union([z.literal("*"), z.array(GUARD_SERVICE_ID).min(1).max(100)]),
    audience: GuardAudience,
    action: GuardContentAction,
    enabled: z.boolean().default(true),
    note: z.string().max(200).optional(),
  })
  .strict();
export type GuardContentRule = z.infer<typeof GuardContentRule>;
export type GuardContentRuleInput = z.input<typeof GuardContentRule>;

export const GUARD_SURFACE_IDS = ["claude-web", "claude-macos", "chatgpt-web", "chatgpt-macos"] as const;
export const GUARD_ACTIVATABLE_SURFACES: readonly GuardSurfaceId[] = GUARD_SURFACE_IDS;
export const GUARD_SURFACE_SERVICE_IDS: Record<GuardSurfaceId, string> = {
  "claude-web": "anthropic-claude", "claude-macos": "anthropic-claude",
  "chatgpt-web": "openai-chatgpt", "chatgpt-macos": "openai-chatgpt",
};
export const GuardSurfaceId = z.enum(GUARD_SURFACE_IDS);
export type GuardSurfaceId = z.infer<typeof GuardSurfaceId>;
export const GuardSurfaceBlocks = z.object({
  "claude-web": z.boolean().optional(), "claude-macos": z.boolean().optional(),
  "chatgpt-web": z.boolean().optional(), "chatgpt-macos": z.boolean().optional(),
}).strict();
export type GuardSurfaceBlocks = z.infer<typeof GuardSurfaceBlocks>;
export const hasGuardSurfaceBlocks = (blocks: GuardSurfaceBlocks | undefined): boolean => GUARD_SURFACE_IDS.some((id) => blocks?.[id] === true);

export const GuardRulesDocument = z
  .object({
    version: z.number().int().min(0),
    defaultAction: GuardFlowAction.default("allow"),
    serviceRules: z.array(GuardServiceRule).max(500),
    contentRules: z.array(GuardContentRule).max(200),
    surfaceBlocks: GuardSurfaceBlocks.optional(),
  })
  .strict();
export type GuardRulesDocument = z.infer<typeof GuardRulesDocument>;
export type GuardRulesDocumentInput = z.input<typeof GuardRulesDocument>;

export const emptyGuardRules = (): GuardRulesDocument => GuardRulesDocument.parse({ version: 0, defaultAction: "allow", serviceRules: [], contentRules: [] });

export const GUARD_STARTER_CONTENT_RULES: ReadonlyArray<Omit<GuardContentRuleInput, "ruleId" | "audience" | "services">> = [
  { name: "Tax file numbers", detector: { kind: "au-tfn", requireContext: true }, action: "block", note: "A TFN is never pasted into an AI service." },
  { name: "Medicare numbers", detector: { kind: "au-medicare", requireContext: true }, action: "block" },
  { name: "ABNs and ACNs", detector: { kind: "au-abn" }, action: "allow", note: "Recorded, not blocked: ABNs are public identifiers." },
  { name: "Payment card numbers", detector: { kind: "card-number" }, action: "block" },
  { name: "Personal identifiers", detector: { kind: "identifiers" }, action: "block", note: "National IDs, tax numbers, passports, licences, bank accounts and health numbers." },
  { name: "API keys and secrets", detector: { kind: "secret" }, action: "block" },
  { name: "Bulk email addresses", detector: { kind: "email-bulk", threshold: 10 }, action: "ask" },
  { name: "Bulk phone numbers", detector: { kind: "phone-bulk", threshold: 10 }, action: "ask" },
  { name: "Spreadsheets and databases", detector: { kind: "file-type", extensions: ["xlsx", "xls", "csv", "sqlite", "db", "bak"] }, action: "ask" },
];
