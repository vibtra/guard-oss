import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export type PillTone = "ok" | "bad" | "warn" | "neutral" | "muted";
export type PillDot = "ok" | "warn" | "bad";

const TONE: Readonly<Record<PillTone, string>> = {
  ok: "border-g-pill-ok-line bg-g-pill-ok-bg text-g-pill-ok-ink",
  bad: "border-g-pill-bad-line bg-g-pill-bad-bg text-g-pill-bad-ink",
  warn: "border-g-pill-warn-line bg-g-pill-warn-bg text-g-pill-warn-ink",
  neutral: "border-g-line bg-g-surface text-g-ink",
  muted: "border-g-line bg-g-surface text-g-muted",
};

const DOT: Readonly<Record<PillDot, string>> = {
  ok: "bg-g-dot-ok",
  warn: "bg-g-dot-warn",
  bad: "bg-g-danger",
};

export function Pill({
  tone = "neutral",
  dot,
  size = "table",
  icon: Icon,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & {
  tone?: PillTone;
  dot?: PillDot;
  size?: "table" | "header";
  icon?: LucideIcon;
}) {
  return (
    <span
      data-slot="pill"
      data-tone={tone}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-g-control border font-medium whitespace-nowrap",
        size === "header" ? "h-[30px] px-2.5 text-13" : "h-6 px-2 text-12",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {dot === undefined ? null : <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[dot])} />}
      {Icon === undefined ? null : <Icon aria-hidden className="size-3.5 shrink-0" />}
      {children}
    </span>
  );
}

export function StatusDot({ tone, children, className }: { tone: PillDot; children: React.ReactNode; className?: string }) {
  return (
    <span data-slot="status-dot" className={cn("inline-flex items-center gap-2 text-14 font-medium text-g-ink", className)}>
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", DOT[tone])} />
      {children}
    </span>
  );
}

export function CountBadge({ count, className, ...props }: Omit<React.ComponentProps<"span">, "children"> & { count: number }) {
  return (
    <span
      data-slot="count-badge"
      className={cn(
        "inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-md border border-g-line bg-g-surface px-1 text-11 font-medium tabular-nums text-g-ink",
        className,
      )}
      {...props}
    >
      {count.toLocaleString("en-US")}
    </span>
  );
}

export function IconTile({
  icon: Icon,
  size = 32,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { icon?: LucideIcon; size?: 24 | 32 | 40 }) {
  return (
    <span
      aria-hidden
      data-slot="icon-tile"
      className={cn(
        "inline-flex shrink-0 items-center justify-center border border-g-line bg-g-surface text-g-muted [&_svg]:shrink-0",
        size === 40 ? "size-10 rounded-g-control [&_svg]:size-[18px]" : size === 24 ? "size-6 rounded-md [&_svg]:size-3.5" : "size-8 rounded-g-control [&_svg]:size-4",
        className,
      )}
      {...props}
    >
      {Icon === undefined ? children : <Icon aria-hidden />}
    </span>
  );
}
