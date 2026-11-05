import * as React from "react";
import { cn } from "../lib/cn";
import { hueVar } from "../lib/hue";
import { useReducedMotion } from "./shimmer-text";

function VibtraFace({ blink }: { blink: boolean }) {
  return (
    <svg viewBox="0 0 20 20" className="block size-full" aria-hidden>
      <circle cx="10" cy="10" r="10" fill="var(--foreground)" />
      <g className={cn(blink && "v-blink")} style={{ transformBox: "fill-box", transformOrigin: "center" }}>
        <rect x="5.5" y="7.5" width="3" height="5" rx="1.5" fill="var(--v-accent)" />
        <rect x="11.5" y="7.5" width="3" height="5" rx="1.5" fill="var(--v-accent)" />
      </g>
    </svg>
  );
}

export function WorkingAvatar({
  working = false,
  face,
  ringColors,
  size = 20,
  label,
  className,
  style,
  ...props
}: Omit<React.ComponentProps<"span">, "children"> & {
  working?: boolean;
  face?: React.ReactNode;
  ringColors?: readonly [string, string];
  size?: number;
  label?: string;
}) {
  const reduced = useReducedMotion();
  const [a, b] = ringColors ?? [hueVar("orange"), hueVar("teal")];
  return (
    <span
      data-slot="working-avatar"
      data-working={working || undefined}
      data-motion={reduced ? "reduced" : "full"}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("relative inline-block shrink-0 rounded-full", className)}
      style={{ width: size, height: size, ...style }}
      {...props}
    >
      {working ? (
        <span aria-hidden className="absolute inset-0 overflow-hidden rounded-full">
          <span
            data-slot="working-ring"
            className={cn(
              "absolute top-1/2 left-1/2 size-[150%] bg-(image:--v-ring-gradient)",
              reduced ? "-translate-1/2" : "v-spin-ring",
            )}
            style={{ "--v-ring-gradient": `conic-gradient(from 0deg, ${a}, ${b}, ${a})` } as React.CSSProperties}
          />
        </span>
      ) : null}
      <span
        className={cn(
          "absolute overflow-hidden rounded-full",
          working ? "inset-[2px] shadow-[0_0_0_1px_var(--card)]" : "inset-0",
        )}
      >
        {face === undefined ? (
          <VibtraFace blink={!reduced} />
        ) : (
          <span className="block size-full [&>*]:size-full">{face}</span>
        )}
      </span>
    </span>
  );
}
