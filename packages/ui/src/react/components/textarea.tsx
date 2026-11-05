import * as React from "react";
import { cn } from "../lib/cn";
import { fieldEdgeClass, fieldSurfaceClass, type FieldSurface } from "./input";

export type TextareaProps = React.ComponentProps<"textarea"> & {
  invalid?: boolean;
  surface?: FieldSurface;
  mono?: boolean;
};

export function Textarea({ className, invalid, surface, mono = false, ...props }: TextareaProps) {
  return (
    <textarea
      data-slot="textarea"
      aria-invalid={invalid || undefined}
      className={cn(
        "flex min-h-20 w-full min-w-0 rounded-lg",
        fieldSurfaceClass(surface),
        fieldEdgeClass(surface),
        "px-3 py-2 font-normal text-foreground placeholder:text-placeholder",
        mono ? "font-mono text-code" : "text-sm leading-[18px]",
        "focus-field",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
