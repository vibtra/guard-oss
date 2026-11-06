// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { GuardSurfaceId } from "./rules.js";
import { z } from "zod";
import { GuardClientMode, SignedGuardBundle, SignedGuardCatalogue } from "./bundle.js";
import { GuardEvent } from "./events.js";
import { GUARD_DEVICE_ID, GUARD_EVENT_ID, GUARD_EVENT_UPLOAD_MAX, GUARD_KEY_ID, GUARD_PROTOCOL_VERSION } from "./ids.js";

export const GuardDeviceFacts = z
  .object({
    hostname: z.string().min(1).max(253),
    serialNumber: z.string().min(1).max(64).optional(),
    modelIdentifier: z.string().min(1).max(64).optional(),
    osVersion: z.string().min(1).max(40),
    osBuild: z.string().min(1).max(40).optional(),
    agentVersion: z.string().min(1).max(40),
    capabilities: z.object({ surfaceBlocks: z.literal(1).optional() }).strict().optional(),
    supportedSurfaceBlocks: z.array(GuardSurfaceId).max(4).optional(),
    primaryUser: z.string().min(1).max(120).optional(),
    arch: z.enum(["arm64", "x86_64"]).optional(),
  })
  .strict();
export type GuardDeviceFacts = z.infer<typeof GuardDeviceFacts>;

export const GuardCaFacts = z
  .object({
    fingerprintSha256: z.string().regex(/^[0-9a-f]{64}$/),
    subject: z.string().min(1).max(200),
    notAfter: z.string().min(10).max(40),
  })
  .strict();
export type GuardCaFacts = z.infer<typeof GuardCaFacts>;

export const GuardSigningKey = z
  .object({ keyId: GUARD_KEY_ID, alg: z.literal("ES256"), publicKeyPem: z.string().min(100).max(1000) })
  .strict();
export type GuardSigningKey = z.infer<typeof GuardSigningKey>;

export const GuardEnrolRequest = z
  .object({
    protocol: z.literal(GUARD_PROTOCOL_VERSION),
    enrolToken: z.string().regex(/^genr_[0-9a-f]{32}$/),
    device: GuardDeviceFacts,
    ca: GuardCaFacts,
  })
  .strict();
export type GuardEnrolRequest = z.infer<typeof GuardEnrolRequest>;

export const GuardEnrolResponse = z
  .object({
    deviceId: GUARD_DEVICE_ID,
    deviceToken: z.string().regex(/^gdt_[0-9a-f]{48}$/),
    orgId: z.string().min(1).max(100),
    orgHandle: z.string().min(1).max(100),
    orgName: z.string().min(1).max(200),
    person: z.object({ userId: z.string().min(1), email: z.string().min(1), name: z.string().min(1).optional() }).strict(),
    server: z.object({ baseUrl: z.string().url(), syncIntervalSeconds: z.number().int().min(10).max(86_400), batchSize: z.number().int().min(1).max(GUARD_EVENT_UPLOAD_MAX) }).strict(),
    signing: GuardSigningKey,
    clientMode: GuardClientMode,
  })
  .strict();
export type GuardEnrolResponse = z.infer<typeof GuardEnrolResponse>;

export const GuardModelHealth = z
  .object({
    phase: z.enum(["missing", "downloading", "verifying", "loading", "warming", "ready", "failed"]),
    progress: z.number().min(0).max(1).optional(),
    reason: z.string().regex(/^(hash_mismatch|disk|network|http_\d{3}|size|load|warm|unpinned)$/).optional(),
    since: z.string().datetime({ offset: true }).optional(),
    retryAt: z.string().datetime({ offset: true }).optional(),
    manifest: z.string().min(1).max(200).optional(),
  })
  .strict();
export type GuardModelHealth = z.infer<typeof GuardModelHealth>;

export const GuardInterceptionOffReason = z.enum(["unsigned-build", "no-secure-enclave", "key-unavailable", "signer-unavailable", "awaiting-trust", "unsupported-platform"]);
export type GuardInterceptionOffReason = z.infer<typeof GuardInterceptionOffReason>;

export const GuardInterceptionHealth = z.discriminatedUnion("on", [
  z.object({ on: z.literal(true) }).strict(),
  z.object({ on: z.literal(false), reason: GuardInterceptionOffReason }).strict(),
]);
export type GuardInterceptionHealth = z.infer<typeof GuardInterceptionHealth>;

