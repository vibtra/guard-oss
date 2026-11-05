import * as React from "react";
import { cn } from "../lib/cn";

export const TILE_HUES = ["teal", "purple", "sky", "orange", "pink", "green", "yellow", "red"] as const;
export type TileHue = (typeof TILE_HUES)[number];

const HUE_CLASS: Record<TileHue, string> = {
  teal: "bg-hue-teal-200 text-hue-teal-600",
  purple: "bg-hue-purple-200 text-hue-purple-600",
  sky: "bg-hue-sky-200 text-hue-sky-600",
  orange: "bg-hue-orange-200 text-hue-orange-600",
  pink: "bg-hue-pink-200 text-hue-pink-600",
  green: "bg-hue-green-200 text-hue-green-600",
  yellow: "bg-hue-yellow-200 text-hue-yellow-600",
  red: "bg-hue-red-200 text-hue-red-600",
};

export function hueFor(id: string): TileHue {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return TILE_HUES[(hash >>> 0) % TILE_HUES.length] ?? "teal";
}

const SIZE = {
  xs: "size-4 rounded-sm [&_svg]:size-2.5",
  sm: "size-6 rounded-md [&_svg]:size-3",
  md: "size-8 rounded [&_svg]:size-4",
  lg: "size-10 rounded-lg [&_svg]:size-5",
} as const;

export function IconTile({
  hue,
  size = "md",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { hue?: TileHue; size?: keyof typeof SIZE }) {
  return (
    <span
      data-slot="icon-tile"
      data-hue={hue ?? "neutral"}
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center [&_svg]:shrink-0",
        SIZE[size],
        hue === undefined ? "bg-accent text-foreground" : HUE_CLASS[hue],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}
