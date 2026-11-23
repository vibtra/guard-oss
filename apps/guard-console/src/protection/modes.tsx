import { EyeIcon, EyeOffIcon, ShieldCheckIcon, type LucideIcon } from "lucide-react";
import { Pill, type PillTone } from "@/components/kit";
import { MODE_LABEL, type Mode } from "./model";

interface ModeWord {
  label: string;
  icon: LucideIcon;
  tone: PillTone;
  meaning: string;
}

export const MODE_WORD: Readonly<Record<Mode, ModeWord>> = {
  enforce: { label: MODE_LABEL.enforce, icon: ShieldCheckIcon, tone: "neutral", meaning: "Guard blocks or asks as the rules say." },
  monitor: {
    label: MODE_LABEL.monitor,
    icon: EyeIcon,
    tone: "neutral",
    meaning: "Guard records what the rules would block and lets it through. Connections Guard can’t inspect are still blocked unless you allow them under Uninspectable TLS.",
  },
  off: { label: MODE_LABEL.off, icon: EyeOffIcon, tone: "muted", meaning: "Guard does not inspect their AI traffic and records nothing. Their Mac keeps checking in." },
};

export function ModePill({ mode, className }: { mode: Mode; className?: string }) {
  const word = MODE_WORD[mode];
  return (
    <Pill tone={word.tone} icon={word.icon} data-testid="mode-pill" data-mode={mode} className={className}>
      {word.label}
    </Pill>
  );
}