export const GuardPreflightRequest = z
  .object({
    protocol: z.literal(GUARD_PROTOCOL_VERSION),
    device: GuardDeviceFacts,
    ca: GuardCaFacts,
    clientMode: GuardClientMode,
    bundleVersion: z.number().int().min(0).optional(),
    catalogueVersion: z.string().min(1).max(80).optional(),
    signingKeyId: GUARD_KEY_ID.optional(),
    requestCleanSync: z.boolean().default(false),
    pendingEvents: z.number().int().min(0),
    health: z
      .object({
        caTrusted: z.boolean().optional(),
        proxyListening: z.boolean().optional(),
        extensionActive: z.boolean().optional(),
        uptimeSeconds: z.number().int().min(0).optional(),
        model: GuardModelHealth.optional(),
        interception: GuardInterceptionHealth.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type GuardPreflightRequest = z.infer<typeof GuardPreflightRequest>;

export const GuardPreflightResponse = z
  .object({
    clientMode: GuardClientMode,
    syncIntervalSeconds: z.number().int().min(10).max(86_400),
    batchSize: z.number().int().min(1).max(GUARD_EVENT_UPLOAD_MAX),
    cleanSync: z.boolean(),
    bundleVersion: z.number().int().min(0),
    catalogueVersion: z.string().min(1).max(80),
    rulesChanged: z.boolean(),
    catalogueChanged: z.boolean(),
    signingKeyId: GUARD_KEY_ID,
    person: z.object({ userId: z.string().min(1), email: z.string().min(1) }).strict(),
    serverTime: z.string().min(10).max(40),
  })
  .strict();
export type GuardPreflightResponse = z.infer<typeof GuardPreflightResponse>;

export const GuardRuleDownloadRequest = z
  .object({
    protocol: z.literal(GUARD_PROTOCOL_VERSION),
    bundleVersion: z.number().int().min(0).optional(),
    catalogueVersion: z.string().min(1).max(80).optional(),
  })
  .strict();
export type GuardRuleDownloadRequest = z.infer<typeof GuardRuleDownloadRequest>;

export const GuardRuleDownloadResponse = z
  .object({
    bundle: SignedGuardBundle.optional(),
    catalogue: SignedGuardCatalogue.optional(),
  })
  .strict();
export type GuardRuleDownloadResponse = z.infer<typeof GuardRuleDownloadResponse>;

export const GuardEventUploadRequest = z
  .object({ protocol: z.literal(GUARD_PROTOCOL_VERSION), events: z.array(GuardEvent).min(1).max(GUARD_EVENT_UPLOAD_MAX) })
  .strict();
export type GuardEventUploadRequest = z.infer<typeof GuardEventUploadRequest>;

export const GuardEventUploadResponse = z
  .object({
    accepted: z.number().int().min(0),
    rejected: z.array(z.object({ eventId: GUARD_EVENT_ID, reason: z.string().max(200) }).strict()).max(GUARD_EVENT_UPLOAD_MAX),
  })
  .strict();
export type GuardEventUploadResponse = z.infer<typeof GuardEventUploadResponse>;

export const GuardPostflightRequest = z
  .object({
    protocol: z.literal(GUARD_PROTOCOL_VERSION),
    bundleVersion: z.number().int().min(0),
    catalogueVersion: z.string().min(1).max(80),
    rulesReceived: z.number().int().min(0),
    rulesProcessed: z.number().int().min(0),
    clientMode: GuardClientMode,
    bundleDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();
export type GuardPostflightRequest = z.infer<typeof GuardPostflightRequest>;

export const GuardPostflightResponse = z.object({ ok: z.literal(true), nextSyncInSeconds: z.number().int().min(10).max(86_400) }).strict();
export type GuardPostflightResponse = z.infer<typeof GuardPostflightResponse>;

export const GUARD_SYNC_ERROR_CODES = [
  "GUARD_ENROL_TOKEN_INVALID",
  "GUARD_DEVICE_UNKNOWN",
  "GUARD_DEVICE_REVOKED",
  "GUARD_TOKEN_INVALID",
  "GUARD_PROTOCOL_UNSUPPORTED",
  "GUARD_OFF",
] as const;
export type GuardSyncErrorCode = (typeof GUARD_SYNC_ERROR_CODES)[number];
