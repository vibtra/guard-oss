import * as React from "react";
import { cn } from "../lib/cn";

export type FieldSurface = "default" | "ground";

export function fieldSurfaceClass(surface: FieldSurface | undefined): string {
  return surface === "ground" ? "bg-input-on-ground" : "bg-(--v-field-fill)";
}

export function fieldEdgeClass(surface: FieldSurface | undefined): string {
  return surface === "ground" ? "border border-input" : "border-solid border-(length:--v-field-edge-w) border-input";
}

export type InputProps = Omit<React.ComponentProps<"input">, "size"> & {
  invalid?: boolean;
  surface?: FieldSurface;
  size?: "md" | "sm";
};

export function Input({ className, invalid, type, surface, size = "md", ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      aria-invalid={invalid || undefined}
      className={cn(
        "flex w-full min-w-0 rounded-lg",
        size === "sm" ? "h-(--v-control-h-sm)" : "h-(--v-control-h)",
        fieldSurfaceClass(surface),
        fieldEdgeClass(surface),
        "px-3 py-2 text-sm font-normal text-foreground placeholder:text-placeholder",
        "focus-field",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:h-full file:border-0 file:bg-transparent file:text-xs file:text-foreground",
        "aria-invalid:border-destructive",
        className,
      )}
      {...props}
    />
  );
}
