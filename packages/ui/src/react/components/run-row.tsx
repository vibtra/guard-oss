import * as React from "react";
import { CheckIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type RunRowTone = "ok" | "danger" | "warn" | "neutral";

const TONE_INK: Record<RunRowTone, string> = {
  ok: "text-hue-green-600",
  danger: "text-hue-red-600",
  warn: "text-hue-orange-600",
  neutral: "text-muted-foreground",
};

export function RunRow({
  icon,
  title,
  status,
  tone = "neutral",
  meta,
  current = false,
  onSelect,
  className,
  ...props
}: Omit<React.ComponentProps<"li">, "title" | "onSelect"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  status: React.ReactNode;
  tone?: RunRowTone;
  meta?: React.ReactNode;
  current?: boolean;
  onSelect?: () => void;
}) {
  const body = (
    <>
      {icon === undefined ? null : (
        <span aria-hidden className="mt-0.5 flex size-3 shrink-0 items-center text-muted-foreground [&_svg]:size-3">
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm tracking-body-sm text-foreground tabular-nums">{title}</span>
        <span className="flex min-w-0 items-center text-xs tracking-body-xs text-muted-foreground">
          <span className={cn("shrink-0", TONE_INK[tone])}>{status}</span>
          {meta === undefined ? null : (
            <>
              <span aria-hidden className="px-1">
                •
              </span>
              <span className="truncate">{meta}</span>
            </>
          )}
        </span>
      </span>
      {current ? <CheckIcon aria-hidden className="size-3 shrink-0 self-center text-foreground" /> : null}
    </>
  );
  const rowClass = "flex min-h-11 w-full items-start gap-2 rounded-lg p-2 text-left";
  return (
    <li data-slot="run-row" className={cn("list-none", className)} {...props}>
      {onSelect === undefined ? (
        <div className={rowClass} aria-current={current || undefined}>
          {body}
        </div>
      ) : (
        <button
          type="button"
          aria-current={current || undefined}
          onClick={onSelect}
          className={cn(rowClass, "focus-knox cursor-pointer outline-hidden hover:bg-accent aria-[current]:bg-accent")}
        >
          {body}
        </button>
      )}
    </li>
  );
}

export function RunList({ className, ...props }: React.ComponentProps<"ul">) {
  return <ul data-slot="run-list" className={cn("m-0 flex flex-col gap-0.5 p-1", className)} {...props} />;
}
