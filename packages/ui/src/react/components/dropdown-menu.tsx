import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { CheckIcon, ChevronRightIcon, InfoIcon, SearchIcon } from "lucide-react";
import { cn } from "../lib/cn";

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

const surface = [
  "z-(--v-z-popover) flex min-w-48 flex-col gap-0 overflow-hidden rounded-lg border border-border",
  "bg-popover p-1 text-sm text-foreground shadow-low",
  "v-menu-motion overscroll-contain",
];

const item = [
  "group/menu-item relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm select-none",
  "text-foreground outline-hidden",
  "data-[highlighted]:bg-accent data-test-hover:bg-accent",
  "data-[disabled]:pointer-events-none data-[disabled]:text-ink-disabled",
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
];

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(surface, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  tone,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & { tone?: "danger" }) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(item, tone === "danger" && "text-danger-ink [&_svg]:text-danger-solid", className)}
      {...props}
    />
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(item, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CheckIcon className="size-4" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(item, "pl-8", className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <span className="size-2 rounded-full bg-primary" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-menu-separator", className)}
      {...props}
    />
  );
}

export function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn("ml-auto inline-flex items-center gap-1 font-mono text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(item, "data-[state=open]:bg-accent", className)}
      {...props}
    >
      {children}
      <ChevronRightIcon className="ml-auto size-3 text-muted-foreground" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn(surface, className)}
      {...props}
    />
  );
}

export function DropdownMenuSectionLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-section-label"
      className={cn("px-2 pt-3 pb-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuTwoLineItem({
  className,
  icon,
  title,
  meta,
  current,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Item>, "title" | "children"> & {
  icon?: React.ReactNode;
  title: React.ReactNode;
  meta?: React.ReactNode;
  current?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-two-line-item"
      aria-current={current || undefined}
      className={cn(item, "min-h-(--v-menu-row-two-h) items-start", className)}
      {...props}
    >
      {icon === undefined ? null : <span className="mt-0.5 flex shrink-0 [&_svg]:size-4">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm tabular-nums">{title}</span>
        {meta === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        )}
      </span>
      {current ? <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0" /> : null}
    </DropdownMenuPrimitive.Item>
  );
}

export function DropdownMenuSwitchItem({
  className,
  label,
  info,
  checked,
  onCheckedChange,
  ...props
}: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>, "children"> & {
  label: React.ReactNode;
  info?: string;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-switch-item"
      checked={checked}
      onCheckedChange={onCheckedChange}
      onSelect={(event) => event.preventDefault()}
      className={cn(item, "min-h-(--v-menu-row-switch-h)", className)}
      {...props}
    >
      <span className="truncate">{label}</span>
      {info === undefined ? null : (
        <span title={info} className="inline-flex text-muted-foreground">
          <InfoIcon aria-hidden className="size-3" />
        </span>
      )}
      <span
        aria-hidden
        data-state={checked === true ? "on" : "off"}
        className={cn(
          "ml-auto inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors duration-(--v-dur-2)",
          checked === true ? "bg-switch-on" : "bg-switch-off",
        )}
      >
        <span
          className={cn(
            "size-5 rounded-full bg-card shadow-xs transition-transform duration-(--v-dur-2)",
            checked === true && "translate-x-4",
          )}
        />
      </span>
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuHint({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-hint"
      className={cn("ml-auto font-mono text-xs leading-none text-muted-foreground", className)}
      {...props}
    />
  );
}

export function DropdownMenuSearchHead({
  className,
  value,
  onValueChange,
  placeholder,
  label,
}: {
  className?: string;
  value: string;
  onValueChange: (value: string) => void;
  placeholder: string;
  label?: string;
}) {
  return (
    <div
      data-slot="dropdown-menu-search-head"
      className={cn("-mx-1 -mt-1 mb-1 flex h-9 shrink-0 items-center gap-2 px-3 hairline-b", className)}
    >
      <SearchIcon aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") event.stopPropagation();
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm font-normal text-foreground outline-hidden placeholder:text-placeholder"
      />
    </div>
  );
}
