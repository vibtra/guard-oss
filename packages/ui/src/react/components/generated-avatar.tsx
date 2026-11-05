import * as React from "react";
import { Avatar as DiceBearAvatar, Style } from "@dicebear/core";
import glassDefinition from "@dicebear/styles/glass.json" with { type: "json" };
import { cn } from "../lib/cn";

const PALETTE = ["3F73BE", "007D9B", "008367", "35823B", "A46500", "B7535F", "8961B4"];

const glassStyle = new Style(glassDefinition as never);

function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const MONOGRAM_HUES = 14;

function monogramHue(stableId: string): string {
  return `var(--v-monogram-${(hash(stableId) % MONOGRAM_HUES) + 1})`;
}

function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/u).filter((word) => word.length > 0);
  const letters = words.length > 1 ? [words[0], words[1]] : words.slice(0, 1);
  return letters.map((word) => (word ?? "").charAt(0)).join("").toUpperCase();
}

const FONT_STACK = "'Inter Variable', 'Inter', system-ui, sans-serif";

function withFontStack(svg: string): string {
  return svg.replace(/font-family="[^"]*"/g, `font-family="${FONT_STACK}"`);
}

function stripMetadata(svg: string): string {
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<metadata[\s\S]*?<\/metadata>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "");
}

const cache = new Map<string, string>();

function render(key: string, make: () => string): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const svg = withFontStack(stripMetadata(make()));
  cache.set(key, svg);
  return svg;
}

export type GeneratedAvatarProps = {
  seed: string;
  name: string;
  kind?: "entity" | "person";
  shape?: "square" | "circle";
  photoUrl?: string;
  size?: number;
  className?: string;
  badge?: React.ReactNode;
  showTitle?: boolean;
};

export function AvatarBadge({
  hue = "yellow",
  className,
  ...props
}: React.ComponentProps<"span"> & { hue?: "yellow" | "green" | "sky" | "red" | "purple" }) {
  const fill = {
    yellow: "bg-hue-yellow-600",
    green: "bg-hue-green-600",
    sky: "bg-hue-sky-600",
    red: "bg-hue-red-600",
    purple: "bg-hue-purple-600",
  }[hue];
  return (
    <span
      data-slot="avatar-badge"
      className={cn(
        "inline-flex size-4 items-center justify-center rounded-full text-tooltip-ink shadow-[0_0_0_1.5px_var(--card)] [&_svg]:size-2.5",
        fill,
        className,
      )}
      {...props}
    />
  );
}

export function GeneratedAvatar({ badge, className, ...props }: GeneratedAvatarProps) {
  if (badge === undefined) return <AvatarFace className={className} {...props} />;
  return (
    <span data-slot="avatar-with-badge" className={cn("relative inline-block shrink-0", className)}>
      <AvatarFace className="size-full" {...props} />
      <span className="absolute -right-1 -bottom-1 flex">{badge}</span>
    </span>
  );
}

function AvatarFace({
  seed,
  name,
  kind = "entity",
  shape = kind === "person" ? "circle" : "square",
  photoUrl,
  size = 64,
  className,
  showTitle = true,
}: Omit<GeneratedAvatarProps, "badge">) {
  const radius = shape === "circle" ? "rounded-full" : "rounded";

  const svg = React.useMemo(() => {
    if (photoUrl) return null;
    if (kind === "person") return null;
    return render(`g:${seed}:${size}`, () =>
      new DiceBearAvatar(glassStyle, {
        seed,
        size,
        idRandomization: true,
        animationProbability: 0,
        backgroundColor: PALETTE,
        backgroundColorFill: ["linear"],
        backgroundColorAngle: [135, 135],
      }).toString(),
    );
  }, [seed, name, kind, photoUrl, size]);

  if (photoUrl) {
    return (
      <span
        data-slot="avatar-photo"
        className={cn("relative block shrink-0 overflow-hidden", radius, className)}
      >
        <img src={photoUrl} alt="" aria-hidden className="block size-full object-cover" />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 shadow-[inset_0_0_0_0.5px_var(--border)]",
            radius,
          )}
        />
      </span>
    );
  }

  if (kind === "person") {
    return (
      <span
        aria-hidden
        data-slot="generated-avatar"
        title={showTitle ? name : undefined}
        className={cn("block shrink-0 overflow-hidden", radius, className)}
        style={{ backgroundColor: monogramHue(seed) }}
      >
        <svg viewBox="0 0 32 32" className="h-full w-full" xmlns="http://www.w3.org/2000/svg">
          <text
            x="16"
            y="16"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="12"
            fontWeight="400"
            fill="var(--v-monogram-ink)"
          >
            {initialsOf(name)}
          </text>
        </svg>
      </span>
    );
  }

  return (
    <span
      aria-hidden
      data-slot="generated-avatar"
      title={showTitle ? name : undefined}
      className={cn("block shrink-0 overflow-hidden [&>svg]:h-full [&>svg]:w-full", radius, className)}
      dangerouslySetInnerHTML={{ __html: svg ?? "" }}
    />
  );
}
