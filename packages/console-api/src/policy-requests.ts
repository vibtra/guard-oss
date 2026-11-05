import { z } from "zod";

const CONSOLE_POLICY_REQUEST_KINDS = ["package", "egress-host", "connector", "model", "policy-change", "package-registry", "image-change", "spending-cap", "plan", "app-promote", "history-exception", "guard"] as const;
const CONSOLE_POLICY_REQUEST_STATUSES = ["pending", "approved", "declined", "expired", "cancelled", "superseded"] as const;

export const ConsolePolicyRequestRow = z
  .object({
    id: z.string(),
    orgId: z.string(),
    workspaceId: z.string().optional(),
    sessionId: z.string().optional(),
    requesterUserId: z.string(),
    kind: z.enum(CONSOLE_POLICY_REQUEST_KINDS),
    subject: z.record(z.unknown()),
    subjectKey: z.string(),
    words: z.string(),
    proposedRevision: z.string().optional(),
    baseRevision: z.string().optional(),
    status: z.enum(CONSOLE_POLICY_REQUEST_STATUSES),
    decidedBy: z.string().optional(),
    decidedAt: z.string().optional(),
    decisionNote: z.string().optional(),
    grantId: z.string().optional(),
    reminderAt: z.string(),
    expiresAt: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type ConsolePolicyRequestRow = z.infer<typeof ConsolePolicyRequestRow>;

export const ConsolePolicyRequestsPage = z.object({ requests: z.array(ConsolePolicyRequestRow) });
export type ConsolePolicyRequestsPage = z.infer<typeof ConsolePolicyRequestsPage>;

export const ConsolePolicyRequestPage = z.object({ request: ConsolePolicyRequestRow, facts: z.record(z.unknown()) });
export type ConsolePolicyRequestPage = z.infer<typeof ConsolePolicyRequestPage>;

export const ConsolePolicyDecision = z
  .object({
    grant: z.object({ days: z.number().int().min(1).max(90).optional(), hours: z.number().int().min(1).max(23).optional(), scope: z.enum(["user", "org"]).optional() }).strict().optional(),
    note: z.string().max(280).optional(),
    binding: z.object({ env: z.string().max(64).optional(), host: z.string().max(253).optional(), access: z.enum(["read", "write"]).optional() }).strict().optional(),
  })
  .strict();
export type ConsolePolicyDecision = z.infer<typeof ConsolePolicyDecision>;

const ConsolePolicyPushPending = z.object({ workspaceId: z.string(), code: z.string(), action: z.enum(["stopped", "restart-required"]) });
export const ConsolePolicyDecided = z.object({ request: ConsolePolicyRequestRow, grant: z.record(z.unknown()).optional(), revision: z.string().optional(), restartRequired: z.array(ConsolePolicyPushPending).optional() });
export type ConsolePolicyDecided = z.infer<typeof ConsolePolicyDecided>;

export const ConsolePolicyGrantRow = z
  .object({
    id: z.string(),
    orgId: z.string(),
    scope: z.enum(["org", "user"]),
    userId: z.string().optional(),
    kind: z.string(),
    subject: z.record(z.unknown()),
    subjectKey: z.string(),
    expiresAt: z.string().optional(),
    requestId: z.string(),
    approvedBy: z.string(),
    createdAt: z.string(),
    revokedAt: z.string().optional(),
    revokedBy: z.string().optional(),
    live: z.boolean(),
  })
  .passthrough();
export type ConsolePolicyGrantRow = z.infer<typeof ConsolePolicyGrantRow>;
export const ConsolePolicyGrantsPage = z.object({ grants: z.array(ConsolePolicyGrantRow) });
export type ConsolePolicyGrantsPage = z.infer<typeof ConsolePolicyGrantsPage>;
