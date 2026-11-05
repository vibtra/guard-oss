import * as React from "react";
import { cn } from "../lib/cn";
import { HUE_FILL, HUE_SOLID, type SeriesHue } from "../lib/hue";

export interface Segment {
  label: string;
  value: number;
  hue: SeriesHue;
}

export function SegmentedBar({
  segments,
  className,
  label,
}: {
  segments: readonly Segment[];
  className?: string;
  label?: string;
}) {
  const total = segments.reduce((sum, segment) => sum + Math.max(0, segment.value), 0);
  const spoken = label ?? segments.map((segment) => `${segment.value} ${segment.label}`).join(", ");
  return (
    <div
      data-slot="segmented-bar"
      role="img"
      aria-label={spoken}
      className={cn("flex h-1 w-full items-stretch gap-0.5", className)}
    >
      {total === 0 ? (
        <span className="flex-1 rounded-full bg-secondary" />
      ) : (
        segments
          .filter((segment) => segment.value > 0)
          .map((segment) => (
            <span
              key={segment.label}
              className={cn("rounded-full", HUE_SOLID[segment.hue])}
              style={{ flexGrow: segment.value, flexBasis: 0 }}
            />
          ))
      )}
    </div>
  );
}

export function Legend({
  items,
  className,
}: {
  items: readonly { label: React.ReactNode; hue: SeriesHue; key?: string }[];
  className?: string;
}) {
  return (
    <ul data-slot="legend" className={cn("flex flex-wrap items-center gap-x-2.5 gap-y-1", className)}>
      {items.map((item, index) => (
        <li key={item.key ?? index} className="flex items-center gap-1 text-xs tracking-body-xs text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", HUE_SOLID[item.hue])} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export function ShareBar({ segments, className }: { segments: readonly Segment[]; className?: string }) {
  return (
    <div data-slot="share-bar" className={cn("flex flex-col gap-3", className)}>
      <SegmentedBar segments={segments} />
      <Legend items={segments.map((segment) => ({ label: `${segment.label} ${segment.value}`, hue: segment.hue, key: segment.label }))} />
    </div>
  );
}

export interface Bar {
  label: string;
  value: number;
  hue?: SeriesHue;
}

export function BarChart({
  bars,
  height = 144,
  label,
  className,
}: {
  bars: readonly Bar[];
  height?: number;
  label: string;
  className?: string;
}) {
  const max = Math.max(1, ...bars.map((bar) => bar.value));
  return (
    <figure data-slot="bar-chart" className={cn("flex items-end gap-4", className)}>
      <figcaption className="sr-only">
        {label}: {bars.map((bar) => `${bar.label} ${bar.value}`).join(", ")}
      </figcaption>
      {bars.map((bar) => {
        const h = bar.value <= 0 ? 0 : Math.max(6, Math.round((bar.value / max) * height));
        return (
          <div key={bar.label} className="flex min-w-0 flex-col items-center gap-2">
            <svg aria-hidden width={6} height={height} viewBox={`0 0 6 ${height}`} className="shrink-0">
              <rect x={0} y={0} width={6} height={height} rx={3} className="fill-secondary" />
              {h === 0 ? null : (
                <rect x={0} y={height - h} width={6} height={h} rx={3} className={HUE_FILL[bar.hue ?? "green"]} />
              )}
            </svg>
            <span className="max-w-16 truncate text-xs tracking-body-xs text-muted-foreground">{bar.label}</span>
            <span className="text-xs font-medium tracking-h-xs text-foreground tabular-nums">{bar.value}</span>
          </div>
        );
      })}
    </figure>
  );
}

export function Meter({
  value,
  max,
  caption,
  height = 461,
  className,
}: {
  value: number;
  max?: number;
  caption: React.ReactNode;
  height?: number;
  className?: string;
}) {
  const share = max === undefined || max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
  const h = Math.round(share * height);
  return (
    <div data-slot="meter" className={cn("flex flex-col items-center gap-3", className)}>
      <svg
        role="img"
        aria-label={max === undefined ? `${value}` : `${value} of ${max}`}
        width={6}
        height={height}
        viewBox={`0 0 6 ${height}`}
      >
        <rect x={0} y={0} width={6} height={height} rx={3} className="fill-secondary" />
        {h === 0 ? null : <rect x={0} y={height - h} width={6} height={h} rx={3} className="fill-hue-green-600" />}
      </svg>
      <span className="text-center text-xs tracking-body-xs text-muted-foreground">{caption}</span>
    </div>
  );
}
