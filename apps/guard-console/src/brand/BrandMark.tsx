import * as React from "react";
import { AppWindow, Globe, SquareTerminal } from "lucide-react";
import { IconTile } from "@vibtra/ui/react";
import { markForApp, markForService, markMarkup, type GuardMarkGlyph, type GuardMarkLookup } from "@vibtra/guard-contract";
import { cn } from "@/lib/utils";

const GLYPH: Record<GuardMarkGlyph, React.ComponentType<{ className?: string }>> = {
  service: Globe,
  app: AppWindow,
  cli: SquareTerminal,
};

type Size = "xs" | "sm" | "md" | "lg";
const MARK_SIZE: Record<Size, string> = { xs: "size-3", sm: "size-4", md: "size-5", lg: "size-6" };
const WIDE_PX: Record<Size, number> = { xs: 12, sm: 20, md: 28, lg: 36 };
const aspectOf = (svg: string): number => {
  const vb = /viewBox="([^"]+)"/.exec(svg)?.[1]?.trim().split(/[\s,]+/).map(Number);
  return vb !== undefined && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0 ? vb[2]! / vb[3]! : 1;
};

export function MarkTile({ lookup, size = "sm", className }: { lookup: GuardMarkLookup; size?: Size; className?: string }) {
  const id = React.useId();
  const mark = lookup.mark;
  if (mark === undefined) {
    const Glyph = GLYPH[lookup.glyph];
    return (
      <IconTile size={size} data-mark="none" data-glyph={lookup.glyph} className={className}>
        <Glyph className="text-muted-foreground" />
      </IconTile>
    );
  }
  const inner = cn("flex shrink-0 items-center justify-center", mark.wide === true ? undefined : MARK_SIZE[size]);
  const wide: React.CSSProperties | undefined = mark.wide === true ? { width: WIDE_PX[size], height: WIDE_PX[size] / aspectOf(mark.light) } : undefined;
  return (
    <IconTile
      size={size}
      data-mark={mark.id}
      data-wide={mark.wide === true ? "true" : undefined}
      className={cn("[&_svg]:size-full", mark.handling.dark === "light-tile" && "dark:bg-foreground dark:text-background", className)}
    >
      {mark.dark === undefined ? (
        <span className={inner} style={wide} dangerouslySetInnerHTML={{ __html: markMarkup(mark.light, `${id}l`) }} />
      ) : (
        <>
          <span className={cn(inner, "dark:hidden")} style={wide} dangerouslySetInnerHTML={{ __html: markMarkup(mark.light, `${id}l`) }} />
          <span className={cn(inner, "hidden dark:flex")} style={wide} dangerouslySetInnerHTML={{ __html: markMarkup(mark.dark, `${id}d`) }} />
        </>
      )}
    </IconTile>
  );
}

export function ServiceMark({ serviceId, markId, size, className }: { serviceId?: string | undefined; markId?: string | undefined; size?: Size; className?: string }) {
  return <MarkTile lookup={markForService({ serviceId, markId })} size={size} className={className} />;
}

export function AppMark({ app, size, className }: { app: { bundleId?: string | undefined; name?: string | undefined; cli?: string | undefined } | undefined; size?: Size; className?: string }) {
  return <MarkTile lookup={markForApp(app)} size={size} className={className} />;
}
