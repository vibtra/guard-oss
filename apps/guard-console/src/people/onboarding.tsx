import { ClockAlertIcon, ShieldAlertIcon, type LucideIcon } from "lucide-react";
import { ONBOARDING_STAGES, type OnboardingStage } from "@vibtra/console-api";
import { Pill, cn, type PillDot, type PillTone } from "@/components/kit";
import { absoluteWords } from "../guard/words";

export interface StageWord {
  label: string;
  tone: PillTone;
  dot?: PillDot;
  icon?: LucideIcon;
  meaning: string;
}

export const STAGE_WORD: Readonly<Record<OnboardingStage, StageWord>> = {
  invited: { label: "Invited", tone: "muted", meaning: "Invited, and has not signed in yet." },
  signed_in: { label: "Signed in", tone: "neutral", meaning: "Signed in, and has not enrolled a Mac yet." },
  enrolled: { label: "Enrolled", tone: "neutral", meaning: "Enrolled a Mac, and has not trusted the certificate yet." },
  certificate_trusted: { label: "Certificate trusted", tone: "neutral", meaning: "Trusted the certificate, and the Mac has not applied a policy yet." },
  protected: { label: "Protected", tone: "ok", dot: "ok", meaning: "The Mac syncs, sends events and passes its integrity checks." },
  late: { label: "Late", tone: "warn", icon: ClockAlertIcon, meaning: "The Mac was protected, and has stopped syncing." },
  tampered: { label: "Tampered", tone: "bad", icon: ShieldAlertIcon, meaning: "The Mac failed an integrity check." },
};

export const STAGE_OPTIONS: readonly { value: OnboardingStage; label: string }[] = ONBOARDING_STAGES.map((stage) => ({ value: stage, label: STAGE_WORD[stage].label }));

export const needsAttention = (stage: OnboardingStage): boolean => stage === "late" || stage === "tampered";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const count = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? "" : "s"}`;

export const stayWords = (sinceIso: string, now: number = Date.now()): string => {
  const ms = now - Date.parse(sinceIso);
  if (Number.isNaN(ms)) return "unknown";
  if (ms < HOUR) return "under an hour";
  if (ms < DAY) return count(Math.floor(ms / HOUR), "hour");
  return count(Math.floor(ms / DAY), "day");
};

export function StageChip({ stage, since, now, className }: { stage: OnboardingStage; since: string; now?: number; className?: string }) {
  const word = STAGE_WORD[stage];
  const stay = stayWords(since, now);
  return (
    <span data-testid="stage" data-stage={stage} className={cn("inline-flex min-w-0 items-center gap-2", className)} title={`${word.meaning} Since ${absoluteWords(since)}.`}>
      <Pill tone={word.tone} {...(word.dot === undefined ? {} : { dot: word.dot })} {...(word.icon === undefined ? {} : { icon: word.icon })} className={needsAttention(stage) ? "font-[600]" : undefined}>
        {word.label}
      </Pill>
      <span data-testid="stage-stay" className="truncate text-12 tabular-nums text-g-muted">
        <span className="sr-only">for </span>
        {stay}
      </span>
    </span>
  );
}

export function AttentionBar({ late, tampered, onShow }: { late: number; tampered: number; onShow: (stage: "late" | "tampered") => void }) {
  if (late === 0 && tampered === 0) return null;
  const parts: { stage: "late" | "tampered"; words: string }[] = [
    ...(tampered === 0 ? [] : [{ stage: "tampered" as const, words: `${tampered} ${tampered === 1 ? "Mac failed" : "Macs failed"} an integrity check` }]),
    ...(late === 0 ? [] : [{ stage: "late" as const, words: `${late} ${late === 1 ? "Mac has" : "Macs have"} stopped syncing` }]),
  ];
  const bad = tampered > 0;
  return (
    <div
      role="status"
      data-testid="attention"
      className={cn(
        "mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-g-card border px-4 py-3 text-14",
        bad ? "border-g-pill-bad-line bg-g-pill-bad-bg text-g-pill-bad-ink" : "border-g-pill-warn-line bg-g-pill-warn-bg text-g-pill-warn-ink",
      )}
    >
      {bad ? <ShieldAlertIcon aria-hidden className="size-4 shrink-0" /> : <ClockAlertIcon aria-hidden className="size-4 shrink-0" />}
      <span className="min-w-0 flex-1 font-medium">{parts.map((p) => p.words).join(". ")}.</span>
      <span className="flex shrink-0 flex-wrap gap-2">
        {parts.map((p) => (
          <button
            key={p.stage}
            type="button"
            onClick={() => onShow(p.stage)}
            className="focus-knox cursor-pointer rounded-g-control border border-current/30 px-2.5 py-1 text-13 font-medium outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-current/10"
          >
            Show {STAGE_WORD[p.stage].label}
          </button>
        ))}
      </span>
    </div>
  );
}
