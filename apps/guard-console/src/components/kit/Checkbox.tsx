import * as React from "react";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { CheckIcon, MinusIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

const stillBoxClass = (checked: boolean): string =>
  cn("flex size-4 shrink-0 items-center justify-center rounded-[4px] border", checked ? "border-g-ink bg-g-ink text-g-on-solid" : "border-g-line-control bg-g-surface text-g-on-solid");

export function checkboxBoxClass(checked: boolean, className?: string): string {
  return cn(stillBoxClass(checked), "transition-[background-color,border-color] duration-(--g-dur-fast) ease-g", className);
}

export function CheckboxTick({ checked }: { checked: boolean }) {
  return <CheckIcon aria-hidden strokeWidth={3} className={cn("size-3 transition-opacity duration-(--g-dur-fast) ease-g", checked ? "opacity-100" : "opacity-0")} />;
}

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  id,
  name,
  value,
  className,
  ...aria
}: {
  checked: boolean;
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
      onCheckedChange={(next) => onCheckedChange(next)}
      disabled={disabled}
      {...(id === undefined ? {} : { id })}
      {...(name === undefined ? {} : { name })}
      {...(value === undefined ? {} : { value })}
      {...aria}
      data-slot="checkbox"
      className={cn(
        checkboxBoxClass(checked),
        "focus-knox relative cursor-pointer outline-hidden",
        "before:absolute before:-inset-1 before:content-['']",
        "data-disabled:cursor-not-allowed data-disabled:opacity-60",
        className,
      )}
    >
      <CheckboxPrimitive.Indicator keepMounted className="flex">
        <CheckboxTick checked={checked} />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function CheckboxButton({
  checked,
  indeterminate = false,
  onCheckedChange,
  disabled,
  ...aria
}: {
  checked: boolean;
  indeterminate?: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  "aria-label": string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      disabled={disabled}
      onClick={() => onCheckedChange(indeterminate || !checked)}
      {...aria}
      data-slot="checkbox"
      className={cn(
        stillBoxClass(checked || indeterminate),
        "focus-knox relative cursor-pointer outline-hidden",
        "before:absolute before:-inset-1 before:content-['']",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {indeterminate ? <MinusIcon aria-hidden strokeWidth={3} className="size-3" /> : <CheckIcon aria-hidden strokeWidth={3} className={cn("size-3", checked ? "opacity-100" : "opacity-0")} />}
    </button>
  );
}
