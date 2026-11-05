import * as React from "react";
import { motionMs } from "@/shell/useClosingState";

export function useHeld<T>(value: T | null | undefined): { value: T | undefined; open: boolean } {
  const present = value !== null && value !== undefined;
  const [held, setHeld] = React.useState<T | undefined>(present ? value : undefined);
  if (present && !Object.is(held, value)) setHeld(value);
  React.useEffect(() => {
    if (present || held === undefined) return undefined;
    const timer = window.setTimeout(() => setHeld(undefined), motionMs("--g-dur-exit"));
    return () => window.clearTimeout(timer);
  }, [present, held]);
  return { value: present ? value : held, open: present };
}

export function useMountOpen(open: boolean): boolean {
  const [ready, setReady] = React.useState(!open);
  React.useLayoutEffect(() => {
    if (!ready) setReady(true);
  }, [ready]);
  return open && ready;
}

export function focusIsVisible(): boolean {
  const active = typeof document === "undefined" ? null : document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return false;
  try {
    return active.matches(":focus-visible");
  } catch {
    return false;
  }
}
