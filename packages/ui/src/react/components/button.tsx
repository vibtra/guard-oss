import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const button = cva(
  [
    "inline-flex items-center justify-center gap-2 shrink-0 whitespace-nowrap select-none",
    "rounded-lg border border-transparent",
    "font-medium",
    "transition-[background-color,border-color,color,opacity,scale] duration-(--v-dur-2) ease-out",
    "focus-knox",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  ],
  {
    variants: {
      size: {
        sm: "h-(--v-control-h-sm) px-3 py-2 text-sm",
        md: "h-(--v-control-h) px-4 py-2 text-sm",
        lg: "h-(--v-control-h) px-5 py-2 text-sm",
        icon: "size-(--v-control-h-sm) rounded-md p-1 text-sm",
        "icon-sm": "size-(--v-control-h-xs) rounded-md p-0 text-sm [&_svg:not([class*='size-'])]:size-3.5",
      },
      variant: {
        solid:
          "bg-primary text-primary-foreground hover:bg-accent-solid-hover active:bg-accent-solid-pressed data-test-hover:bg-accent-solid-hover",
        neutral:
          "border-border bg-card text-foreground hover:bg-accent active:bg-pressed aria-expanded:bg-accent data-test-hover:bg-accent",
        quiet:
          "bg-secondary text-foreground hover:bg-accent active:bg-pressed aria-expanded:bg-accent data-test-hover:bg-accent",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-foreground active:bg-pressed aria-expanded:bg-accent data-test-hover:bg-accent",
        danger:
          "border-destructive bg-card text-danger-ink hover:bg-critical-hover active:bg-critical-pressed data-test-hover:bg-critical-hover",
        critical:
          "bg-danger-solid text-on-brand hover:opacity-90 active:opacity-80 data-test-hover:opacity-90",
        link: "h-auto rounded-none p-0 text-link underline-offset-4 hover:underline data-test-hover:underline",
        inverse:
          "bg-contrast text-contrast hover:opacity-90 active:opacity-80 data-test-hover:opacity-90",
      },
      press: {
        true: "motion-safe:not-disabled:not-aria-disabled:active:scale-(--v-press-scale)",
        false: "",
      },
    },
    defaultVariants: { variant: "neutral", size: "md", press: false },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof button> & {
    asChild?: boolean;
    loading?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  press,
  asChild = false,
  loading = false,
  children,
  disabled,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      aria-busy={loading || undefined}
      disabled={disabled ?? (loading || undefined)}
      className={cn(button({ variant, size, press: press ?? variant !== "link" }), loading && "relative", className)}
      {...props}
    >
      {loading ? (
        <>
          <span className="inline-flex items-center gap-1 opacity-0">{children}</span>
          <span
            aria-hidden
            className="absolute size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent"
          />
        </>
      ) : (
        children
      )}
    </Comp>
  );
}

export { button as buttonVariants };
