import * as React from "react";
import { InfoIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Legend, SegmentedBar, type Segment } from "./chart-bar";

export function StatRow({ className, ...props }: React.ComponentProps<"dl">) {
  return (
    <dl
      data-slot="stat-row"
      className={cn("grid auto-cols-[108px] grid-flow-col justify-start", className)}
      {...props}
    />
  );
}

export function Stat({
  label,
  value,
  under,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  under?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="stat" className={cn("flex min-w-0 flex-col", className)}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-sm font-medium text-foreground tabular-nums">{value}</dd>
      {under === undefined ? null : <dd className="mt-1 flex">{under}</dd>}
    </div>
  );
}

export function BigStat({
  label,
  value,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="big-stat" className={cn("flex min-w-0 flex-col", className)}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate text-2xl font-semibold text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

export function StatusCard({
  label,
  info,
  value,
  segments,
  action,
  className,
}: {
  label: string;
  info?: string;
  value?: React.ReactNode;
  segments: readonly Segment[];
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="status-card"
      aria-label={label}
      className={cn(
        "relative flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-card p-6",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <dl className="flex min-w-0 flex-col">
          <dt className="flex items-center gap-1 text-xs text-muted-foreground">
            {label}
            {info === undefined ? null : (
              <span title={info} className="inline-flex">
                <InfoIcon aria-label={info} className="size-3" />
              </span>
            )}
          </dt>
          <dd
            className={cn(
              "mt-1 text-sm font-medium tabular-nums",
              value === undefined ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {value ?? "–"}
          </dd>
        </dl>
        {action}
      </div>
      <div className="mt-auto flex flex-col gap-4">
        <SegmentedBar segments={segments} />
        <Legend
          items={segments.map((segment) => ({
            label: `${segment.value} ${segment.label}`,
            hue: segment.value > 0 ? segment.hue : "gray",
            key: segment.label,
          }))}
        />
      </div>
    </section>
  );
}

export function ChipButton({
  className,
  icon,
  children,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode }) {
  return (
    <button
      type="button"
      data-slot="chip-button"
      className={cn(
        "focus-knox inline-flex h-6 shrink-0 items-center gap-1.5 rounded-lg bg-secondary px-2 py-1 outline-hidden",
        "text-xs font-medium text-secondary-foreground transition-colors duration-(--v-dur-2) hover:bg-accent hover:text-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      {children}
    </button>
  );
}

export interface MetricNumber {
  label: React.ReactNode;
  value: React.ReactNode;
}

export function MetricCard({
  title,
  description,
  figure,
  numbers,
  progress,
  period,
  className,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  figure?: React.ReactNode;
  numbers?: readonly MetricNumber[];
  progress?: { value: number; max: number; tone?: "default" | "warn" | "danger"; label?: string };
  period?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  const ratio = progress === undefined || progress.max <= 0 ? 0 : Math.min(1, Math.max(0, progress.value / progress.max));
  return (
    <section
      data-slot="metric-card"
      aria-label={title}
      className={cn("relative flex min-w-0 flex-col gap-5 rounded-xl border border-border bg-card p-6", className)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="truncate text-lg font-medium text-foreground">{title}</h3>
          {description === undefined ? null : <p className="text-xs text-muted-foreground">{description}</p>}
          {figure === undefined ? null : (
            <p className="text-2xl font-semibold text-foreground tabular-nums">{figure}</p>
          )}
        </div>
        {period === undefined ? null : (
          <span className="inline-flex h-6 shrink-0 items-center rounded-full bg-muted px-2 text-xs text-secondary-foreground">
            {period}
          </span>
        )}
      </div>
      {numbers === undefined || numbers.length === 0 ? null : (
        <dl data-slot="metric-numbers" className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {numbers.map((number, i) => (
            <BigStat key={i} label={number.label} value={number.value} />
          ))}
        </dl>
      )}
      {progress === undefined ? null : (
        <div
          role="progressbar"
          aria-label={progress.label ?? title}
          aria-valuemin={0}
          aria-valuemax={progress.max}
          aria-valuenow={progress.value}
          data-slot="metric-progress"
          className="h-3.5 w-full overflow-hidden rounded-full border border-border bg-card"
        >
          <span
            className={cn(
              "block h-full rounded-full",
              progress.tone === "danger" ? "bg-danger-solid" : progress.tone === "warn" ? "bg-warn-solid" : "bg-primary",
            )}
            style={{ width: `${ratio * 100}%` }}
          />
        </div>
      )}
      {children}
    </section>
  );
}
