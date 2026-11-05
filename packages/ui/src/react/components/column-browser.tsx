import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { cn } from "../lib/cn";

export interface ColumnRow {
  id: string;
  label: string;
  icon?: React.ReactNode;
  tag?: string;
  opens?: boolean;
}

export interface BrowserColumn {
  id: string;
  title: string;
  rows?: readonly ColumnRow[];
  open?: string;
  content?: React.ReactNode;
  empty?: string;
  onSelect?: (rowId: string) => void;
}

export function ColumnBrowser({ columns, className }: { columns: readonly BrowserColumn[]; className?: string }) {
  const lastOpen = [...columns].reverse().find((column) => column.open !== undefined)?.id;
  return (
    <div data-slot="column-browser" className={cn("flex min-h-0 flex-1 overflow-x-auto", className)}>
      {columns.map((column) => (
        <section
          key={column.id}
          aria-label={column.title}
          className="flex w-(--v-column-w) shrink-0 flex-col border-r-[0.5px] border-border last:border-r-0"
        >
          <h3 className="flex h-8 shrink-0 items-center truncate px-3 text-xs font-normal tracking-body-xs text-muted-foreground hairline-b">
            {column.title}
          </h3>
          <div className="scrollbar-knox min-h-0 flex-1 overflow-y-auto p-1">
            {column.content ??
              (column.rows === undefined || column.rows.length === 0 ? (
                <p className="px-3 py-2 text-xs tracking-body-xs text-muted-foreground">{column.empty ?? "Nothing here"}</p>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {column.rows.map((row) => {
                    const onPath = column.open === row.id;
                    const selected = onPath && column.id === lastOpen;
                    return (
                      <li key={row.id}>
                        <button
                          type="button"
                          aria-current={onPath ? "true" : undefined}
                          aria-pressed={selected}
                          onClick={() => column.onSelect?.(row.id)}
                          className={cn(
                            "focus-knox flex h-8 w-full min-w-0 items-center gap-2 rounded-lg p-2 text-left text-sm tracking-body-sm outline-hidden",
                            "[&_svg]:size-4 [&_svg]:shrink-0",
                            selected
                              ? "bg-primary text-primary-foreground"
                              : onPath
                                ? "bg-accent text-foreground"
                                : "text-foreground hover:bg-accent",
                          )}
                        >
                          {row.icon}
                          <span className="min-w-0 truncate">{row.label}</span>
                          {row.tag === undefined ? null : (
                            <span
                              className={cn(
                                "shrink-0 text-[11px] leading-[11px] font-book",
                                selected ? "text-primary-foreground" : "text-muted-foreground",
                              )}
                            >
                              {row.tag}
                            </span>
                          )}
                          {row.opens ? <ChevronRightIcon aria-hidden className="ml-auto size-3!" /> : null}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              ))}
          </div>
        </section>
      ))}
    </div>
  );
}
