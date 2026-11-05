import * as React from "react";
import { Link } from "react-router";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export interface SegmentedTab<V extends string = string> {
  value: V;
  label: string;
  icon?: LucideIcon;
  count?: number;
  to?: string;
  disabled?: boolean;
}

export function SegmentedTabs<V extends string>({
  items,
  value,
  onValueChange,
  size = "page",
  label,
  idPrefix,
  className,
}: {
  items: readonly SegmentedTab<V>[];
  value: V;
  onValueChange?: (value: V) => void;
  size?: "page" | "list";
  label: string;
  idPrefix?: string;
  className?: string;
}) {
  const linked = items.length > 0 && items.every((item) => item.to !== undefined);
  const trackRef = React.useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = React.useState<{ left: number; width: number } | null>(null);
  const [animate, setAnimate] = React.useState(false);

  React.useLayoutEffect(() => {
    const track = trackRef.current;
    if (track === null) return;
    const measure = () => {
      const active = track.querySelector<HTMLElement>("[data-active='true']");
      if (active === null) {
        setIndicator(null);
        return;
      }
      setIndicator({ left: active.offsetLeft, width: active.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(track);
    return () => observer.disconnect();
  }, [value, items]);

  React.useEffect(() => {
    const id = typeof requestAnimationFrame === "function" ? requestAnimationFrame(() => setAnimate(true)) : undefined;
    return () => {
      if (id !== undefined && typeof cancelAnimationFrame === "function") cancelAnimationFrame(id);
    };
  }, []);

  const page = size === "page";
  const tabClass = (active: boolean) =>
    cn(
      "focus-knox relative z-[1] inline-flex shrink-0 items-center justify-center gap-1.5 rounded-g-tab px-3 text-12 font-medium whitespace-nowrap outline-hidden transition-[color] duration-(--g-dur) ease-g",
      page ? "h-8" : "h-7",
      active ? "text-g-ink" : "text-g-muted hover:text-g-ink",
      "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50",
      "[&_svg]:size-4 [&_svg]:shrink-0",
    );

  const inner = (item: SegmentedTab<V>) => (
    <>
      {page && item.icon !== undefined ? <item.icon aria-hidden /> : null}
      {item.label}
      {item.count === undefined ? null : <span className="ms-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-md bg-g-tint px-1 text-11 font-medium tabular-nums text-g-muted">{item.count.toLocaleString("en-US")}</span>}
    </>
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (linked || onValueChange === undefined) return;
    const enabled = items.filter((item) => item.disabled !== true);
    const at = enabled.findIndex((item) => item.value === value);
    let next: SegmentedTab<V> | undefined;
    if (event.key === "ArrowRight") next = enabled[(at + 1) % enabled.length];
    else if (event.key === "ArrowLeft") next = enabled[(at - 1 + enabled.length) % enabled.length];
    else if (event.key === "Home") next = enabled[0];
    else if (event.key === "End") next = enabled[enabled.length - 1];
    if (next === undefined) return;
    event.preventDefault();
    onValueChange(next.value);
    const nextValue = next.value;
    const focusNext = () =>
      [...(trackRef.current?.querySelectorAll<HTMLElement>("[data-value]") ?? [])].find((node) => node.dataset.value === nextValue)?.focus();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focusNext);
    else focusNext();
  };

  const Track = linked ? "nav" : "div";
  return (
    <Track
      aria-label={label}
      data-slot="segmented-tabs"
      data-size={size}
      className={cn("inline-flex max-w-full min-w-0 overflow-x-auto [scrollbar-width:none]", className)}
    >
      <div
        ref={trackRef}
        role={linked ? undefined : "tablist"}
        aria-label={linked ? undefined : label}
        onKeyDown={onKeyDown}
        className={cn("relative inline-flex items-center gap-0.5 bg-g-tint p-1", page ? "rounded-g-track" : "rounded-g-track-sm")}
      >
        {indicator === null ? null : (
          <span
            aria-hidden
            data-slot="segmented-indicator"
            className={cn(
              "absolute top-1 bottom-1 left-0 rounded-g-tab border border-g-line bg-g-surface shadow-g-seg",
              animate && "transition-[transform,width] duration-(--g-dur) ease-g motion-reduce:transition-none",
            )}
            style={{ transform: `translateX(${indicator.left}px)`, width: indicator.width }}
          />
        )}
        {items.map((item) => {
          const active = item.value === value;
          if (linked) {
            return (
              <Link
                key={item.value}
                to={item.to as string}
                data-value={item.value}
                data-active={active ? "true" : "false"}
                aria-current={active ? "page" : undefined}
                aria-disabled={item.disabled === true ? true : undefined}
                className={tabClass(active)}
              >
                {inner(item)}
              </Link>
            );
          }
          return (
            <button
              key={item.value}
              type="button"
              role="tab"
              id={idPrefix === undefined ? undefined : `${idPrefix}-tab-${item.value}`}
              aria-controls={idPrefix === undefined ? undefined : `${idPrefix}-panel-${item.value}`}
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              data-value={item.value}
              data-active={active ? "true" : "false"}
              onClick={() => onValueChange?.(item.value)}
              className={tabClass(active)}
            >
              {inner(item)}
            </button>
          );
        })}
      </div>
    </Track>
  );
}
