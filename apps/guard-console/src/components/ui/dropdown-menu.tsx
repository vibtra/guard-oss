"use client"

import * as React from "react"
import { Menu as MenuPrimitive } from "@base-ui/react/menu"

import { cn } from "@/components/kit/cn"
import { CheckboxTick, checkboxBoxClass } from "@/components/kit/Checkbox"
import { ChevronRightIcon, CheckIcon, SearchIcon } from "lucide-react"

const MENU_ITEM =
  "relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-14 text-g-ink outline-hidden focus-knox [--v-focus-offset:-2px] data-highlighted:bg-g-tint data-inset:ps-8 data-disabled:pointer-events-none data-disabled:text-ink-disabled [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"

function DropdownMenu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />
}

function DropdownMenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  className,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<
    MenuPrimitive.Positioner.Props,
    "align" | "alignOffset" | "side" | "sideOffset"
  >) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn("scrollbar-knox z-50 max-h-(--available-height) flex min-w-48 flex-col gap-0 origin-(--transform-origin) overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border border-g-divider bg-g-surface p-1 text-g-ink shadow-g-pop outline-none v-popup-motion data-ending-style:duration-(--g-dur-fast) data-closed:overflow-hidden", className)}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  )
}

function DropdownMenuGroup({ ...props }: MenuPrimitive.Group.Props) {
  return <MenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: MenuPrimitive.GroupLabel.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn(
        "px-2 py-1.5 text-12 font-medium text-g-muted data-inset:ps-8",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  ...props
}: MenuPrimitive.Item.Props & {
  inset?: boolean
  variant?: "default" | "destructive"
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        MENU_ITEM,
        "group/dropdown-menu-item data-[variant=destructive]:text-g-danger data-[variant=destructive]:*:[svg]:text-g-danger",
        className
      )}
      {...props}
    />
  )
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        MENU_ITEM,
        "data-popup-open:bg-g-tint",
        className
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon aria-hidden className="ms-auto size-3.5 text-g-muted rtl:-scale-x-100" />
    </MenuPrimitive.SubmenuTrigger>
  )
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -4,
  side = "right",
  sideOffset = 6,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn("w-auto min-w-48", className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  )
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  indicator = "trailing",
  ...props
}: MenuPrimitive.CheckboxItem.Props & {
  inset?: boolean
  indicator?: "trailing" | "checkbox"
}) {
  const box = indicator === "checkbox"
  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      data-indicator={indicator}
      className={cn(
        MENU_ITEM,
        box ? "pe-2" : "pe-8",
        className
      )}
      checked={checked}
      {...props}
    >
      {box ? (
        <span
          aria-hidden
          data-slot="dropdown-menu-checkbox-box"
          data-checked={checked ? "" : undefined}
          className={checkboxBoxClass(checked === true)}
        >
          <CheckboxTick checked={checked === true} />
        </span>
      ) : (
        <span
          className="pointer-events-none absolute end-2 flex items-center justify-center"
          data-slot="dropdown-menu-checkbox-item-indicator"
        >
          <MenuPrimitive.CheckboxItemIndicator>
            <CheckIcon
            />
          </MenuPrimitive.CheckboxItemIndicator>
        </span>
      )}
      {children}
    </MenuPrimitive.CheckboxItem>
  )
}

function DropdownMenuRadioGroup({ ...props }: MenuPrimitive.RadioGroup.Props) {
  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      {...props}
    />
  )
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: MenuPrimitive.RadioItem.Props & {
  inset?: boolean
}) {
  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        MENU_ITEM,
        "pe-8",
        className
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute end-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon
          />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  )
}

function DropdownMenuSeparator({
  className,
  ...props
}: MenuPrimitive.Separator.Props) {
  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-menu-separator", className)}
      {...props}
    />
  )
}

function DropdownMenuShortcut({
  className,
  ...props
}: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ms-auto inline-flex items-center gap-1 font-mono text-xs text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}


function DropdownMenuSectionLabel({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      role="presentation"
      data-slot="dropdown-menu-section-label"
      className={cn("px-2 pt-3 pb-1.5 text-xs font-medium text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuTwoLineItem({
  className,
  icon,
  title,
  meta,
  current,
  ...props
}: Omit<MenuPrimitive.Item.Props, "title" | "children"> & {
  icon?: React.ReactNode
  title: React.ReactNode
  meta?: React.ReactNode
  current?: boolean
}) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-two-line-item"
      aria-current={current || undefined}
      className={cn(MENU_ITEM, "group/dropdown-menu-item min-h-(--v-menu-row-two-h) items-start", className)}
      {...props}
    >
      {icon === undefined ? null : <span className="mt-0.5 flex shrink-0 [&_svg]:size-4">{icon}</span>}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-14 tabular-nums">{title}</span>
        {meta === undefined ? null : (
          <span className="truncate text-xs text-muted-foreground">{meta}</span>
        )}
      </span>
      {current ? <CheckIcon aria-hidden className="mt-0.5 size-3 shrink-0" /> : null}
    </MenuPrimitive.Item>
  )
}

function DropdownMenuHint({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="dropdown-menu-hint"
      className={cn("ms-auto font-mono text-xs leading-none text-muted-foreground", className)}
      {...props}
    />
  )
}

function DropdownMenuSearchHead({
  className,
  value,
  onValueChange,
  placeholder,
  label,
}: {
  className?: string
  value: string
  onValueChange: (value: string) => void
  placeholder: string
  label?: string
}) {
  return (
    <div
      data-slot="dropdown-menu-search-head"
      className={cn("-mx-1 -mt-1 mb-1 flex h-10 shrink-0 items-center gap-2 px-3 hairline-b", className)}
    >
      <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <input
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Escape") event.stopPropagation()
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-sm font-normal text-foreground outline-hidden placeholder:text-placeholder"
      />
    </div>
  )
}

export {
  DropdownMenuSectionLabel,
  DropdownMenuTwoLineItem,
  DropdownMenuHint,
  DropdownMenuSearchHead,
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
}
