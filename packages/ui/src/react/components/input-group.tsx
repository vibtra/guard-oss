import * as React from "react";
import { cn } from "../lib/cn";

export function InputGroup({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & { variant?: "default" | "card" }) {
  return (
    <div
      data-slot="input-group"
      data-variant={variant}
      role="group"
      className={cn(
        "group/input-group relative flex w-full items-center",
        "has-[>[data-align=start]]:[&_input]:pl-9 has-[>[data-align=start]]:[&_textarea]:pl-9",
        "has-[>[data-align=end]]:[&_input]:pr-9 has-[>[data-align=end]]:[&_textarea]:pr-9",
        variant === "card" && "[&_input]:h-10 [&_input]:bg-card",
        className,
      )}
      {...props}
    />
  );
}

export function InputGroupAddon({
  className,
  align = "start",
  ...props
}: React.ComponentProps<"div"> & { align?: "start" | "end" }) {
  return (
    <div
      data-slot="input-group-addon"
      data-align={align}
      className={cn(
        "pointer-events-none absolute inset-y-0 z-1 flex items-center gap-1 text-muted-foreground",
        "[&_svg:not([class*='size-'])]:size-4",
        "[&_button]:pointer-events-auto [&_a]:pointer-events-auto",
        align === "start" ? "left-3" : "right-1",
        className,
      )}
      {...props}
    />
  );
}
