import * as React from "react";
import { cn } from "../lib/cn";
import { WorkingAvatar } from "./working-avatar";

export function FollowPill({
  name,
  onStop,
  label = "Following",
  stopLabel = "Stop",
  stopAriaLabel = "Stop following",
  avatar,
  floating = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  name: React.ReactNode;
  onStop: () => void;
  label?: React.ReactNode;
  stopLabel?: string;
  stopAriaLabel?: string;
  avatar?: React.ReactNode;
  floating?: boolean;
}) {
  return (
    <div
      data-slot="follow-pill"
      role="status"
      className={cn(
        "v-drop-in inline-flex h-9 items-center gap-2 rounded-xl bg-card py-1 pr-1 pl-2 shadow-medium hairline",
        floating && "absolute top-2 left-1/2 z-(--v-z-peek) -translate-x-1/2",
        className,
      )}
      {...props}
    >
      {avatar ?? <WorkingAvatar size={20} />}
      <span className="text-sm leading-4 font-medium tracking-h-xs whitespace-nowrap text-foreground">
        {label} {name}
      </span>
      <span aria-hidden className="h-4 w-px bg-border" />
      <button
        type="button"
        data-slot="follow-pill-stop"
        aria-label={stopAriaLabel}
        onClick={onStop}
        className="v-hover-tint focus-knox inline-flex h-7 items-center rounded-lg bg-accent px-2 text-xs leading-3 font-medium tracking-h-xs text-foreground outline-hidden"
      >
        {stopLabel}
      </button>
    </div>
  );
}
