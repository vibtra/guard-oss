import * as React from "react";
import {
  BookOpenIcon,
  BrainIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleHelpIcon,
  ClipboardListIcon,
  CodeIcon,
  MinusIcon,
  PlusIcon,
  SaveIcon,
  ScanIcon,
  SearchIcon,
  WrenchIcon,
} from "lucide-react";
import { cn } from "../lib/cn";
import { ShimmerText } from "./shimmer-text";

export type WorkLogKind =
  | "think"
  | "read"
  | "write"
  | "run"
  | "search"
  | "ask"
  | "save"
  | "plan"
  | "error"
  | "tool";

export const WORK_LOG_ICONS: Record<WorkLogKind, React.ComponentType<{ className?: string }>> = {
  think: BrainIcon,
  read: BookOpenIcon,
  write: CodeIcon,
  run: ScanIcon,
  search: SearchIcon,
  ask: CircleHelpIcon,
  save: SaveIcon,
  plan: ClipboardListIcon,
  error: CircleAlertIcon,
  tool: WrenchIcon,
};

export function formatWorkedFor(ms: number, verb = "Worked for"): string {
  const s = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${verb} ${h}h ${m}m`;
  if (m > 0) return `${verb} ${m}m ${sec}s`;
  return `${verb} ${sec}s`;
}

export function formatThoughtFor(ms: number): string {
  const s = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 1000));
  return `Thought for ${s} ${s === 1 ? "second" : "seconds"}`;
}

const PILL =
  "inline-flex h-7 max-w-full min-w-0 items-center gap-1 rounded-full py-1.5 pr-2.5 pl-2 text-left " +
  "text-xs leading-3 font-normal tracking-body-xs text-muted-foreground [&_svg]:size-3 [&_svg]:shrink-0";

function Collapse({ open, id, children }: { open: boolean; id?: string; children: React.ReactNode }) {
  return (
    <div
      id={id}
      data-slot="work-log-collapse"
      data-state={open ? "open" : "closed"}
      aria-hidden={open ? undefined : true}
      inert={open ? undefined : true}
      className={cn("v-expand grid", open ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

export function WorkLog({
  summary,
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  children,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "children"> & {
  summary: React.ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children?: React.ReactNode;
}) {
  const [inner, setInner] = React.useState(defaultOpen);
  const open = openProp ?? inner;
  const bodyId = React.useId();
  const toggle = () => {
    const next = !open;
    if (openProp === undefined) setInner(next);
    onOpenChange?.(next);
  };
  return (
    <div data-slot="work-log" data-state={open ? "open" : "closed"} className={cn("flex flex-col", className)} {...props}>
      <button
        type="button"
        data-slot="work-log-toggle"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className={cn(PILL, "v-hover-tint focus-knox self-start outline-hidden")}
      >
        {open ? <MinusIcon aria-hidden /> : <PlusIcon aria-hidden />}
        <span className="truncate">{summary}</span>
      </button>
      <Collapse open={open} id={bodyId}>
        <div data-slot="work-log-tree" className="relative ml-3.5 flex flex-col pl-2.5">
          <span aria-hidden className="absolute top-0 bottom-3.5 left-0 w-px bg-border" />
          {children}
        </div>
      </Collapse>
    </div>
  );
}

export function WorkLogRow({
  kind,
  icon,
  label,
  children,
  defaultOpen = false,
  className,
  onClick,
  ...props
}: Omit<React.ComponentProps<"button">, "children"> & {
  kind?: WorkLogKind;
  icon?: React.ReactNode;
  label: React.ReactNode;
  children?: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = React.useState(defaultOpen);
  const detailId = React.useId();
  const Glyph = kind === undefined ? null : WORK_LOG_ICONS[kind];
  const expandable = children !== undefined && children !== null;
  return (
    <div data-slot="work-log-row" data-kind={kind} className="relative flex flex-col">
      <span aria-hidden className="absolute top-3.5 -left-2.5 h-px w-2 bg-border" />
      <button
        type="button"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? detailId : undefined}
        onClick={(event) => {
          if (expandable) setOpen((v) => !v);
          onClick?.(event);
        }}
        className={cn(PILL, "v-hover-tint focus-knox self-start outline-hidden", className)}
        {...props}
      >
        {icon !== undefined ? <span aria-hidden className="flex">{icon}</span> : Glyph ? <Glyph aria-hidden /> : null}
        <span className="truncate">{label}</span>
      </button>
      {expandable ? (
        <Collapse open={open} id={detailId}>
          <div className="py-1 pl-6 text-xs text-muted-foreground">{children}</div>
        </Collapse>
      ) : null}
    </div>
  );
}

export function WorkLogProse({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="work-log-prose"
      className={cn("py-1.5 pl-2 text-sm leading-4 text-foreground [&_p]:my-0", className)}
      {...props}
    />
  );
}

export type ThreadStatusTone = "waiting" | "done" | "info" | "error";

export function ThreadStatusRow({
  tone = "info",
  icon,
  children,
  className,
  ...props
}: React.ComponentProps<"div"> & {
  tone?: ThreadStatusTone;
  icon?: React.ReactNode;
}) {
  const glyph =
    icon ??
    (tone === "waiting" ? (
      <CircleHelpIcon aria-hidden />
    ) : tone === "done" ? (
      <CircleCheckIcon aria-hidden className="fill-hue-green-600 text-card" />
    ) : tone === "error" ? (
      <CircleAlertIcon aria-hidden className="text-hue-red-600" />
    ) : null);
  return (
    <div
      data-slot="thread-status-row"
      data-tone={tone}
      role={tone === "waiting" ? "status" : undefined}
      className={cn(PILL, "v-rise-in", className)}
      {...props}
    >
      {glyph === null ? null : <span className="flex">{glyph}</span>}
      {tone === "waiting" ? (
        <ShimmerText className="truncate">{children}</ShimmerText>
      ) : (
        <span className="truncate">{children}</span>
      )}
    </div>
  );
}
