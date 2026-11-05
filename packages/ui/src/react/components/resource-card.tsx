import * as React from "react";
import { PlusIcon } from "lucide-react";
import { cn } from "../lib/cn";

export interface ResourceCardProps extends Omit<React.ComponentProps<"article">, "title"> {
  icon?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  status?: React.ReactNode;
  meta?: React.ReactNode;
  corner?: React.ReactNode;
  link?: React.ReactElement<{ className?: string; children?: React.ReactNode }>;
}

export function ResourceCard({ icon, title, sub, status, meta, corner, link, className, ...props }: ResourceCardProps) {
  return (
    <article
      data-slot="resource-card"
      className={cn(
        "relative flex min-h-[177px] min-w-0 flex-col rounded-xl border-[0.5px] border-border bg-card px-5 py-4",
        "transition-colors duration-(--v-dur-1) hover:bg-accent",
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-2">
        <span aria-hidden className="inline-flex size-6 shrink-0 items-center justify-center text-foreground [&_svg]:size-6">
          {icon}
        </span>
        {corner === undefined ? null : <div className="relative z-1 -mt-1 -mr-2 flex shrink-0">{corner}</div>}
      </div>
      <div className="mt-3 flex min-w-0 flex-col">
        <h3 data-slot="resource-card-title" className="truncate text-sm font-medium text-foreground">
          {link === undefined
            ? title
            : React.cloneElement(link, {
                className: cn("focus-knox outline-hidden after:absolute after:inset-0", link.props.className),
                children: title,
              })}
        </h3>
        {sub === undefined ? null : <p className="truncate text-xs text-muted-foreground">{sub}</p>}
      </div>
      {status === undefined ? null : <div className="mt-3 flex flex-wrap items-center gap-1.5">{status}</div>}
      {meta === undefined ? null : (
        <div className="mt-auto flex flex-col pt-3 text-tag leading-[14px] text-muted-foreground">{meta}</div>
      )}
    </article>
  );
}

export function NewResourceTile({ className, children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="new-resource-tile"
      className={cn(
        "focus-knox flex min-h-[160px] w-full flex-col items-center justify-center gap-1 rounded-lg border border-border bg-card text-sm text-secondary-foreground outline-hidden",
        "transition-colors duration-(--v-dur-1) hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <PlusIcon aria-hidden className="size-4" />
      <span>{children}</span>
    </button>
  );
}

export function ResourceGrid({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="resource-grid"
      className={cn("grid grid-cols-[repeat(auto-fill,minmax(min(var(--v-resource-card-w),100%),1fr))] gap-4", className)}
      {...props}
    />
  );
}
