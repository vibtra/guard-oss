import * as React from "react";

export function parseDurationMs(raw: string, fallback = 150): number {
  const value = raw.trim();
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  if (value.endsWith("ms")) return n;
  if (value.endsWith("s")) return n * 1000;
  return fallback;
}

export function motionMs(token: string, element?: Element | null, fallback = 150): number {
  if (typeof window === "undefined" || typeof getComputedStyle !== "function") return fallback;
  const target = element ?? document.documentElement;
  if (target === null) return fallback;
  return parseDurationMs(getComputedStyle(target).getPropertyValue(token), fallback);
}

export function dialogExitMs(): number {
  return motionMs("--v-motion-ui");
}
export const DIALOG_EXIT_MS = 150;

export function useClosingState<T>() {
  const [held, setHeld] = React.useState<{ value: T; open: boolean } | undefined>(undefined);
  React.useEffect(() => {
    if (held === undefined || held.open) return undefined;
    const timer = window.setTimeout(() => setHeld((now) => (now === held ? undefined : now)), dialogExitMs());
    return () => window.clearTimeout(timer);
  }, [held]);
  const show = React.useCallback((value: T) => setHeld({ value, open: true }), []);
  const close = React.useCallback(() => setHeld((now) => (now === undefined || !now.open ? now : { ...now, open: false })), []);
  return { value: held?.value, open: held?.open ?? false, closing: held !== undefined && !held.open, show, close };
}
