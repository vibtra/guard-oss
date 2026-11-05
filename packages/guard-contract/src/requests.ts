// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { z } from "zod";
import { GUARD_DEVICE_ID, GUARD_EVENT_ID, GUARD_REQUEST_KIND, GUARD_RULE_ID, GUARD_SERVICE_ID } from "./ids.js";
import { GuardDetectorKind } from "./rules.js";

export const GuardAskSubject = z
  .object({
    serviceId: GUARD_SERVICE_ID,
    serviceName: z.string().min(1).max(80).optional(),
    ruleId: GUARD_RULE_ID.optional(),
    ruleName: z.string().min(1).max(80).optional(),
    matchType: GuardDetectorKind.optional(),
    deviceId: GUARD_DEVICE_ID,
    hostname: z.string().min(1).max(253).optional(),
    eventId: GUARD_EVENT_ID.optional(),
    app: z.string().min(1).max(120).optional(),
  })
  .strict();
export type GuardAskSubject = z.infer<typeof GuardAskSubject>;

export const guardAskKey = (subject: Pick<GuardAskSubject, "serviceId" | "ruleId">, requesterUserId: string): string =>
  `${subject.serviceId}/${subject.ruleId ?? "*"}@${requesterUserId}`;

export const GuardAskBody = z
  .object({
    serviceId: GUARD_SERVICE_ID,
    ruleId: GUARD_RULE_ID.optional(),
    matchType: GuardDetectorKind.optional(),
    eventId: GUARD_EVENT_ID.optional(),
    app: z.string().min(1).max(120).optional(),
    note: z.string().max(280).optional(),
  })
  .strict();
export type GuardAskBody = z.infer<typeof GuardAskBody>;

export const GUARD_ASK_STATUSES = ["pending", "approved", "declined", "expired", "cancelled", "superseded"] as const;
export const GuardAskStatus = z.enum(GUARD_ASK_STATUSES);

export const GuardAskView = z
  .object({
    requestId: z.string().min(1).max(60),
    kind: z.literal(GUARD_REQUEST_KIND),
    status: GuardAskStatus,
    subject: GuardAskSubject,
    createdAt: z.string().min(10).max(40),
    expiresAt: z.string().min(10).max(40),
    decidedAt: z.string().min(10).max(40).optional(),
    decisionNote: z.string().max(280).optional(),
    grantExpiresAt: z.string().min(10).max(40).optional(),
  })
  .strict();
export type GuardAskView = z.infer<typeof GuardAskView>;

export const GuardAskResponse = z.object({ request: GuardAskView, created: z.boolean() }).strict();
export type GuardAskResponse = z.infer<typeof GuardAskResponse>;
export const GuardAsksResponse = z.object({ requests: z.array(GuardAskView) }).strict();
export type GuardAsksResponse = z.infer<typeof GuardAsksResponse>;
