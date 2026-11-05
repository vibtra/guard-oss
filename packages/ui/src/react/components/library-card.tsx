import * as React from "react";
import { cn } from "../lib/cn";

export function LibraryCard({
  mark,
  name,
  description,
  chips,
  aside,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "name"> & {
  mark: React.ReactNode;
  name: string;
  description?: string;
  chips?: readonly string[];
  aside?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-slot="library-card"
      className={cn(
        "focus-knox flex min-h-[98px] w-full min-w-0 flex-col items-stretch gap-2 rounded-xl border border-border bg-card p-4 text-left outline-hidden",
        "transition-colors duration-(--v-dur-1) hover:bg-accent",
        className,
      )}
      {...props}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span
          aria-hidden
          className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-info-bg text-brand-blue [&_svg]:size-4 [&_img]:size-4"
        >
          {mark}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs font-semibold text-foreground">{name}</span>
        {aside === undefined ? null : <span className="ml-auto flex shrink-0">{aside}</span>}
      </span>
      {description === undefined ? null : (
        <span className="line-clamp-2 text-xs text-muted-foreground">{description}</span>
      )}
      {chips === undefined || chips.length === 0 ? null : (
        <span className="mt-auto flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip}
              className="inline-flex h-[22px] items-center rounded-md border border-border px-2 text-tag text-muted-foreground"
            >
              {chip}
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

export function LibraryGrid({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="library-grid"
      className={cn("grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3", className)}
      {...props}
    />
  );
}

export function LibraryDivider({ className, children, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="library-divider"
      role="separator"
      className={cn("my-4 flex items-center gap-3 text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}
      {...props}
    >
      <span aria-hidden className="h-px flex-1 bg-border" />
      <span>{children}</span>
      <span aria-hidden className="h-px flex-1 bg-border" />
    </div>
  );
}
