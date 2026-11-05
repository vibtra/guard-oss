export const HUES = ["green", "red", "sky", "yellow", "orange", "teal", "purple", "pink"] as const;
export type Hue = (typeof HUES)[number];
export type SeriesHue = Hue | "gray";

export const HUE_SOLID: Record<SeriesHue, string> = {
  green: "bg-hue-green-600",
  red: "bg-hue-red-600",
  sky: "bg-hue-sky-600",
  yellow: "bg-hue-yellow-600",
  orange: "bg-hue-orange-600",
  teal: "bg-hue-teal-600",
  purple: "bg-hue-purple-600",
  pink: "bg-hue-pink-600",
  gray: "bg-(--v-gray-600)",
};

export const HUE_FILL: Record<SeriesHue, string> = {
  green: "fill-hue-green-600",
  red: "fill-hue-red-600",
  sky: "fill-hue-sky-600",
  yellow: "fill-hue-yellow-600",
  orange: "fill-hue-orange-600",
  teal: "fill-hue-teal-600",
  purple: "fill-hue-purple-600",
  pink: "fill-hue-pink-600",
  gray: "fill-(--v-gray-600)",
};

export const HUE_STROKE: Record<SeriesHue, string> = {
  green: "stroke-hue-green-600",
  red: "stroke-hue-red-600",
  sky: "stroke-hue-sky-600",
  yellow: "stroke-hue-yellow-600",
  orange: "stroke-hue-orange-600",
  teal: "stroke-hue-teal-600",
  purple: "stroke-hue-purple-600",
  pink: "stroke-hue-pink-600",
  gray: "stroke-(--v-gray-600)",
};

export const HUE_400: Record<SeriesHue, string> = {
  green: "bg-hue-green-400",
  red: "bg-hue-red-400",
  sky: "bg-hue-sky-400",
  yellow: "bg-hue-yellow-400",
  orange: "bg-hue-orange-400",
  teal: "bg-hue-teal-400",
  purple: "bg-hue-purple-400",
  pink: "bg-hue-pink-400",
  gray: "bg-secondary",
};

export const HUE_CARD: Record<SeriesHue, string> = {
  green: "bg-hue-green-200 text-hue-green-1000",
  red: "bg-hue-red-200 text-hue-red-1000",
  sky: "bg-hue-sky-200 text-hue-sky-1000",
  yellow: "bg-hue-yellow-200 text-hue-yellow-1000",
  orange: "bg-hue-orange-200 text-hue-orange-1000",
  teal: "bg-hue-teal-200 text-hue-teal-1000",
  purple: "bg-hue-purple-200 text-hue-purple-1000",
  pink: "bg-hue-pink-200 text-hue-pink-1000",
  gray: "bg-accent text-foreground",
};

export const HUE_CARD_SELECTED: Record<SeriesHue, string> = {
  green: "bg-hue-green-400 text-hue-green-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-green-600)]",
  red: "bg-hue-red-400 text-hue-red-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-red-600)]",
  sky: "bg-hue-sky-400 text-hue-sky-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-sky-600)]",
  yellow: "bg-hue-yellow-400 text-hue-yellow-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-yellow-600)]",
  orange: "bg-hue-orange-400 text-hue-orange-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-orange-600)]",
  teal: "bg-hue-teal-400 text-hue-teal-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-teal-600)]",
  purple: "bg-hue-purple-400 text-hue-purple-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-purple-600)]",
  pink: "bg-hue-pink-400 text-hue-pink-1000 shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--v-hue-pink-600)]",
  gray: "bg-secondary text-foreground shadow-[0_0_0_3px_var(--card),inset_0_0_0_1px_var(--border)]",
};

export const HUE_COUNTER: Record<SeriesHue, string> = {
  green: "bg-hue-green-400 text-hue-green-1000",
  red: "bg-hue-red-400 text-hue-red-1000",
  sky: "bg-hue-sky-400 text-hue-sky-1000",
  yellow: "bg-hue-yellow-400 text-hue-yellow-1000",
  orange: "bg-hue-orange-400 text-hue-orange-1000",
  teal: "bg-hue-teal-400 text-hue-teal-1000",
  purple: "bg-hue-purple-400 text-hue-purple-1000",
  pink: "bg-hue-pink-400 text-hue-pink-1000",
  gray: "bg-secondary text-foreground",
};

export const HUE_COUNTER_SELECTED: Record<SeriesHue, string> = {
  green: "bg-hue-green-600 text-tooltip-ink",
  red: "bg-hue-red-600 text-tooltip-ink",
  sky: "bg-hue-sky-600 text-tooltip-ink",
  yellow: "bg-hue-yellow-600 text-tooltip-ink",
  orange: "bg-hue-orange-600 text-tooltip-ink",
  teal: "bg-hue-teal-600 text-tooltip-ink",
  purple: "bg-hue-purple-600 text-tooltip-ink",
  pink: "bg-hue-pink-600 text-tooltip-ink",
  gray: "bg-(--v-gray-600) text-tooltip-ink",
};

export const HUE_TEXT: Record<SeriesHue, string> = {
  green: "text-hue-green-600",
  red: "text-hue-red-600",
  sky: "text-hue-sky-600",
  yellow: "text-hue-yellow-600",
  orange: "text-hue-orange-600",
  teal: "text-hue-teal-600",
  purple: "text-hue-purple-600",
  pink: "text-hue-pink-600",
  gray: "text-muted-foreground",
};

export const STEP_HUES: readonly Hue[] = ["orange", "teal", "pink", "sky", "purple", "yellow", "green", "red"];

export function stepHue(index: number): Hue {
  const n = STEP_HUES.length;
  const i = ((Math.trunc(index) % n) + n) % n;
  return STEP_HUES[i] as Hue;
}

export type HueStep = 200 | 400 | 600 | 800 | 1000;

export function hueVar(hue: SeriesHue, step: HueStep = 600): string {
  if (hue === "gray") {
    if (step === 200) return "var(--accent)";
    if (step === 400) return "var(--secondary)";
    if (step === 1000 || step === 800) return "var(--foreground)";
    return "var(--v-gray-600)";
  }
  return `var(--v-hue-${hue}-${step})`;
}

export const HUE_BORDER: Record<SeriesHue, string> = {
  green: "border-hue-green-600",
  red: "border-hue-red-600",
  sky: "border-hue-sky-600",
  yellow: "border-hue-yellow-600",
  orange: "border-hue-orange-600",
  teal: "border-hue-teal-600",
  purple: "border-hue-purple-600",
  pink: "border-hue-pink-600",
  gray: "border-(--v-gray-600)",
};
