import * as React from "react";
import { ArrowDownIcon, ArrowUpDownIcon, ArrowUpIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import { RowMenu, type RowMenuItem } from "@/components/patterns/RowMenu";
import { motionMs } from "@/shell/useClosingState";

export const EMPTY = "—";

export interface CellContext<Row> {
  depth: number;
  parent?: Row;
  expanded: boolean;
}

export interface DataColumn<Row> {
  id: string;
  header: React.ReactNode;
  cell: (row: Row, context: CellContext<Row>) => React.ReactNode;
  width?: string;
  align?: "start" | "end" | "center";
  sort?: "asc" | "desc" | false;
  onSort?: () => void;
}

const typingTarget = (event: React.SyntheticEvent, row: HTMLElement): boolean => {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const control = target.closest("button, a, input, select, textarea, label, [role='menuitem'], [role='combobox'], [role='checkbox'], [role='switch'], [data-row-stop]");
  return control !== null && control !== row && row.contains(control);
};

const without = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => {
  const next = new Set(set);
  next.delete(key);
  return next;
};
const adding = (set: ReadonlySet<string>, key: string): ReadonlySet<string> => new Set(set).add(key);

function ChildCell({ animate, closing, className, children }: { animate: boolean; closing: boolean; className: string; children: React.ReactNode }) {
  if (!animate) return <div className={className}>{children}</div>;
  return (
    <div className="g-expand" data-closing={closing ? "" : undefined}>
      <div>
        <div className={className}>{children}</div>
      </div>
    </div>
  );
}

export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  onRowClick,
  rowLabel,
  rowMenu,
  menuLabel,
  subRows,
  defaultExpanded,
  expandLabel,
  empty,
  minWidth = 720,
  label,
  className,
}: {
  columns: readonly DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  onRowClick?: (row: Row) => void;
  rowLabel?: (row: Row) => string;
  rowMenu?: (row: Row) => readonly RowMenuItem[];
  menuLabel?: (row: Row) => string;
  subRows?: (row: Row) => readonly Row[] | undefined;
  defaultExpanded?: readonly string[];
  expandLabel?: (row: Row, expanded: boolean) => string;
  empty?: React.ReactNode;
  minWidth?: number;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set(defaultExpanded ?? []));
  const [closing, setClosing] = React.useState<ReadonlySet<string>>(() => new Set());
  const [touched, setTouched] = React.useState<ReadonlySet<string>>(() => new Set());
  const timers = React.useRef(new Map<string, number>());
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = React.useState<"none" | "more" | "end">("none");
  const hasMenu = rowMenu !== undefined;
  const trailingOpen = onRowClick !== undefined && !hasMenu;
  const colCount = columns.length + (hasMenu || trailingOpen ? 1 : 0);

  React.useEffect(() => {
    const node = scrollRef.current;
    if (node === null) return undefined;
    const check = () => {
      const max = node.scrollWidth - node.clientWidth;
      if (max <= 1) setOverflow("none");
      else setOverflow(Math.abs(node.scrollLeft) >= max - 1 ? "end" : "more");
    };
    check();
    node.addEventListener("scroll", check, { passive: true });
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
    observer?.observe(node);
    return () => {
      node.removeEventListener("scroll", check);
      observer?.disconnect();
    };
  }, []);

  React.useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
    };
  }, []);

  const toggle = (key: string) => {
    setTouched((was) => adding(was, key));
    const pending = timers.current.get(key);
    if (pending !== undefined) {
      window.clearTimeout(pending);
      timers.current.delete(key);
    }
    if (open.has(key)) {
      setOpen((was) => without(was, key));
      setClosing((was) => adding(was, key));
      timers.current.set(
        key,
        window.setTimeout(() => {
          timers.current.delete(key);
          setClosing((was) => without(was, key));
        }, motionMs("--g-dur-exit")),
      );
    } else {
      setClosing((was) => without(was, key));
      setOpen((was) => adding(was, key));
    }
  };

  const alignClass = (align: DataColumn<Row>["align"]) => (align === "end" ? "text-end" : align === "center" ? "text-center" : "text-start");
  const overflowing = overflow !== "none";
  const stickyRule = overflowing && "shadow-[inset_1px_0_0_var(--g-line)] rtl:shadow-[inset_-1px_0_0_var(--g-line)]";

  const renderRow = (row: Row, depth: number, parent: Row | undefined, shrinking: boolean, animate: boolean): React.ReactNode => {
    const key = rowKey(row);
    const children = depth === 0 ? subRows?.(row) : undefined;
    const expandable = children !== undefined && children.length > 0;
    const expanded = expandable && open.has(key);
    const drawChildren = expandable && (expanded || closing.has(key));
    const context: CellContext<Row> = { depth, expanded, ...(parent === undefined ? {} : { parent }) };
    const clickable = onRowClick !== undefined || expandable;
    const activate = () => {
      if (onRowClick !== undefined) onRowClick(row);
      else if (expandable) toggle(key);
    };
    const name = rowLabel?.(row);
    const openButton = (content: React.ReactNode, kind: "cell" | "chevron") => (
      <button
        type="button"
        data-row-open=""
        aria-label={name ?? (kind === "chevron" ? "Open" : undefined)}
        onClick={(event) => {
          event.stopPropagation();
          onRowClick?.(row);
        }}
        className={
          kind === "chevron"
            ? "focus-knox inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-g-control text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink"
            : "focus-knox -m-1 flex min-w-0 cursor-pointer rounded-md p-1 text-start outline-hidden"
        }
      >
        {content}
      </button>
    );
    const items = rowMenu?.(row) ?? [];
    const pad = depth > 0 ? "py-3" : "py-3.5";
    const childCell = (index: number, column: DataColumn<Row>, content: React.ReactNode) => (
      <td key={column.id} className={cn("p-0 align-middle text-14 text-g-ink", alignClass(column.align))}>
        <ChildCell animate={animate} closing={shrinking} className={cn("px-4", pad, index === 0 && "ps-[76px]")}>
          {content}
        </ChildCell>
      </td>
    );
    return (
      <React.Fragment key={`${depth}:${key}`}>
        <tr
          data-slot="data-row"
          data-depth={depth}
          data-expanded={expanded ? "" : undefined}
          onClick={(event) => {
            if (!clickable || typingTarget(event, event.currentTarget)) return;
            activate();
          }}
          className={cn(
            "group/row border-t border-g-divider transition-[background-color] duration-(--g-dur-fast) ease-g first:border-t-0",
            depth > 0 ? "bg-g-header" : expanded ? "bg-g-hover" : "bg-g-surface",
            clickable && "cursor-pointer hover:bg-g-hover",
            "has-[[data-row-open]:focus-visible]:bg-g-hover",
          )}
        >
          {columns.map((column, index) => {
            const content = column.cell(row, context);
            const opener = index === 0 && onRowClick !== undefined && hasMenu ? openButton(content, "cell") : content;
            if (depth > 0) return childCell(index, column, opener);
            return (
              <td key={column.id} className={cn("px-4 align-middle text-14 text-g-ink", pad, alignClass(column.align))}>
                {index === 0 && expandable ? (
                  <span className="flex min-w-0 items-center gap-2">
                    <button
                      type="button"
                      aria-label={expandLabel?.(row, expanded) ?? (expanded ? "Collapse" : "Expand")}
                      aria-expanded={expanded}
                      onClick={(event) => {
                        event.stopPropagation();
                        toggle(key);
                      }}
                      className="focus-knox -ms-1.5 inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink"
                    >
                      <ChevronRightIcon aria-hidden className={cn("size-3.5 transition-[rotate] duration-(--g-dur) ease-g rtl:-scale-x-100", expanded && "rotate-90 rtl:-rotate-90")} />
                    </button>
                    <span className="min-w-0 flex-1">{opener}</span>
                  </span>
                ) : (
                  opener
                )}
              </td>
            );
          })}
          {hasMenu ? (
            <td data-slot="row-menu-cell" data-row-stop="" className={cn("sticky end-0 w-14 border-t border-g-divider bg-inherit text-end group-first/row:border-t-0", depth > 0 ? "p-0" : "px-3 py-2", stickyRule)}>
              {depth > 0 ? (
                <ChildCell animate={animate} closing={shrinking} className="px-3 py-1.5">
                  <RowMenu label={menuLabel?.(row) ?? "Actions"} items={items} />
                </ChildCell>
              ) : (
                <RowMenu label={menuLabel?.(row) ?? "Actions"} items={items} />
              )}
            </td>
          ) : trailingOpen ? (
            <td data-slot="row-open-cell" className={cn("w-12 text-end", depth > 0 ? "p-0" : "pe-3 ps-1 py-2")}>
              {depth > 0 ? (
                <ChildCell animate={animate} closing={shrinking} className="pe-3 ps-1 py-1.5">
                  {openButton(<ChevronRightIcon aria-hidden className="size-4 rtl:-scale-x-100" />, "chevron")}
                </ChildCell>
              ) : (
                openButton(<ChevronRightIcon aria-hidden className="size-4 rtl:-scale-x-100" />, "chevron")
              )}
            </td>
          ) : null}
        </tr>
        {drawChildren ? children?.map((child) => renderRow(child, depth + 1, row, !expanded, touched.has(key))) : null}
      </React.Fragment>
    );
  };

  return (
    <div
      ref={scrollRef}
      data-slot="data-table"
      data-overflow={overflowing ? overflow : undefined}
      className={cn(
        "g-enter scrollbar-knox relative w-full overflow-x-auto rounded-g-card border border-g-line bg-g-surface",
        !hasMenu &&
          "data-[overflow=more]:[mask-image:linear-gradient(to_right,black_calc(100%-32px),transparent)] rtl:data-[overflow=more]:[mask-image:linear-gradient(to_left,black_calc(100%-32px),transparent)]",
        className,
      )}
    >
      <table aria-label={label} className="w-full border-collapse" style={{ minWidth }}>
        <colgroup>
          {columns.map((column) => (
            <col key={column.id} style={column.width === undefined ? undefined : { width: column.width }} />
          ))}
          {hasMenu ? <col style={{ width: 56 }} /> : trailingOpen ? <col style={{ width: 48 }} /> : null}
        </colgroup>
        <thead>
          <tr className="h-[35px] border-b border-g-line bg-g-header">
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-sort={column.sort === "asc" ? "ascending" : column.sort === "desc" ? "descending" : undefined}
                className={cn("px-4 text-12 font-medium whitespace-nowrap text-g-nav", alignClass(column.align))}
              >
                {column.onSort === undefined ? (
                  column.header
                ) : (
                  <button
                    type="button"
                    onClick={column.onSort}
                    className="focus-knox -mx-1 inline-flex cursor-pointer items-center gap-1 rounded-md px-1 outline-hidden transition-[color] duration-(--g-dur) ease-g hover:text-g-ink"
                  >
                    {column.header}
                    {column.sort === "asc" ? (
                      <ArrowUpIcon aria-hidden className="size-3.5" />
                    ) : column.sort === "desc" ? (
                      <ArrowDownIcon aria-hidden className="size-3.5" />
                    ) : (
                      <ArrowUpDownIcon aria-hidden className="size-3.5 opacity-60" />
                    )}
                  </button>
                )}
              </th>
            ))}
            {hasMenu ? (
              <th scope="col" className={cn("sticky end-0 bg-g-header px-3", stickyRule)}>
                <span className="sr-only">Actions</span>
              </th>
            ) : trailingOpen ? (
              <th scope="col" className="px-1">
                <span className="sr-only">Open</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount}>{empty}</td>
            </tr>
          ) : (
            rows.map((row) => renderRow(row, 0, undefined, false, false))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function CellTitle({
  icon,
  title,
  sub,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <span data-slot="cell-title" className={cn("flex min-w-0 items-center gap-3", className)}>
      {icon}
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-14 font-medium text-g-ink">{title}</span>
        {sub === undefined || sub === null ? null : <span className="truncate text-13 text-g-muted">{sub}</span>}
      </span>
    </span>
  );
}
