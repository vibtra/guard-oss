import { z } from "zod";

export const REGISTRATION_NOTICE_PATH = "/auth/registration";

const ConsoleRegistrationMode = z.enum(["open", "allowlist"]);

export const ConsoleRegistrationNotice = z.object({
  mode: ConsoleRegistrationMode,
  contactEmail: z.string().min(1).optional(),
});
export type ConsoleRegistrationNotice = z.infer<typeof ConsoleRegistrationNotice>;

const ConsoleAllowlistKind = z.enum(["email", "domain"]);

export const ConsoleAllowlistRow = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  kind: ConsoleAllowlistKind,
  note: z.string().max(200).optional(),
  addedBy: z.string().min(1),
  addedAt: z.string().min(1),
});
export type ConsoleAllowlistRow = z.infer<typeof ConsoleAllowlistRow>;

export const ConsoleRegistrationPage = z.object({
  mode: ConsoleRegistrationMode,
  rows: z.array(ConsoleAllowlistRow),
  mayManage: z.boolean(),
  contactEmail: z.string().min(1).optional(),
  operatorDomain: z.string().min(1).optional(),
  freeBudget: z.object({ usedHours: z.number().nonnegative(), budgetHours: z.number().nonnegative(), resetsOn: z.string().min(1) }).optional(),
  waitlist: z.array(z.object({ orgId: z.string().min(1), name: z.string().min(1), createdAt: z.string().min(1) })).optional(),
});
export type ConsoleRegistrationPage = z.infer<typeof ConsoleRegistrationPage>;

export const ConsoleAllowlistAddition = z.object({
  subject: z.string().trim().min(1).max(254),
  note: z.string().trim().max(200).optional(),
});
export type ConsoleAllowlistAddition = z.infer<typeof ConsoleAllowlistAddition>;
