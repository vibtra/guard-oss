import * as React from "react";
import { cn } from "../lib/cn";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

function readReduced(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(REDUCED_QUERY).matches;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(readReduced);
  React.useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setReduced(mq.matches);
    onChange();
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onChange);
      return () => mq.removeEventListener("change", onChange);
    }
    return undefined;
  }, []);
  return reduced;
}

export function ShimmerText({
  active = true,
  className,
  ...props
}: React.ComponentProps<"span"> & {
  active?: boolean;
}) {
  const reduced = useReducedMotion();
  const on = active && !reduced;
  return (
    <span
      data-slot="shimmer-text"
      data-shimmer={on || undefined}
      className={cn("text-muted-foreground", on && "v-shimmer-text", className)}
      {...props}
    />
  );
}
