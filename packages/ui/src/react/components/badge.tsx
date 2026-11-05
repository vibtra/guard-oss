import * as React from "react";
import { CheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

const badge = cva(
  ["inline-flex items-center rounded-full font-normal whitespace-nowrap", "[&_svg]:shrink-0"],
  {
    variants: {
      tone: {
        neutral: "bg-muted text-secondary-foreground",
        chip: "bg-muted text-secondary-foreground transition-colors duration-(--v-dur-2) hover:bg-accent hover:text-foreground",
        ok: "bg-ok-bg text-ok-ink",
        warn: "bg-warn-bg text-warn-ink",
        danger: "bg-danger-bg text-danger-ink",
        info: "bg-info-bg text-info-ink",
        outline: "rounded-md border border-border bg-card text-muted-foreground",
        action: "bg-hue-green-600 text-tooltip-ink [&_svg:not([class*='size-'])]:size-3",
        mono: "bg-muted font-mono font-medium text-foreground",
        gray: "rounded bg-muted text-secondary-foreground",
      },
      size: {
        md: "h-(--v-chip-h) gap-1 px-2 py-1 text-xs [&_svg:not([class*='size-'])]:size-3",
        lg: "h-7 gap-1.5 px-3 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        xs: "h-(--v-tag-h) gap-1 px-1.5 py-0.5 text-tag [&_svg:not([class*='size-'])]:size-2.5",
      },
    },
    compoundVariants: [
      { tone: "outline", size: "md", className: "h-[22px] px-2 py-0.5 text-tag" },
      { tone: "mono", size: "md", className: "h-auto px-2 py-0.5 text-code" },
    ],
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badge>["tone"]>;

export function Badge({
  className,
  tone,
  size,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badge>) {
  return <span data-slot="badge" className={cn(badge({ tone, size }), className)} {...props} />;
}

const DOT: Record<BadgeTone, string> = {
  neutral: "bg-neutral-solid shadow-[0_0_0_2.5px_var(--v-neutral-bg)]",
  chip: "bg-neutral-solid shadow-[0_0_0_2.5px_var(--v-neutral-bg)]",
  ok: "bg-ok-solid shadow-[0_0_0_2.5px_var(--v-ok-bg)]",
  warn: "bg-warn-solid shadow-[0_0_0_2.5px_var(--v-warn-bg)]",
  danger: "bg-danger-solid shadow-[0_0_0_2.5px_var(--v-danger-bg)]",
  info: "bg-info-solid shadow-[0_0_0_2.5px_var(--v-info-bg)]",
  outline: "bg-(--v-gray-400) shadow-[0_0_0_2.5px_var(--v-neutral-bg)]",
  action: "bg-ok-solid shadow-[0_0_0_2.5px_var(--v-ok-bg)]",
  mono: "bg-neutral-solid shadow-[0_0_0_2.5px_var(--v-neutral-bg)]",
  gray: "bg-(--v-gray-400) shadow-[0_0_0_2.5px_var(--v-neutral-bg)]",
};

export function StatusDot({
  tone = "neutral",
  label,
  className,
}: {
  tone?: BadgeTone;
  label: string;
  className?: string;
}) {
  return (
    <span data-slot="status-dot" data-tone={tone} className={cn("inline-flex items-center gap-2 text-sm", className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      {label === "" ? null : label}
    </span>
  );
}

export type StatusPillKind = "live" | "ok" | "failed" | "warn" | "info" | "neutral";

const PILL: Record<StatusPillKind, string> = {
  live: "bg-ok-bg text-ok-ink",
  ok: "bg-ok-bg text-ok-ink",
  failed: "bg-danger-bg text-danger-ink",
  warn: "bg-warn-bg text-warn-ink",
  info: "bg-info-bg text-info-ink",
  neutral: "bg-muted text-secondary-foreground",
};

const PILL_GLYPH: Record<StatusPillKind, React.ReactNode> = {
  live: <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-ok-solid" />,
  ok: <CheckIcon aria-hidden />,
  failed: <XIcon aria-hidden />,
  warn: <TriangleAlertIcon aria-hidden />,
  info: <InfoIcon aria-hidden />,
  neutral: null,
};

export function StatusPill({
  kind,
  icon,
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { kind: StatusPillKind; icon?: React.ReactNode }) {
  return (
    <span
      data-slot="status-pill"
      data-kind={kind}
      className={cn(
        "inline-flex h-(--v-chip-h) shrink-0 items-center gap-1 rounded-full px-2 py-1 whitespace-nowrap",
        "text-xs font-normal",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        PILL[kind],
        className,
      )}
      {...props}
    >
      {icon === undefined ? PILL_GLYPH[kind] : icon}
      {children}
    </span>
  );
}

export { badge as badgeVariants };
