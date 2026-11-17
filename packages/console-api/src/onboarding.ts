import { z } from "zod";

export const ONBOARDING_STAGES = ["invited", "signed_in", "enrolled", "certificate_trusted", "protected", "late", "tampered"] as const;

export const OnboardingStage = z.enum(ONBOARDING_STAGES);
export type OnboardingStage = z.infer<typeof OnboardingStage>;

export const DEFAULT_CHASE_AFTER_DAYS = 7;
export const ChaseAfterDays = z.number().int().min(1).max(365);
export type ChaseAfterDays = z.infer<typeof ChaseAfterDays>;

const IsoTime = z.string().datetime({ offset: true });

export const OnboardingPersonRow = z
  .object({
    kind: z.literal("person"),
    userId: z.string().min(1),
    email: z.string().min(1),
    name: z.string().min(1).optional(),
    role: z.enum(["owner", "admin", "member"]),
    stage: OnboardingStage,
    stageSince: IsoTime,
    chase: z.boolean(),
  })
  .strict();
export type OnboardingPersonRow = z.infer<typeof OnboardingPersonRow>;

export const OnboardingInviteRow = z
  .object({
    kind: z.literal("invite"),
    invitationId: z.string().min(1),
    email: z.string().min(1),
    role: z.enum(["admin", "member"]),
    stage: z.literal("invited"),
    stageSince: IsoTime,
    chase: z.boolean(),
    lastSentAt: IsoTime.optional(),
    expiresAt: IsoTime.optional(),
  })
  .strict();
export type OnboardingInviteRow = z.infer<typeof OnboardingInviteRow>;

export const OnboardingRow = z.discriminatedUnion("kind", [OnboardingPersonRow, OnboardingInviteRow]);
export type OnboardingRow = z.infer<typeof OnboardingRow>;

export const OnboardingSettings = z.object({ chaseAfterDays: ChaseAfterDays }).strict();
export type OnboardingSettings = z.infer<typeof OnboardingSettings>;

export const OnboardingPage = z
  .object({
    rows: z.array(OnboardingRow),
    chaseAfterDays: ChaseAfterDays,
  })
  .strict();
export type OnboardingPage = z.infer<typeof OnboardingPage>;
