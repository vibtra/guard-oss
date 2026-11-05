import * as React from "react";
import { ArrowUpIcon, ListFilterIcon } from "lucide-react";
import { cn } from "../lib/cn";

export type TableDensity = "default" | "list" | "compact" | "card" | "log" | "comfortable" | "grid";

type Shape = "list" | "card" | "log" | "grid";

const shapeOf = (density: TableDensity): Shape =>
  density === "compact" || density === "card"
    ? "card"
    : density === "log"
      ? "log"
      : density === "grid"
        ? "grid"
        : "list";

const GRID_CELL = "shadow-[inset_-0.5px_-0.5px_0_0_var(--border)]";

const DensityContext = React.createContext<Shape>("list");
const StickyContext = React.createContext(false);

const HAIRLINE = "shadow-[0_1px_0_0_var(--border)]";
const BleedContext = React.createContext(false);

export function Table({
  className,
  density = "default",
  stickyHead = false,
  bleed = false,
  ...props
}: React.ComponentProps<"table"> & { density?: TableDensity; stickyHead?: boolean; bleed?: boolean }) {
  const shape = shapeOf(density);
  return (
    <DensityContext.Provider value={shape}>
      <StickyContext.Provider value={stickyHead}>
      <BleedContext.Provider value={bleed && shape !== "card"}>
      <div
        data-slot="table-container"
        data-density={density}
        data-sticky-head={stickyHead ? "" : undefined}
        data-bleed={bleed && shape !== "card" ? "" : undefined}
        className={cn(
          "relative w-full",
          bleed && shape !== "card" && "-mr-(--v-content-pad-r) -ml-(--v-content-pad) w-auto",
          stickyHead ? "overflow-x-clip" : "overflow-x-auto",
          shape === "card" ? "rounded-xl border border-border bg-card" : "bg-transparent",
        )}
      >
        <table
          data-slot="table"
          className={cn("w-full caption-bottom border-collapse text-sm", className)}
          {...props}
        />
      </div>
      </BleedContext.Provider>
      </StickyContext.Provider>
    </DensityContext.Provider>
  );
}

export function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  const sticky = React.useContext(StickyContext);
  const shape = React.useContext(DensityContext);
  return (
    <thead
      data-slot="table-header"
      className={cn(
        sticky ? cn("sticky top-0 z-10", shape === "card" ? "bg-card" : "bg-background") : "bg-transparent",
        className,
      )}
      {...props}
    />
  );
}

export function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("v-content-in", className)} {...props} />;
}

export function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("bg-muted font-medium", className)} {...props} />;
}

export function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  const shape = React.useContext(DensityContext);
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "group/row transition-colors duration-(--v-dur-1) ease-linear",
        shape !== "grid" && HAIRLINE,
        shape === "card" && "last:shadow-none",
        "hover:bg-row-hover data-test-hover:bg-row-hover",
        "data-[state=selected]:bg-row-selected",
        className,
      )}
      {...props}
    />
  );
}

const EDGE_PAD = {
  list: "first:pl-4 last:pr-4",
  bleed: "first:pl-(--v-content-pad) last:pr-(--v-content-pad-r)",
  card: "first:pl-4 last:pr-4",
} as const;

export function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  const shape = React.useContext(DensityContext);
  const bleed = React.useContext(BleedContext);
  return (
    <th
      data-slot="table-head"
      scope="col"
      className={cn(
        shape === "grid"
          ? "h-9 bg-background px-4 pb-0.5 text-xs font-normal text-muted-foreground shadow-[inset_-0.5px_0.5px_0_0_var(--border),inset_0_-0.5px_0_0_var(--border)]"
          : cn(
              shape === "log" ? "h-(--v-log-th-h)" : "h-(--v-table-th-h)",
              "px-4 py-3.5 text-sm font-medium text-foreground",
              HAIRLINE,
              shape === "card" ? EDGE_PAD.card : bleed ? EDGE_PAD.bleed : EDGE_PAD.list,
            ),
        "text-left align-middle whitespace-nowrap",
        "[&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  );
}

export function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  const shape = React.useContext(DensityContext);
  const bleed = React.useContext(BleedContext);
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "align-middle text-sm font-normal",
        shape !== "grid" && cn("px-4 py-3.5", shape === "card" ? EDGE_PAD.card : bleed ? EDGE_PAD.bleed : EDGE_PAD.list),
        shape === "list" && "h-(--v-table-td-h-compact)",
        shape === "card" && "h-(--v-table-td-h-compact)",
        shape === "log" && "h-(--v-log-td-h) text-muted-foreground",
        shape === "grid" && cn("h-9 px-4", GRID_CELL),
        className,
      )}
      {...props}
    />
  );
}

