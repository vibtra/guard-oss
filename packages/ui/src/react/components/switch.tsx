import * as React from "react";
import { cn } from "../lib/cn";

export type SwitchProps = Omit<
  React.ComponentProps<"button">,
  "onChange" | "defaultChecked" | "type" | "role" | "value"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

export function Switch({
  className,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  onClick,
  ...props
}: SwitchProps) {
  const [own, setOwn] = React.useState(defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : own;

  return (
    <button
      type="button"
      role="switch"
      data-slot="switch"
      aria-checked={on}
      data-state={on ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        if (!isControlled) setOwn(!on);
        onCheckedChange?.(!on);
      }}
      className={cn(
        "focus-knox inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0",
        "bg-switch-off transition-colors duration-(--v-dur-2)",
        "data-[state=checked]:bg-switch-on",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block size-5 rounded-full border border-switch-off bg-white shadow-xs",
          "translate-x-0 transition-transform duration-(--v-dur-2)",
          on && "translate-x-4 border-switch-on",
        )}
      />
    </button>
  );
}
