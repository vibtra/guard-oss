import { GuardAskSubject } from "@vibtra/guard-contract";
import type { ConsolePolicyRequestRow } from "@vibtra/console-api";
import { relativeTo } from "../govern/format";
import type { PillTone } from "@/components/kit";

export const REQUEST_STATUS: Readonly<Record<string, { label: string; tone: PillTone }>> = {
  pending: { label: "Pending", tone: "warn" },
  approved: { label: "Approved", tone: "ok" },
  declined: { label: "Declined", tone: "bad" },
  expired: { label: "Expired", tone: "muted" },
  cancelled: { label: "Withdrawn", tone: "muted" },
  superseded: { label: "Already allowed", tone: "muted" },
};
export const statusOf = (status: string): { label: string; tone: PillTone } => REQUEST_STATUS[status] ?? { label: status, tone: "muted" };

export const GUARD_TIMEBOXES = [
  { value: "1h", label: "1 hour", hours: 1 },
  { value: "8h", label: "8 hours", hours: 8 },
  { value: "7", label: "7 days", days: 7 },
  { value: "30", label: "30 days", days: 30 },
] as const;

const DAY = 24 * 3_600_000;

export const ageOf = (row: ConsolePolicyRequestRow, now: number): string => {
  const asked = relativeTo(row.createdAt, now);
  if (row.status !== "pending") return asked;
  const remind = Date.parse(row.reminderAt) - now;
  const expire = Date.parse(row.expiresAt) - now;
  if (remind > 0) return `${asked} · reminder ${relativeTo(row.reminderAt, now)}`;
  return `${asked} · expires ${expire > 0 ? relativeTo(row.expiresAt, now) : "now"}${expire > 0 && expire < 7 * DAY ? " (nudged)" : ""}`;
};

export const subjectOf = (subject: Record<string, unknown>): GuardAskSubject | undefined => {
  const parsed = GuardAskSubject.safeParse(subject);
  return parsed.success ? parsed.data : undefined;
};

export const subjectWords = (subject: Record<string, unknown>): string => {
  const s = subjectOf(subject);
  if (s === undefined) return "An AI service";
  return `${s.serviceName ?? s.serviceId}${s.ruleName === undefined ? "" : ` · ${s.ruleName}`}`;
};
