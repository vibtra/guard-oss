import * as React from "react";
import { cn } from "../lib/cn";

export interface AccessNode {
  id: string;
  name: string;
  meta?: string;
  lead?: React.ReactNode;
}

export interface AccessColumn {
  id: string;
  title: string;
  nodes: readonly AccessNode[];
}

const PITCH = 272;
const LEFT = 24;
const HEAD = 48;
const CARD_W = 208;
const CARD_H = 48;
const GAP = 16;

export function AccessMap({
  columns,
  edges,
  highlight,
  onNodeClick,
  className,
  label = "Access map",
}: {
  columns: readonly AccessColumn[];
  edges: readonly { from: string; to: string }[];
  highlight?: ReadonlySet<string>;
  onNodeClick?: (id: string) => void;
  className?: string;
  label?: string;
}) {
  const place = new Map<string, { x: number; y: number; column: number }>();
  columns.forEach((column, c) => {
    column.nodes.forEach((node, r) => {
      place.set(node.id, { x: LEFT + c * PITCH, y: HEAD + GAP + r * (CARD_H + GAP), column: c });
    });
  });
  const degree = new Map<string, number>();
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);
  }
  const rows = Math.max(0, ...columns.map((column) => column.nodes.length));
  const width = LEFT + Math.max(1, columns.length) * PITCH;
  const height = HEAD + GAP + rows * (CARD_H + GAP) + GAP;

  return (
    <div data-slot="access-map" role="group" aria-label={label} className={cn("relative overflow-auto", className)}>
      <div className="relative" style={{ width: `max(100%, ${width}px)`, height }}>
        <div className="absolute inset-x-0 top-0 flex h-12 items-center hairline-b">
          {columns.map((column, c) => (
            <span
              key={column.id}
              className="absolute text-xs tracking-body-xs text-muted-foreground"
              style={{ left: LEFT + c * PITCH }}
            >
              {column.title}
            </span>
          ))}
        </div>
        <svg aria-hidden width={width} height={height} className="pointer-events-none absolute inset-0">
          {edges.map((edge) => {
            const a = place.get(edge.from);
            const b = place.get(edge.to);
            if (a === undefined || b === undefined || Math.abs(a.column - b.column) !== 1) return null;
            const [l, r] = a.column < b.column ? [a, b] : [b, a];
            const x1 = l.x + CARD_W;
            const y1 = l.y + CARD_H / 2;
            const x2 = r.x;
            const y2 = r.y + CARD_H / 2;
            const mid = (x1 + x2) / 2;
            const dim = highlight !== undefined && !(highlight.has(edge.from) && highlight.has(edge.to));
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                strokeWidth={1}
                className={cn("stroke-border", dim && "opacity-30")}
              />
            );
          })}
        </svg>
        {columns.map((column) => (
          <ul key={column.id} aria-label={column.title} className="contents">
            {column.nodes.map((node) => {
              const at = place.get(node.id);
              if (at === undefined) return null;
              const dim = highlight !== undefined && !highlight.has(node.id);
              const links = degree.get(node.id) ?? 0;
              const body = (
                <>
                  {node.lead}
                  <span className="flex min-w-0 flex-col text-left">
                    <span className="truncate text-xs font-medium tracking-h-xs text-foreground">{node.name}</span>
                    {node.meta === undefined ? null : (
                      <span className="truncate text-xs tracking-body-xs text-muted-foreground">{node.meta}</span>
                    )}
                  </span>
                </>
              );
              const shape = cn(
                "absolute flex h-12 w-52 items-center gap-2 rounded-xl bg-card p-2 shadow-[inset_0_0_0_0.5px_var(--border)] transition-opacity",
                dim && "opacity-30",
              );
              return (
                <li key={node.id} aria-label={`${node.name}: ${links} ${links === 1 ? "link" : "links"}`}>
                  {onNodeClick === undefined ? (
                    <div className={shape} style={{ left: at.x, top: at.y }}>
                      {body}
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onNodeClick(node.id)}
                      className={cn(shape, "focus-knox outline-hidden hover:bg-muted")}
                      style={{ left: at.x, top: at.y }}
                    >
                      {body}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
      </div>
    </div>
  );
}
