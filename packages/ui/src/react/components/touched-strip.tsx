import * as React from "react";
import { cn } from "../lib/cn";
import { stepHue, type SeriesHue } from "../lib/hue";
import { StepCard } from "./step-card";

export type TouchedItem = {
  id: string;
  name: string;
  hue?: SeriesHue;
  count?: number;
  countLabel?: string;
  glyphs?: React.ReactNode;
};

export function TouchedStrip({
  items,
  activeId,
  onSelect,
  activeBadge,
  dimInactive = false,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children" | "onSelect"> & {
  items: readonly TouchedItem[];
  activeId?: string;
  onSelect?: (id: string) => void;
  activeBadge?: React.ReactNode;
  dimInactive?: boolean;
}) {
  return (
    <div
      data-slot="touched-strip"
      className={cn("scrollbar-knox flex min-w-0 items-center gap-7 overflow-x-auto px-8 py-2", className)}
      {...props}
    >
      {items.map((item, i) => {
        const active = item.id === activeId;
        return (
          <div
            key={item.id}
            data-slot="touched-card"
            data-active={active || undefined}
            className="v-grow-in min-w-[140px] flex-1 basis-0 overflow-visible! [--v-grow-to:280px]"
          >
            <StepCard
              hue={item.hue ?? stepHue(i)}
              title={item.name}
              count={item.count}
              countLabel={item.countLabel}
              glyphs={item.glyphs}
              selected={active}
              dimmed={dimInactive && activeId !== undefined && !active}
              badge={active ? activeBadge : undefined}
              onClick={onSelect === undefined ? undefined : () => onSelect(item.id)}
              className="v-grow w-full [&_.flex-col]:gap-0 [&_.truncate]:text-sm [&_.truncate]:leading-4"
            />
          </div>
        );
      })}
    </div>
  );
}
