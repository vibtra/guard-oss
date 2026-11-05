import * as React from "react";
import { cn } from "../lib/cn";
import { HUE_400, HUE_SOLID, type SeriesHue } from "../lib/hue";

export interface TimelineEvent {
  id: string;
  at: number;
  hue: SeriesHue;
  label: string;
}

const PILL = "inline-flex h-6 items-center rounded-full px-2 py-1.5 font-mono text-axis leading-3 tracking-normal whitespace-nowrap";

export function Timeline({
  events,
  now = 1,
  start,
  nowLabel = "Now",
  height = 157,
  label,
  className,
}: {
  events: readonly TimelineEvent[];
  now?: number;
  start?: string;
  nowLabel?: string;
  height?: number;
  label: string;
  className?: string;
}) {
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const pct = (n: number) => `${clamp(n) * 100}%`;
  return (
    <figure data-slot="timeline" className={cn("relative w-full", className)}>
      <figcaption className="sr-only">{label}</figcaption>
      <ul className="sr-only">
        {events.map((event) => (
          <li key={event.id}>{event.label}</li>
        ))}
      </ul>
      <div aria-hidden className="relative w-full" style={{ height }}>
        <span
          className="absolute bottom-0 left-0 h-0.5 bg-(--v-gray-400)"
          style={{ width: pct(now) }}
        />
        <span
          className="absolute bottom-0 h-0.5 bg-[repeating-linear-gradient(90deg,var(--v-gray-400)_0_6px,transparent_6px_12px)]"
          style={{ left: pct(now), right: 0 }}
        />
        <span
          className="absolute bottom-[-20px] w-0.5 -translate-x-1/2 bg-(--v-gray-400)"
          style={{ left: pct(now), top: Math.max(0, height - 157) }}
        />
        {events.map((event) => (
          <span
            key={event.id}
            title={event.label}
            className={cn(
              "absolute bottom-[-4px] size-2.5 -translate-x-1/2 rounded-full shadow-[0_0_0_2px_var(--background)]",
              HUE_SOLID[event.hue],
            )}
            style={{ left: pct(event.at) }}
          />
        ))}
      </div>
      <div aria-hidden className="relative mt-5 h-6">
        {start === undefined ? null : <span className={cn(PILL, "absolute left-0 text-muted-foreground")}>{start}</span>}
        <span
          className={cn(PILL, "absolute -translate-x-1/2 bg-(--v-gray-400) text-foreground")}
          style={{ left: pct(now) }}
        >
          {nowLabel}
        </span>
      </div>
    </figure>
  );
}

export interface GanttRow {
  id: string;
  label: string;
  hue: SeriesHue;
  from: number;
  done: number;
  to?: number;
}

export function Gantt({
  rows,
  ticks,
  label,
  className,
}: {
  rows: readonly GanttRow[];
  ticks: readonly string[];
  label: string;
  className?: string;
}) {
  const pct = (n: number) => `${Math.min(1, Math.max(0, n)) * 100}%`;
  return (
    <figure data-slot="gantt" className={cn("relative w-full", className)}>
      <figcaption className="sr-only">
        {label}: {rows.map((row) => row.label).join(", ")}
      </figcaption>
      <div aria-hidden className="relative w-full" style={{ height: Math.max(1, rows.length) * 28 }}>
        {rows.map((row, i) => (
          <React.Fragment key={row.id}>
            <span
              title={row.label}
              className={cn("absolute h-3.5 rounded-full", HUE_400[row.hue])}
              style={{ top: i * 28 + 7, left: pct(row.from), width: `calc(${pct(row.done)} - ${pct(row.from)})` }}
            />
            {row.to === undefined || row.to <= row.done ? null : (
              <span
                className={cn("absolute h-3.5 rounded-full opacity-30", HUE_400[row.hue])}
                style={{ top: i * 28 + 7, left: pct(row.done), width: `calc(${pct(row.to)} - ${pct(row.done)})` }}
              />
            )}
          </React.Fragment>
        ))}
      </div>
      <div aria-hidden className="h-0.5 w-full bg-(--v-gray-400)" />
      <div aria-hidden className="mt-2 flex justify-between">
        {ticks.map((tick) => (
          <span key={tick} className="font-mono text-axis leading-none font-normal text-muted-foreground">
            {tick}
          </span>
        ))}
      </div>
    </figure>
  );
}
