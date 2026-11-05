import * as React from "react";
import { cn } from "../lib/cn";

export interface RadarAxis {
  label: string;
  value: number;
}

export function Radar({
  axes,
  size = 180,
  label,
  className,
}: {
  axes: readonly RadarAxis[];
  size?: number;
  label: string;
  className?: string;
}) {
  const pad = 20;
  const r = size / 2 - pad;
  const cx = size / 2;
  const cy = size / 2;
  const n = Math.max(3, axes.length);
  const point = (i: number, k: number): [number, number] => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return [cx + Math.cos(angle) * r * k, cy + Math.sin(angle) * r * k];
  };
  const polygon = axes
    .map((axis, i) => point(i, Math.min(1, Math.max(0, axis.value))).join(","))
    .join(" ");

  return (
    <figure data-slot="radar" className={cn("inline-flex", className)}>
      <figcaption className="sr-only">
        {label}: {axes.map((axis) => `${axis.label} ${Math.round(axis.value * 100)}%`).join(", ")}
      </figcaption>
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {[0.25, 0.5, 0.75, 1].map((k) => (
          <circle key={k} cx={cx} cy={cy} r={r * k} fill="none" strokeWidth={0.5} className="stroke-border" />
        ))}
        {axes.map((axis, i) => {
          const [x, y] = point(i, 1);
          return <line key={axis.label} x1={cx} y1={cy} x2={x} y2={y} strokeWidth={0.5} className="stroke-border" />;
        })}
        <polygon points={polygon} className="fill-foreground/10 stroke-foreground/40" strokeWidth={1} />
        {axes.map((axis, i) => {
          const [x, y] = point(i, 1.12);
          return (
            <text
              key={axis.label}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={10}
              className="fill-muted-foreground"
            >
              {axis.label}
            </text>
          );
        })}
      </svg>
    </figure>
  );
}
