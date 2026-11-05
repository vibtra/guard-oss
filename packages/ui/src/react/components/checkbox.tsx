import * as React from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type CheckboxProps = Omit<
  React.ComponentProps<"button">,
  "onChange" | "defaultChecked" | "type" | "role" | "value"
> & {
  checked?: boolean;
  defaultChecked?: boolean;
  onCheckedChange?: (checked: boolean) => void;
};

export function Checkbox({
  className,
  checked,
  defaultChecked = false,
  onCheckedChange,
  disabled,
  onClick,
  ...props
}: CheckboxProps) {
  const [own, setOwn] = React.useState(defaultChecked);
  const isControlled = checked !== undefined;
  const on = isControlled ? checked : own;

  return (
    <button
      type="button"
      role="checkbox"
      data-slot="checkbox"
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
        "focus-knox inline-flex size-4 shrink-0 cursor-pointer items-center justify-center",
        "rounded-sm border border-input bg-card transition-colors duration-(--v-dur-2)",
        "data-[state=checked]:border-brand-blue data-[state=checked]:bg-brand-blue",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {on ? <CheckIcon aria-hidden strokeWidth={3} className="size-3 text-white" /> : null}
    </button>
  );
}
