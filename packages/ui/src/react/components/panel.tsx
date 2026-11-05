import * as React from "react";
import { ChevronDownIcon } from "lucide-react";
import { cn } from "../lib/cn";

export function Panel({
  className,
  inset = false,
  pad = "none",
  ...props
}: React.ComponentProps<"div"> & {
  inset?: boolean;
  pad?: "none" | "stats" | "prose" | "list";
}) {
  return (
    <div
      data-slot="panel"
      className={cn(
        "relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-xl border-[0.5px] border-border bg-background",
        inset && "mx-(--v-panel-inset) mb-(--v-panel-inset)",
        pad === "stats" && "px-[33px] py-8",
        pad === "prose" && "p-6",
        pad === "list" && "p-3",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHead({
  className,
  actions,
  children,
  ...props
}: React.ComponentProps<"div"> & { actions?: React.ReactNode }) {
  return (
    <div
      data-slot="panel-head"
      className={cn("flex h-(--v-panel-head-h) shrink-0 items-center gap-2 p-2 hairline-b", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-0.5">{actions}</div>}
    </div>
  );
}

export function PanelHeadTrigger({
  className,
  icon,
  children,
  chevron = true,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode; chevron?: boolean }) {
  return (
    <button
      type="button"
      data-slot="panel-head-trigger"
      className={cn(
        "focus-knox inline-flex h-6 max-w-full min-w-0 items-center gap-1.5 rounded-full px-2 py-1 outline-hidden",
        "text-xs font-medium tracking-h-xs text-foreground hover:bg-accent data-[state=open]:bg-accent data-popup-open:bg-accent",
        "[&_svg]:size-3 [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="truncate">{children}</span>
      {chevron ? <ChevronDownIcon aria-hidden className="text-muted-foreground" /> : null}
    </button>
  );
}

export function PanelBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="panel-body"
      className={cn("scrollbar-knox min-h-0 flex-1 overflow-y-auto", className)}
      {...props}
    />
  );
}

export function SplitPanes({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="split-panes"
      className={cn("grid min-h-0 flex-1 grid-cols-2 gap-3 px-(--v-panel-inset) pb-(--v-panel-inset)", className)}
      {...props}
    />
  );
}
