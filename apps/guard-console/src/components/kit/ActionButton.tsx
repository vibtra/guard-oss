import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export type ActionButtonVariant = "primary" | "secondary" | "danger" | "ghost";

const VARIANT: Readonly<Record<ActionButtonVariant, string>> = {
  primary: "border-transparent bg-g-ink text-g-on-solid hover:opacity-90 active:opacity-85",
  secondary: "border-g-line bg-g-surface text-g-ink hover:bg-g-hover active:bg-g-pressed",
  danger: "border-g-line bg-g-surface text-g-danger hover:border-g-pill-bad-line active:bg-g-danger-pressed",
  ghost: "border-transparent bg-transparent text-g-ink hover:bg-g-tint active:bg-g-pressed",
};

export function actionButtonClass(variant: ActionButtonVariant = "secondary", className?: string, pressable = true): string {
  return cn(
    "focus-knox inline-flex h-8 shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-g-control border px-3 text-14 font-medium whitespace-nowrap outline-hidden",
    "transition-[background-color,border-color,opacity,color,scale] duration-(--g-dur) ease-g",
    pressable && "motion-safe:not-disabled:not-aria-disabled:active:scale-[.96]",
    "disabled:pointer-events-none disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60",
    "[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
    VARIANT[variant],
    className,
  );
}

export function ActionButton({
  variant = "secondary",
  icon: Icon,
  loading = false,
  static: still = false,
  className,
  children,
  disabled,
  type = "button",
  onClick,
  "aria-disabled": ariaDisabled,
  ...props
}: React.ComponentProps<"button"> & {
  variant?: ActionButtonVariant;
  icon?: LucideIcon;
  loading?: boolean;
  static?: boolean;
}) {
  const inert = loading || ariaDisabled === true || ariaDisabled === "true";
  return (
    <button
      type={type}
      data-slot="action-button"
      data-variant={variant}
      aria-busy={loading || undefined}
      aria-disabled={inert || undefined}
      disabled={disabled}
      onClick={(event) => {
        if (inert) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
      className={cn(actionButtonClass(variant, className, !still && !loading), loading && "relative")}
      {...props}
    >
      <span className={cn("inline-flex items-center gap-1.5", loading && "opacity-0")}>
        {Icon === undefined ? null : <Icon aria-hidden />}
        {children}
      </span>
      {loading ? <span aria-hidden className="absolute size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" /> : null}
    </button>
  );
}
