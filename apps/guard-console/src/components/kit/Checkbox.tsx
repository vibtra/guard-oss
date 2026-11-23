import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export function checkboxBoxClass(checked: boolean, className?: string): string {
  return cn(
    "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-[background-color,border-color] duration-(--g-dur-fast) ease-g",
    checked ? "border-g-ink bg-g-ink text-g-on-solid" : "border-g-line-control bg-g-surface text-g-on-solid",
    className,
  );
}

export function CheckboxTick({ checked }: { checked: boolean }) {
  return <CheckIcon aria-hidden strokeWidth={3} className={cn("size-3 transition-opacity duration-(--g-dur-fast) ease-g", checked ? "opacity-100" : "opacity-0")} />;
}

export function Checkbox({
  checked,
  indeterminate = false,
  onCheckedChange,
  disabled,
  id,
  name,
  value,
  className,
  ...aria
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  name?: string;
  value?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  className?: string;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      indeterminate={indeterminate}
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      {...(id === undefined ? {} : { id })}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...aria}
      data-slot="checkbox"
      className={cn(
        checkboxBoxClass(checked || indeterminate),
        "focus-knox relative cursor-pointer outline-hidden",
        "before:absolute before:-inset-1 before:content-['']",
        "data-disabled:cursor-not-allowed data-disabled:opacity-60",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator keepMounted className="flex">
        {indeterminate ? <MinusIcon aria-hidden strokeWidth={3} className="size-3" /> : <CheckboxTick checked={checked} />}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
