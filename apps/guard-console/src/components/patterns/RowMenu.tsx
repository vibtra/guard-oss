import * as React from "react"
import { EllipsisVerticalIcon, type LucideIcon } from "lucide-react"

import { cn } from "@/components/kit/cn"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface RowMenuItem {
  label: string
  onSelect: () => void
  icon?: LucideIcon
  destructive?: boolean
  separatorBefore?: boolean
  disabled?: boolean
}

export function RowMenu({
  label,
  items,
  align = "end",
  className,
}: {
  label: string
  items: readonly RowMenuItem[]
  align?: "start" | "end"
  className?: string
}) {
  if (items.length === 0) return null
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="row-menu-trigger"
        aria-label={label}
        onClick={(event: React.MouseEvent) => event.stopPropagation()}
        className={cn(
          "focus-knox inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-g-control text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink data-popup-open:bg-g-tint",
          className,
        )}
      >
        <EllipsisVerticalIcon aria-hidden className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} data-slot="row-menu" className="min-w-[200px]">
        {items.map((item) => (
          <React.Fragment key={item.label}>
            {item.separatorBefore === true ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              variant={item.destructive === true ? "destructive" : "default"}
              disabled={item.disabled}
              onClick={(event: React.MouseEvent) => {
                event.stopPropagation()
                item.onSelect()
              }}
            >
              {item.icon === undefined ? null : <item.icon aria-hidden />}
              {item.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
