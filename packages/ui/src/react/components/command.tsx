import * as React from "react";
import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "./dialog";

export function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn("flex size-full flex-col overflow-hidden rounded-lg bg-popover text-foreground", className)}
      {...props}
    />
  );
}

export function CommandDialog({
  title = "Search",
  description = "Search for a page, a space or a project.",
  children,
  ...props
}: React.ComponentProps<typeof Dialog> & { title?: string; description?: string }) {
  return (
    <Dialog {...props}>
      <DialogContent
        motion="palette"
        showClose={false}
        className="top-[150px] max-h-[440px] w-(--v-palette-w) max-w-[min(var(--v-palette-w),calc(100vw-32px))] translate-y-0 overflow-hidden rounded-lg p-0"
        aria-describedby={undefined}
      >
        <span className="sr-only">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </span>
        <Command
          className={cn(
            "max-h-[440px]",
            "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:py-1.5",
            "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-normal",
            "[&_[cmdk-group-heading]]:text-muted-foreground",
          )}
        >
          {children}
        </Command>
      </DialogContent>
    </Dialog>
  );
}

export function CommandInput({
  className,
  variant = "palette",
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & { variant?: "palette" | "menu" }) {
  const menu = variant === "menu";
  return (
    <div
      data-slot="command-input-wrapper"
      data-variant={variant}
      className={cn("flex shrink-0 items-center gap-2 hairline-b", menu ? "h-9 px-3" : "h-10 px-4")}
      cmdk-input-wrapper=""
    >
      <SearchIcon
        aria-hidden
        className={cn("shrink-0", menu ? "size-3 text-muted-foreground" : "size-4 text-foreground")}
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          "flex h-full w-full bg-transparent text-sm font-normal text-foreground outline-hidden",
          "placeholder:text-placeholder disabled:text-ink-disabled",
          className,
        )}
        {...props}
      />
    </div>
  );
}

export function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn("scrollbar-knox min-h-0 flex-1 scroll-py-1 overflow-x-hidden overflow-y-auto p-1", className)}
      {...props}
    />
  );
}

export function CommandEmpty(props: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className="py-8 text-center text-sm text-muted-foreground"
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group data-slot="command-group" className={cn("overflow-hidden", className)} {...props} />
  );
}

export function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

export function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "group/command-item relative flex min-h-9 cursor-default items-center gap-2 rounded-md px-2.5 py-2 text-sm select-none",
        "text-foreground outline-hidden",
        "data-[selected=true]:bg-accent",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:text-ink-disabled",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export function CommandShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="command-shortcut"
      className={cn(
        "ml-auto inline-flex items-center gap-1 font-mono text-tag text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CommandFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="command-footer"
      className={cn(
        "flex h-10 shrink-0 items-center gap-2 hairline-t px-3 text-tag font-medium tracking-body-xs text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
