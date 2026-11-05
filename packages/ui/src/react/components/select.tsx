import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type SelectProps = Omit<React.ComponentProps<"select">, "size"> & {
  wrapperClassName?: string;
  variant?: "default" | "chip";
  size?: "md" | "sm";
  icon?: React.ReactNode;
};

export function Select({
  className,
  wrapperClassName,
  variant = "default",
  size = "md",
  icon,
  children,
  ...props
}: SelectProps) {
  const chip = variant === "chip";
  return (
    <span
      data-slot="select"
      className={cn("relative inline-flex items-center", chip ? "w-auto" : "w-full", wrapperClassName)}
    >
      {icon === undefined ? null : (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute flex items-center text-muted-foreground [&_svg]:shrink-0",
            chip ? "left-2 [&_svg]:size-3" : "left-3 [&_svg]:size-4",
          )}
        >
          {icon}
        </span>
      )}
      <select
        data-slot="select-trigger"
        data-variant={variant}
        className={cn(
          chip ? "focus-knox" : "focus-field",
          "w-full appearance-none text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50",
          chip
            ? "h-(--v-tag-h) rounded-full border-0 bg-muted pr-[22px] pl-2 text-xs font-medium text-secondary-foreground transition-colors duration-(--v-dur-2) hover:bg-accent"
            : cn(
                "rounded-lg border border-input bg-card pr-9 pl-3 text-sm",
                size === "sm" ? "h-(--v-control-h-sm)" : "h-(--v-control-h)",
              ),
          icon !== undefined && (chip ? "pl-[22px]" : "pl-9"),
          "aria-invalid:border-destructive",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon
        aria-hidden
        className={cn(
          "pointer-events-none absolute text-muted-foreground",
          chip ? "right-2 size-3" : "right-3 size-4",
        )}
      />
    </span>
  );
}

export function SelectOption(props: React.ComponentProps<"option">) {
  return <option data-slot="select-option" {...props} />;
}
