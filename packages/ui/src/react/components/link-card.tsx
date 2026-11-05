import * as React from "react";
import { Link2Icon } from "lucide-react";
import { cn } from "../lib/cn";
import { type SeriesHue } from "../lib/hue";

const THUMB: Record<SeriesHue, string> = {
  green: "bg-hue-green-200",
  red: "bg-hue-red-200",
  sky: "bg-hue-sky-200",
  yellow: "bg-hue-yellow-200",
  orange: "bg-hue-orange-200",
  teal: "bg-hue-teal-200",
  purple: "bg-hue-purple-200",
  pink: "bg-hue-pink-200",
  gray: "bg-accent",
};

export function LinkCard({
  hue,
  title,
  tag,
  meta,
  preview,
  chip,
  pageActions,
  more,
  href,
  className,
}: {
  hue: SeriesHue;
  title: string;
  tag?: string;
  meta?: React.ReactNode;
  preview?: React.ReactNode;
  chip?: string;
  pageActions?: React.ReactNode;
  more?: React.ReactNode;
  href?: string;
  className?: string;
}) {
  const page = (
    <div className="relative h-[156px] w-full overflow-hidden rounded-t-xl bg-card shadow-low">
      {preview ?? (
        <div className="flex size-full items-center justify-center">
          <LinkChip className="max-w-[calc(100%-48px)]">{chip ?? "Link"}</LinkChip>
        </div>
      )}
    </div>
  );
  return (
    <article
      data-slot="link-card"
      aria-label={title}
      className={cn("flex h-(--v-link-card-h) w-(--v-link-card-w) min-w-0 flex-col gap-2.5", className)}
    >
      <div className={cn("relative h-45 shrink-0 overflow-hidden rounded-2xl px-6 pt-6", THUMB[hue])}>
        {href === undefined ? (
          page
        ) : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${title} in a new tab`}
            className="focus-knox block rounded-t-xl outline-hidden"
          >
            {page}
          </a>
        )}
        {pageActions === undefined ? null : <div className="absolute top-8 right-8">{pageActions}</div>}
      </div>
      <div className="flex min-w-0 items-start gap-2 px-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <h3 className="truncate text-sm font-medium tracking-h-xs text-foreground">{title}</h3>
            {tag === undefined ? null : (
              <span className="inline-flex h-4 shrink-0 items-center rounded bg-(--v-gray-200) px-1.5 text-tag font-medium text-(--v-gray-800)">
                {tag}
              </span>
            )}
          </div>
          {meta === undefined ? null : (
            <p className="flex min-w-0 items-center gap-1 truncate text-xs tracking-body-xs text-muted-foreground">
              {meta}
            </p>
          )}
        </div>
        {more}
      </div>
    </article>
  );
}

export function LinkChip({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="link-chip"
      className={cn(
        "inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full bg-secondary px-3 py-1.5 text-xs font-medium tracking-h-xs text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="min-w-0 truncate">{children}</span>
      <Link2Icon aria-hidden className="size-3 shrink-0" />
    </span>
  );
}

export function LinkCardPageButton({ className, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      data-slot="link-card-page-button"
      className={cn(
        "focus-knox inline-flex size-7 items-center justify-center rounded-full bg-card text-foreground shadow-low outline-hidden hover:bg-muted [&_svg]:size-3.5",
        className,
      )}
      {...props}
    />
  );
}

export function LinkCardGrid({
  className,
  columns,
  ...props
}: React.ComponentProps<"div"> & { columns?: 3 }) {
  return (
    <div
      data-slot="link-card-grid"
      className={cn(
        columns === 3
          ? "grid grid-cols-3 gap-6 px-8 pt-8 pb-6 [&_[data-slot=link-card]]:w-full"
          : "flex flex-wrap gap-6 px-8 pt-8 pb-6",
        className,
      )}
      {...props}
    />
  );
}
