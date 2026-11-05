import * as React from "react";
import { cn } from "../lib/cn";

export function SuggestionCard({
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-slot="suggestion-card"
      className={cn(
        "focus-knox flex h-14 w-60 min-w-0 items-center gap-3 rounded-xl bg-card px-4 py-3 text-left shadow-low outline-hidden",
        "text-sm tracking-body-sm text-foreground transition-colors duration-(--v-dur-1) hover:bg-muted",
        "[&_strong]:font-medium [&_svg]:size-4 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="line-clamp-2 min-w-0">{children}</span>
    </button>
  );
}

export function SuggestionGrid({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="suggestion-grid" className={cn("grid grid-cols-2 justify-center gap-2", className)} {...props} />;
}

export function Greeting({
  icon,
  title,
  lede,
  className,
}: {
  icon: React.ReactNode;
  title: string;
  lede?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="greeting" className={cn("flex flex-col items-center text-center", className)}>
      <span aria-hidden className="mb-4 inline-flex text-hue-green-600 [&_svg]:size-9">
        {icon}
      </span>
      <h2 className="text-title font-semibold tracking-h-sm text-foreground">{title}</h2>
      {lede === undefined ? null : (
        <p className="mt-1 w-90 max-w-full text-sm tracking-body-sm text-muted-foreground">{lede}</p>
      )}
    </div>
  );
}
