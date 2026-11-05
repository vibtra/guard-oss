import * as React from "react";
import { cn } from "../lib/cn";

export function Kbd({ className, ...props }: React.ComponentProps<"kbd">) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-border bg-card px-1",
        "font-mono text-xs font-normal text-muted-foreground not-italic",
        "[&_svg]:size-3",
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="kbd-group"
      className={cn("inline-flex items-center gap-1 font-mono text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function KbdHint({
  label,
  keys,
  onClick,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  label: React.ReactNode;
  keys: readonly React.ReactNode[];
}) {
  const body = (
    <>
      <span>{label}</span>
      {keys.map((key, i) => (
        <Kbd key={i}>{key}</Kbd>
      ))}
    </>
  );
  const shape = cn(
    "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-tag leading-3 font-medium tracking-h-xs text-muted-foreground",
    className,
  );
  if (onClick === undefined) {
    return (
      <span data-slot="kbd-hint" className={shape}>
        {body}
      </span>
    );
  }
  return (
    <button type="button" data-slot="kbd-hint" onClick={onClick} className={cn(shape, "v-hover-tint focus-knox outline-hidden")} {...props}>
      {body}
    </button>
  );
}
