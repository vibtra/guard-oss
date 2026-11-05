import * as React from "react";
import { cn } from "../lib/cn";

export type SegmentedVariant = "default" | "icon" | "floating" | "text";

export interface SegmentedOption<V extends string> {
  value: V;
  label: string;
  icon?: React.ReactNode;
}

export function Segmented<V extends string>({
  options,
  value,
  onValueChange,
  label,
  variant = "default",
  showLabels = false,
  className,
}: {
  options: readonly SegmentedOption<V>[];
  value: V;
  onValueChange: (value: V) => void;
  label: string;
  variant?: SegmentedVariant;
  showLabels?: boolean;
  className?: string;
}) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);
  const iconOnly = variant === "icon" || variant === "floating" || !showLabels;
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  const move = (step: number) => {
    const next = (index + step + options.length) % options.length;
    const option = options[next];
    if (option === undefined) return;
    onValueChange(option.value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      data-slot="segmented"
      data-variant={variant}
      className={cn(
        variant === "floating"
          ? "inline-flex h-(--v-control-h) items-center gap-0.5 rounded-full bg-card p-1 shadow-low"
          : "inline-flex items-center gap-0.5 rounded-lg border border-transparent bg-muted p-[3px]",
        className,
      )}
    >
      {options.map((option, i) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              refs.current[i] = node;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={option.icon !== undefined && iconOnly ? option.label : undefined}
            tabIndex={on ? 0 : -1}
            data-state={on ? "on" : "off"}
            title={option.label}
            onClick={() => onValueChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                event.preventDefault();
                move(1);
              } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                event.preventDefault();
                move(-1);
              }
            }}
            className={cn(
              "focus-knox inline-flex items-center justify-center gap-1.5 outline-hidden",
              "text-sm font-normal transition-colors duration-(--v-dur-2)",
              "[&_svg]:shrink-0",
              variant === "floating"
                ? "size-6 rounded-full [&_svg]:size-3"
                : cn(
                    "h-7 rounded-md px-1.5 py-1 [&_svg]:size-4",
                    variant === "text" ? "min-w-16" : variant === "icon" ? "w-7" : "min-w-7",
                  ),
              variant === "floating"
                ? on
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground"
                : on
                  ? "bg-card text-foreground shadow-segment"
                  : "text-secondary-foreground hover:text-foreground",
            )}
          >
            {iconOnly || option.icon === undefined ? (option.icon ?? option.label) : (
              <>
                {option.icon}
                {option.label}
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}
