import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const alert = cva(
  [
    "flex w-full items-start gap-2 rounded-lg border text-sm shadow-xs",
    "[&_code]:font-mono [&_code]:text-code",
    "[&_[data-slot=alert-icon]]:shrink-0 [&_[data-slot=alert-icon]]:h-5",
    "[&_[data-slot=alert-description]]:text-inherit",
  ],
  {
    variants: {
      tone: {
        info: "border-info-line bg-info-bg text-info-ink",
        ok: "border-ok-line bg-ok-bg text-ok-ink",
        warn: "border-warn-line bg-warn-bg text-warn-ink",
        danger: "border-danger-line bg-danger-bg text-danger-ink",
        neutral: "border-border bg-muted text-foreground shadow-none",
      },
      shape: {
        default: "",
        banner: "min-h-10 items-center",
      },
      pad: {
        default: "px-3 py-2",
        lg: "px-3 py-4",
      },
    },
    defaultVariants: { tone: "info", shape: "default", pad: "default" },
  },
);

export type AlertTone = NonNullable<VariantProps<typeof alert>["tone"]>;

export function Alert({
  className,
  tone,
  shape,
  pad,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alert>) {
  return (
    <div
      data-slot="alert"
      data-shape={shape ?? "default"}
      data-pad={pad ?? "default"}
      role="status"
      className={cn(alert({ tone, shape, pad }), className)}
      {...props}
    />
  );
}

export function AlertActions({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="alert-actions" className={cn("ml-auto flex shrink-0 items-center gap-2 self-center", className)} {...props} />;
}

export function AlertIcon({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="alert-icon"
      aria-hidden
      className={cn("flex items-center [&_svg:not([class*='size-'])]:size-4", className)}
      {...props}
    />
  );
}

export function AlertTitle({ className, ...props }: React.ComponentProps<"p">) {
  return <p data-slot="alert-title" className={cn("text-sm font-medium", className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn("text-sm", className)}
      {...props}
    />
  );
}

export { alert as alertVariants };
