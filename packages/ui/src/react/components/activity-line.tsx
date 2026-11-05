import * as React from "react";
import { cn } from "../lib/cn";
import { HUE_SOLID, type SeriesHue } from "../lib/hue";
import { ShimmerText, useReducedMotion } from "./shimmer-text";

export type ActivityLineItem = {
  activityKey: string;
  hue?: SeriesHue;
  icon?: React.ReactNode;
  target?: React.ReactNode;
  action: React.ReactNode;
  live?: boolean;
};

function ActivityRow({
  item,
  state,
  onExited,
}: {
  item: ActivityLineItem;
  state: "current" | "leaving";
  onExited?: () => void;
}) {
  const reduced = useReducedMotion();
  return (
    <div
      data-slot="activity-line-row"
      data-state={state}
      aria-hidden={state === "leaving" ? true : undefined}
      onAnimationEnd={state === "leaving" ? onExited : undefined}
      className={cn(
        "col-start-1 row-start-1 flex min-w-0 items-center gap-2",
        !reduced && (state === "current" ? "v-rise-in" : "v-exit-up"),
        state === "leaving" && "pointer-events-none",
      )}
    >
      {item.icon !== undefined ? (
        <span aria-hidden className="flex size-3 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-3">
          {item.icon}
        </span>
      ) : item.hue !== undefined ? (
        <span aria-hidden data-slot="activity-bar" className={cn("h-3 w-1 shrink-0 rounded-full", HUE_SOLID[item.hue])} />
      ) : null}
      {item.target === undefined ? null : (
        <span className="shrink-0 truncate text-sm font-medium tracking-h-xs text-foreground">{item.target}</span>
      )}
      <ShimmerText active={(item.live ?? true) && state === "current"} className="min-w-0 truncate text-sm">
        {item.action}
      </ShimmerText>
    </div>
  );
}

export function ActivityLine({
  item,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  item: ActivityLineItem | null;
}) {
  const reduced = useReducedMotion();
  const [current, setCurrent] = React.useState<ActivityLineItem | null>(item);
  const [leaving, setLeaving] = React.useState<ActivityLineItem | null>(null);

  if (item?.activityKey !== current?.activityKey) {
    setLeaving(reduced ? null : current);
    setCurrent(item);
  } else if (item !== null && item !== current) {
    setCurrent(item);
  }

  React.useEffect(() => {
    if (leaving === null) return;
    const id = setTimeout(() => setLeaving(null), 100);
    return () => clearTimeout(id);
  }, [leaving]);

  if (current === null && leaving === null) return null;
  return (
    <div
      data-slot="activity-line"
      role="status"
      aria-live="polite"
      className={cn("grid min-h-4 min-w-0 items-center", className)}
      {...props}
    >
      {leaving === null ? null : (
        <ActivityRow key={`leaving:${leaving.activityKey}`} item={leaving} state="leaving" onExited={() => setLeaving(null)} />
      )}
      {current === null ? null : <ActivityRow key={`current:${current.activityKey}`} item={current} state="current" />}
    </div>
  );
}
