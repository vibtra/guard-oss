import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { XIcon } from "lucide-react";
import { cn } from "../lib/cn";

export const Tabs = TabsPrimitive.Root;

export function pillTabClass(active: boolean): string {
  return cn(
    "focus-knox inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 outline-hidden",
    "text-sm font-normal transition-colors duration-(--v-dur-2)",
    "[&_svg]:size-4 [&_svg]:shrink-0",
    active ? "bg-card text-foreground shadow-segment" : "text-secondary-foreground hover:text-foreground",
  );
}

export function SegmentedTabs({
  className,
  ...props
}: React.ComponentProps<"nav">) {
  return (
    <nav
      data-slot="segmented-tabs"
      data-tab-track=""
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-transparent bg-muted p-[3px]",
        className,
      )}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-tab-track=""
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 overflow-x-auto rounded-lg border border-transparent bg-muted p-[3px]",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        "focus-knox inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 outline-hidden",
        "text-sm font-normal text-secondary-foreground transition-colors duration-(--v-dur-2)",
        "[&_svg]:size-4 [&_svg]:shrink-0",
        "hover:text-foreground data-test-hover:text-foreground",
        "data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-segment",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export function TabCount({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="tab-count"
      className={cn(
        "inline-flex items-center text-sm font-normal tabular-nums text-muted-foreground",
        "before:content-['('] after:content-[')']",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content data-slot="tabs-content" className={cn("pt-4", className)} {...props} />;
}

export function SubTabRow({
  className,
  actions,
  children,
  ...props
}: React.ComponentProps<"div"> & { actions?: React.ReactNode }) {
  return (
    <div
      data-slot="sub-tab-row"
      className={cn(
        "flex h-(--v-subtab-row-h) shrink-0 items-center gap-2 bg-card py-2 pr-6 pl-3 hairline-b",
        className,
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">{children}</div>
      {actions === undefined ? null : <div className="flex shrink-0 items-center gap-1">{actions}</div>}
    </div>
  );
}

export function CardTabHead({
  className,
  end,
  children,
  ...props
}: React.ComponentProps<"div"> & { end?: React.ReactNode }) {
  return (
    <div
      data-slot="card-tab-head"
      className={cn("flex h-14 shrink-0 items-center gap-2 px-3", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {end === undefined ? null : <div className="flex shrink-0 items-center gap-2">{end}</div>}
    </div>
  );
}

export function ClosableTab({
  active,
  icon,
  label,
  onSelect,
  onClose,
  closeLabel,
  className,
}: {
  active: boolean;
  icon?: React.ReactNode;
  label: string;
  onSelect?: () => void;
  onClose?: () => void;
  closeLabel?: string;
  className?: string;
}) {
  return (
    <span data-slot="closable-tab" data-active={active} className={cn("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className={cn(
          pillTabClass(active),
          "max-w-60 pr-7 pl-3 [&_svg]:size-4",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {onClose === undefined ? null : (
        <button
          type="button"
          aria-label={closeLabel ?? `Close ${label}`}
          onClick={onClose}
          className="focus-knox absolute top-1.5 right-1.5 inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground [&_svg]:size-3"
        >
          <XIcon aria-hidden />
        </button>
      )}
    </span>
  );
}
