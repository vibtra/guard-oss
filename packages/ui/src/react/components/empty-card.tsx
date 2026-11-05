import * as React from "react";
import { BoxIcon, CircleSlashIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type EmptyCardVariant = "page" | "box";
const EmptyVariantContext = React.createContext<EmptyCardVariant>("page");

export function EmptyCard({
  className,
  variant = "page",
  ...props
}: React.ComponentProps<"div"> & { variant?: EmptyCardVariant }) {
  return (
    <EmptyVariantContext.Provider value={variant}>
      <div
        data-slot="empty-card"
        data-variant={variant}
        className={cn(
          variant === "box"
            ? "flex flex-col items-center rounded-xl border-[0.5px] border-border bg-card px-5 py-14 text-center"
            : "flex flex-col items-center bg-card px-6 py-16 text-center",
          className,
        )}
        {...props}
      />
    </EmptyVariantContext.Provider>
  );
}

export function VibtraEmptyGlyph({ className }: { className?: string }) {
  return (
    <span data-slot="vibtra-empty-glyph" className={cn("relative inline-block size-full", className)}>
      <BoxIcon strokeWidth={1} className="absolute top-0 left-1/2 size-1/2! -translate-x-1/2" />
      <BoxIcon strokeWidth={1} className="absolute bottom-0 left-0 size-1/2!" />
      <BoxIcon strokeWidth={1} className="absolute right-0 bottom-0 size-1/2!" />
    </span>
  );
}

export function EmptyCardGlyph({ className, children, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="empty-card-glyph"
      aria-hidden
      className={cn(
        "mb-6 inline-flex size-(--v-empty-glyph) shrink-0 items-center justify-center text-foreground opacity-15",
        "[&>svg]:size-(--v-empty-glyph) [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {children ?? <VibtraEmptyGlyph />}
    </span>
  );
}

export function EmptyCardTitle({
  className,
  as: Tag = "h3",
  ...props
}: React.ComponentProps<"h3"> & { as?: "h2" | "h3" | "p" }) {
  return (
    <Tag
      data-slot="empty-card-title"
      className={cn(
        "w-(--v-empty-col-w) max-w-full text-xl font-medium tracking-h-xl text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyCardDescription({ className, ...props }: React.ComponentProps<"p">) {
  const variant = React.useContext(EmptyVariantContext);
  return (
    <p
      data-slot="empty-card-description"
      className={cn(
        "w-(--v-empty-col-w) max-w-full",
        variant === "box" ? "mt-2 text-sm text-muted-foreground" : "mt-2 text-md text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function EmptyCardActions({ className, ...props }: React.ComponentProps<"div">) {
  const variant = React.useContext(EmptyVariantContext);
  return (
    <div
      data-slot="empty-card-actions"
      className={cn(variant === "box" ? "mt-4 flex items-center gap-2" : "mt-6 flex items-center gap-2", className)}
      {...props}
    />
  );
}

export function EmptyRow({
  title,
  line,
  icon,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title"> & {
  title: React.ReactNode;
  line?: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <div
      data-slot="empty-row"
      className={cn(
        "flex min-h-[72px] items-center gap-3 rounded-xl border border-border bg-card p-4",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground [&_svg]:size-4"
      >
        {icon ?? <CircleSlashIcon />}
      </span>
      <div className="flex min-w-0 flex-col">
        <p className="truncate text-sm leading-pair font-medium text-foreground">{title}</p>
        {line === undefined ? null : (
          <p className="truncate text-sm leading-pair text-muted-foreground">{line}</p>
        )}
      </div>
    </div>
  );
}
