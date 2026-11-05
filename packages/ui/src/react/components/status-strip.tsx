import * as React from "react";
import { cn } from "../lib/cn";
import { WorkingAvatar } from "./working-avatar";

export function formatElapsed(ms: number): string {
  const tenths = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 100) : 0;
  const totalSeconds = Math.floor(tenths / 10);
  const secTenths = `${totalSeconds % 60}.${tenths % 10}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes === 0) return secTenths;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${secTenths}`;
  return `${hours}h ${minutes % 60}m ${secTenths}`;
}

export function useElapsed(startedAt: number | undefined, running: boolean, elapsedMs?: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!running || startedAt === undefined || elapsedMs !== undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [running, startedAt, elapsedMs]);
  if (elapsedMs !== undefined) return elapsedMs;
  if (startedAt === undefined) return 0;
  return Math.max(0, now - startedAt);
}

export function StatusStrip({
  sentence,
  working = false,
  startedAt,
  elapsedMs,
  showTimer,
  face,
  ringColors,
  trailing,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  sentence: React.ReactNode;
  working?: boolean;
  startedAt?: number;
  elapsedMs?: number;
  showTimer?: boolean;
  face?: React.ReactNode;
  ringColors?: readonly [string, string];
  trailing?: React.ReactNode;
}) {
  const elapsed = useElapsed(startedAt, working, elapsedMs);
  const timer = showTimer ?? (working && (startedAt !== undefined || elapsedMs !== undefined));
  return (
    <div
      data-slot="status-strip"
      data-working={working || undefined}
      role="status"
      aria-live="polite"
      className={cn("flex h-7 min-w-0 items-center gap-2 px-2.5", className)}
      {...props}
    >
      <WorkingAvatar working={working} face={face} ringColors={ringColors} size={20} />
      <span className="min-w-0 truncate text-xs leading-3 font-medium tracking-h-xs text-foreground">{sentence}</span>
      {timer ? (
        <span
          data-slot="status-timer"
          aria-hidden
          className="shrink-0 font-mono text-axis leading-3 text-muted-foreground tabular-nums"
        >
          {formatElapsed(elapsed)}
        </span>
      ) : null}
      {trailing === undefined ? null : <span className="ml-auto flex shrink-0 items-center">{trailing}</span>}
    </div>
  );
}
