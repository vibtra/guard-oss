import type * as React from "react";
import { cn } from "@/lib/utils";

import { VIBTRA_MARK_PATH, VIBTRA_MARK_VIEWBOX } from "./marks";


export function VibtraMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox={VIBTRA_MARK_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
    >
      <path d={VIBTRA_MARK_PATH} fill="currentColor" />
    </svg>
  );
}

export function VibtraWordmark({ className }: { className?: string }) {
  return (
    <span data-slot="vibtra-wordmark" className={cn("inline-flex items-center gap-2 text-foreground", className)}>
      <VibtraMark className="size-4.5 shrink-0" />
      <span className="font-brand text-md font-semibold tracking-h-md">Vibtra</span>
      <span data-slot="wordmark-sub" className="text-md font-medium text-muted-foreground">
        Guard
      </span>
    </span>
  );
}
export function VibtraMarkOutline({ className, strokeWidth = 1.5 }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox={VIBTRA_MARK_VIEWBOX}
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={cn("overflow-visible", className)}
    >
      <path
        d={VIBTRA_MARK_PATH}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
