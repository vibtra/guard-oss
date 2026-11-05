// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GUARD_DEVICE_ID, GUARD_EVENT_ID, GUARD_RULE_ID, GUARD_SERVICE_ID, GUARD_SNIPPET_MAX } from "./ids.js";
import { GuardDetectorKind } from "./rules.js";

export const GUARD_EVENT_KINDS = ["flow", "content", "agent"] as const;
export const GuardEventKind = z.enum(GUARD_EVENT_KINDS);
export type GuardEventKind = z.infer<typeof GuardEventKind>;

export const GUARD_EVENT_ACTIONS = ["observed", "allowed", "blocked", "asked", "redirected", "requested"] as const;
export const GuardEventAction = z.enum(GUARD_EVENT_ACTIONS);
export type GuardEventAction = z.infer<typeof GuardEventAction>;

export const GUARD_EVENT_WOULD_ACTIONS = ["blocked", "asked"] as const;
export const GuardEventWouldAction = z.enum(GUARD_EVENT_WOULD_ACTIONS);
export type GuardEventWouldAction = z.infer<typeof GuardEventWouldAction>;

export const GuardEventApp = z
  .object({
    bundleId: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(120).optional(),
    cli: z.string().min(1).max(60).optional(),
    pid: z.number().int().min(0).optional(),
  })
  .strict();
export type GuardEventApp = z.infer<typeof GuardEventApp>;

export const GuardEvent = z
  .object({
    eventId: GUARD_EVENT_ID,
    occurredAt: z.string().min(10).max(40),
    kind: GuardEventKind,
    action: GuardEventAction,
    serviceId: GUARD_SERVICE_ID.optional(),
    host: z.string().min(1).max(253).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    method: z.string().regex(/^[A-Z]{3,10}$/).optional(),
    pathHint: z.string().max(40).optional(),
    app: GuardEventApp.optional(),
    ruleId: GUARD_RULE_ID.optional(),
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
export type GuardEvent = z.infer<typeof GuardEvent>;

export const GuardEventRow = GuardEvent.extend({
  deviceId: GUARD_DEVICE_ID,
  hostname: z.string().min(1).max(253).optional(),
  person: z.object({ userId: z.string().min(1), email: z.string().min(1), name: z.string().min(1).optional() }).strict(),
  serviceName: z.string().min(1).max(80).optional(),
  ruleName: z.string().min(1).max(80).optional(),
  receivedAt: z.string().min(10).max(40),
}).strict();
export type GuardEventRow = z.infer<typeof GuardEventRow>;

export const redactMatch = (value: string): string => {
  const compact = value.replace(/[\s-]/g, "");
  if (compact.length < 7) return "*".repeat(compact.length);
  return `${compact.slice(0, 3)}${"*".repeat(compact.length - 6)}${compact.slice(-3)}`;
};
