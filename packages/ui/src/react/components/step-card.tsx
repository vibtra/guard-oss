import * as React from "react";
import {
  ArrowLeftIcon,
  CableIcon,
  RulerIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  SquareDashedIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import {
  HUE_CARD,
  HUE_CARD_SELECTED,
  HUE_COUNTER,
  HUE_COUNTER_SELECTED,
  HUE_SOLID,
  type SeriesHue,
} from "../lib/hue";

const OnMapContext = React.createContext(false);

export function StepCard({
  hue,
  title,
  count,
  countLabel,
  glyphs,
  selected = false,
  dimmed = false,
  badge,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "title"> & {
  hue: SeriesHue;
  title: string;
  count?: number;
  countLabel?: string;
  glyphs?: React.ReactNode;
  selected?: boolean;
  dimmed?: boolean;
  badge?: React.ReactNode;
}) {
  const onMap = React.useContext(OnMapContext);
  return (
    <button
      type="button"
      data-slot="step-card"
      data-selected={selected || undefined}
      aria-pressed={selected}
      aria-label={count === undefined ? title : `${title}, ${count} ${countLabel ?? ""}`.trim()}
      className={cn(
        "focus-knox relative flex h-(--v-step-card-h) w-(--v-step-card-w) shrink-0 items-stretch gap-1.5 rounded-xl p-2 text-left outline-hidden",
        "transition-opacity duration-(--v-dur-2)",
        selected ? HUE_CARD_SELECTED[hue] : cn(HUE_CARD[hue], !onMap && "shadow-[0_0_0_3px_var(--card)]"),
        dimmed && !selected && "opacity-30",
        className,
      )}
      {...props}
    >
      <span aria-hidden className={cn("w-[3px] shrink-0 rounded-xs", HUE_SOLID[hue])} />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate text-xs leading-3 font-medium tracking-h-xs">{title}</span>
        <span aria-hidden className="flex h-4 items-center gap-1.5 [&_svg]:size-3 [&_svg]:shrink-0">
          {count === undefined ? null : (
            <span
              className={cn(
                "inline-flex h-4 min-w-4 items-center justify-center rounded-[10px] px-1 py-0.5 text-tag font-strong tabular-nums",
                selected ? HUE_COUNTER_SELECTED[hue] : HUE_COUNTER[hue],
              )}
            >
              {count}
            </span>
          )}
          {glyphs}
        </span>
      </span>
      {badge === undefined ? null : <span className="absolute -top-1.5 -right-1.5 flex">{badge}</span>}
    </button>
  );
}

export function StepStrip({
  className,
  toolbar,
  children,
  ...props
}: React.ComponentProps<"div"> & { toolbar?: React.ReactNode }) {
  return (
    <div
      data-slot="step-strip"
      className={cn(
        "relative flex h-(--v-step-strip-h) shrink-0 items-center",
        "[mask-image:linear-gradient(to_bottom,transparent,black_12px)]",
        className,
      )}
      {...props}
    >
      <div className="scrollbar-knox flex min-w-0 flex-1 items-center gap-7 overflow-x-auto py-2 pr-4 pl-8">
        {children}
      </div>
      {toolbar === undefined ? null : <div className="flex shrink-0 items-center pr-3">{toolbar}</div>}
    </div>
  );
}

export type MapTool = "search" | "size" | "spacing" | "connections" | "collapse";

const TOOL_GLYPH: Record<MapTool, React.ReactNode> = {
  search: <SearchIcon aria-hidden />,
  size: <RulerIcon aria-hidden />,
  spacing: <SlidersHorizontalIcon aria-hidden />,
  connections: <CableIcon aria-hidden />,
  collapse: <SquareDashedIcon aria-hidden />,
};

const TOOL_LABEL: Record<MapTool, string> = {
  search: "Find a step",
  size: "Card size",
  spacing: "Spacing",
  connections: "Show connections",
  collapse: "Expand the map",
};

export function MapToolbar({
  floating = false,
  onTool,
  labels,
  pressed,
  className,
}: {
  floating?: boolean;
  onTool?: (tool: MapTool) => void;
  labels?: Partial<Record<MapTool, string>>;
  pressed?: Partial<Record<MapTool, boolean>>;
  className?: string;
}) {
  return (
    <div
      role="toolbar"
      aria-label="Map"
      data-slot="map-toolbar"
      className={cn(
        "flex items-center gap-1",
        floating && "h-8 w-36 justify-between rounded-full bg-card p-1 shadow-low",
        className,
      )}
    >
      {(["search", "size", "spacing", "connections", "collapse"] as const).map((tool) => (
        <button
          key={tool}
          type="button"
          aria-label={labels?.[tool] ?? TOOL_LABEL[tool]}
          title={labels?.[tool] ?? TOOL_LABEL[tool]}
          aria-pressed={pressed?.[tool]}
          onClick={() => onTool?.(tool)}
          className="focus-knox inline-flex size-6 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground aria-pressed:bg-accent aria-pressed:text-foreground [&_svg]:size-3"
        >
          {TOOL_GLYPH[tool]}
        </button>
      ))}
    </div>
  );
}

export interface MapNode {
  id: string;
  x: number;
  y: number;
  card: React.ReactNode;
}

export function StepMap({
  nodes,
  links,
  onCollapse,
  toolbar,
  className,
}: {
  nodes: readonly MapNode[];
  links: readonly { from: string; to: string }[];
  onCollapse?: () => void;
  toolbar?: React.ReactNode;
  className?: string;
}) {
  const minX = nodes.length === 0 ? 0 : Math.min(...nodes.map((node) => node.x));
  const minY = nodes.length === 0 ? 0 : Math.min(...nodes.map((node) => node.y));
  const shifted = nodes.map((node) => ({ ...node, x: node.x - minX + 32, y: node.y - minY + 32 }));
  const at = new Map(shifted.map((node) => [node.id, node]));
  const width = Math.max(0, ...shifted.map((node) => node.x + 220)) + 32;
  const height = Math.max(0, ...shifted.map((node) => node.y + 48)) + 32;
  return (
    <div data-slot="step-map" className={cn("relative flex min-h-0 flex-1 overflow-auto", className)}>
      <OnMapContext.Provider value={true}>
      <div data-slot="step-map-canvas" className="relative m-auto shrink-0" style={{ width, height }}>
        <svg aria-hidden width={width} height={height} className="pointer-events-none absolute inset-0">
          {links.map((link) => {
            const a = at.get(link.from);
            const b = at.get(link.to);
            if (a === undefined || b === undefined) return null;
            const x1 = a.x + 220;
            const y1 = a.y + 24;
            const x2 = b.x;
            const y2 = b.y + 24;
            const mid = (x1 + x2) / 2;
            return (
              <path
                key={`${link.from}-${link.to}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                strokeWidth={1}
                className="stroke-border"
              />
            );
          })}
        </svg>
        {shifted.map((node) => (
          <div key={node.id} className="absolute" style={{ left: node.x, top: node.y }}>
            {node.card}
          </div>
        ))}
      </div>
      </OnMapContext.Provider>
      {onCollapse === undefined ? null : (
        <button
          type="button"
          aria-label="Collapse the map"
          title="Collapse the map"
          onClick={onCollapse}
          className="focus-knox absolute top-3 left-3 z-1 inline-flex size-8 items-center justify-center rounded-full bg-card text-foreground shadow-low outline-hidden hover:bg-muted [&_svg]:size-4"
        >
          <ArrowLeftIcon aria-hidden />
        </button>
      )}
      {toolbar === undefined ? null : <div className="absolute right-3 bottom-3 z-1">{toolbar}</div>}
    </div>
  );
}
