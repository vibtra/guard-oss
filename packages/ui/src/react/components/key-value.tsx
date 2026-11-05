import * as React from "react";
import { cn } from "../lib/cn";

export interface KeyValueRow {
  key: string;
  value: React.ReactNode;
  mono?: boolean;
}

export function KeyValueList({
  rows,
  className,
  label,
}: {
  rows: readonly KeyValueRow[];
  className?: string;
  label?: string;
}) {
  return (
    <dl data-slot="key-value-list" aria-label={label} className={cn("flex flex-col p-3", className)}>
      {rows.map((row) => (
        <div key={row.key} className="flex min-h-6 items-center justify-between gap-4">
          <dt className="shrink-0 text-sm tracking-body-sm text-muted-foreground">{row.key}</dt>
          <dd
            className={cn(
              "min-w-0 truncate text-right text-sm tracking-body-sm text-foreground",
              row.mono && "font-mono text-code",
            )}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
