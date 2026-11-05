import * as React from "react";
import { cn } from "../lib/cn";
import { HUE_STROKE, type SeriesHue } from "../lib/hue";
import { Legend } from "./chart-bar";

export interface DonutSeries {
  label: string;
  value: number;
  hue: SeriesHue;
}

export function Donut({
  series,
  figure,
  unit,
  size = 152,
  label,
  className,
}: {
  series: readonly DonutSeries[];
  figure?: React.ReactNode;
  unit?: string;
  size?: number;
  label: string;
  className?: string;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = series.reduce((sum, item) => sum + Math.max(0, item.value), 0);
  const drawn = series.filter((item) => item.value > 0);
  const gap = drawn.length > 1 ? 2 : 0;
  let offset = 0;

  return (
    <figure data-slot="donut" className={cn("flex flex-col items-center gap-4", className)}>
      <figcaption className="sr-only">
        {label}: {series.map((item) => `${item.label} ${item.value}`).join(", ")}
      </figcaption>
      <div className="relative" style={{ width: size, height: size }}>
        <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" strokeWidth={stroke} className="stroke-secondary" />
          {total === 0
            ? null
            : drawn.map((item) => {
                const length = Math.max(0, (item.value / total) * c - gap);
                const dash = `${length} ${c - length}`;
                const circle = (
                  <circle
                    key={item.label}
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    strokeWidth={stroke}
                    strokeDasharray={dash}
                    strokeDashoffset={-offset}
                    strokeLinecap="butt"
                    className={HUE_STROKE[item.hue]}
                  />
                );
                offset += (item.value / total) * c;
                return circle;
              })}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-title font-semibold tracking-h-sm text-foreground tabular-nums">{figure ?? total}</span>
          {unit === undefined ? null : <span className="text-xs tracking-body-xs text-muted-foreground">{unit}</span>}
        </div>
      </div>
      <Legend items={series.map((item) => ({ label: `${item.label} ${item.value}`, hue: item.hue, key: item.label }))} />
    </figure>
  );
}
