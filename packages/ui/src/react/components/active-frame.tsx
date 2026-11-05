import * as React from "react";
import { cn } from "../lib/cn";
import { hueVar, type SeriesHue } from "../lib/hue";
import { useReducedMotion } from "./shimmer-text";

export function ActiveFrame({
  active = false,
  hue = "orange",
  hues,
  animated = true,
  radius = 12,
  className,
  children,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  active?: boolean;
  hue?: SeriesHue;
  hues?: readonly SeriesHue[];
  animated?: boolean;
  radius?: number;
}) {
  const reduced = useReducedMotion();
  const gradient = hues !== undefined && hues.length >= 2;
  const stops = gradient ? [...hues, hues[0] as SeriesHue].map((h) => hueVar(h)).join(", ") : "";
  return (
    <div
      data-slot="active-frame"
      data-active={active || undefined}
      className={cn("relative isolate overflow-hidden p-[2px]", className)}
      style={{ borderRadius: radius, ...style }}
      {...props}
    >
      {active ? (
        gradient ? (
          <span aria-hidden className="absolute inset-0 -z-10 overflow-hidden" style={{ borderRadius: radius }}>
            <span
              data-slot="active-frame-gradient"
              className={cn(
                "absolute top-1/2 left-1/2 aspect-square w-[150%] bg-(image:--v-frame-gradient)",
                animated && !reduced ? "v-spin-ring-slow" : "-translate-1/2",
              )}
              style={{ "--v-frame-gradient": `conic-gradient(from 0deg, ${stops})` } as React.CSSProperties}
            />
          </span>
        ) : (
          <span
            aria-hidden
            className="absolute inset-0 -z-10"
            style={{ borderRadius: radius, backgroundColor: hueVar(hue) }}
          />
        )
      ) : (
        <span aria-hidden className="absolute inset-[1.5px] -z-10 hairline" style={{ borderRadius: radius - 1.5 }} />
      )}
      <div className="relative size-full overflow-hidden bg-card" style={{ borderRadius: radius - 2 }}>
        {children}
      </div>
    </div>
  );
}