export function TableHeadFilter({
  className,
  label,
  active = false,
  ...props
}: React.ComponentProps<"button"> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      data-slot="table-head-filter"
      data-active={active ? "" : undefined}
      aria-label={label}
      className={cn(
        "focus-knox ml-1 inline-flex size-6 items-center justify-center rounded-md align-middle text-muted-foreground",
        "transition-colors duration-(--v-dur-2) hover:bg-accent hover:text-foreground aria-expanded:bg-accent",
        active && "text-foreground",
        className,
      )}
      {...props}
    >
      <ListFilterIcon aria-hidden className="size-4" />
    </button>
  );
}

export function TableMenuHead({ className, label = "Actions", ...props }: React.ComponentProps<"th"> & { label?: string }) {
  return (
    <TableHead className={cn("w-14", className)} {...props}>
      <span className="sr-only">{label}</span>
    </TableHead>
  );
}

export function TableMenuCell({ className, ...props }: React.ComponentProps<"td">) {
  return <TableCell data-slot="table-menu-cell" className={cn("w-14 py-0 text-right", className)} {...props} />;
}

export function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-xs text-muted-foreground", className)} {...props} />;
}

export function TableIndexCell({ className, ...props }: React.ComponentProps<"td">) {
  return (
    <td
      data-slot="table-index-cell"
      className={cn(
        "h-9 w-9 px-0 text-center align-middle font-mono text-xs text-muted-foreground",
        GRID_CELL,
        className,
      )}
      {...props}
    />
  );
}

export function TableHeadPill({
  className,
  sorted,
  children,
  ...props
}: React.ComponentProps<"span"> & { sorted?: "asc" | "desc" }) {
  return (
    <span
      data-slot="table-head-pill"
      className={cn(
        "-ml-2 inline-flex h-6 items-center gap-1 rounded-md py-1 pr-1.5 pl-2",
        "text-sm font-medium text-foreground hover:bg-accent",
        className,
      )}
      {...props}
    >
      {children}
      {sorted === undefined ? null : (
        <ArrowUpIcon aria-hidden className={cn("size-3", sorted === "desc" && "rotate-180")} />
      )}
    </span>
  );
}

export function FieldValueTable({
  className,
  fieldLabel = "Field",
  valueLabel = "Value",
  fieldWidth = 183,
  children,
  ...props
}: React.ComponentProps<"table"> & { fieldLabel?: string; valueLabel?: string; fieldWidth?: number }) {
  return (
    <div
      data-slot="field-table"
      className="overflow-hidden rounded-xl border border-border bg-transparent"
    >
      <table className={cn("w-full border-collapse", className)} {...props}>
        <thead>
          <tr className="bg-muted">
            <th
              scope="col"
              style={{ width: fieldWidth }}
              className="border-r border-border px-3 py-3 text-left text-sm font-medium text-foreground"
            >
              {fieldLabel}
            </th>
            <th scope="col" className="px-3 py-3 text-left text-sm font-medium text-foreground">
              {valueLabel}
            </th>
          </tr>
        </thead>
        <tbody className="bg-transparent">{children}</tbody>
      </table>
    </div>
  );
}

export function FieldValueRow({
  field,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"tr">, "children"> & { field: React.ReactNode; children?: React.ReactNode }) {
  return (
    <tr data-slot="field-row" className={cn("border-t border-border", className)} {...props}>
      <th
        scope="row"
        className="border-r border-border px-3 py-3 text-left align-top text-sm font-medium text-foreground"
      >
        {field}
      </th>
      <td className="px-3 py-3 align-top text-sm text-foreground">{children}</td>
    </tr>
  );
}
