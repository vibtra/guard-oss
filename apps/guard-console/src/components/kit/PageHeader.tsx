import * as React from "react";
import { cn } from "@/components/kit/cn";

export function PageHeader({
  tabs,
  actions,
  className,
  children,
}: {
  tabs?: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div data-slot="page-header" className={cn("mb-6 flex flex-col gap-4", tabs !== undefined && "-mt-2", className)}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center max-md:basis-full">{tabs}</div>
        {actions === undefined ? null : <div className="flex shrink-0 items-center gap-2 max-md:ms-auto">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

const COLUMNS: Readonly<Record<2 | 3 | 4, string>> = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-2 lg:grid-cols-4",
};

export function StatRow({ className, children, label }: { className?: string; children: React.ReactNode; label: string }) {
  const count = Math.min(4, Math.max(2, React.Children.toArray(children).filter(Boolean).length)) as 2 | 3 | 4;
  return (
    <dl
      aria-label={label}
      data-slot="stat-row"
      className={cn(
        "mb-6 grid grid-cols-1 md:gap-4",
        "max-md:divide-y max-md:divide-g-line max-md:overflow-hidden max-md:rounded-g-card max-md:border max-md:border-g-line",
        COLUMNS[count],
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function StatCard({
  label,
  value,
  delta,
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode | undefined;
  delta?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="stat-card"
      className={cn(
        "flex min-w-0 bg-g-surface",
        "max-md:items-center max-md:justify-between max-md:gap-4 max-md:px-4 max-md:py-3.5",
        "md:flex-col md:gap-1 md:rounded-g-stat md:border md:border-g-line-card md:p-4",
        className,
      )}
    >
      <dt className="min-w-0 truncate text-14 font-medium text-g-lead">{label}</dt>
      <dd className="flex min-w-0 flex-col md:gap-1">
        <span className="text-24 font-medium tabular-nums text-g-ink-strong max-md:text-end">{value ?? "—"}</span>
        {delta === undefined ? null : <span className="text-12 text-g-muted max-md:hidden">{delta}</span>}
      </dd>
    </div>
  );
}
