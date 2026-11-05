import * as React from "react"
import { Dialog as SheetPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Sheet({ ...props }: SheetPrimitive.Root.Props) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger({ ...props }: SheetPrimitive.Trigger.Props) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose({ ...props }: SheetPrimitive.Close.Props) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetPortal({ ...props }: SheetPrimitive.Portal.Props) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />
}

function SheetOverlay({ className, ...props }: SheetPrimitive.Backdrop.Props) {
  return (
    <SheetPrimitive.Backdrop
      data-slot="sheet-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-g-overlay-sheet transition-opacity duration-(--v-motion-ui) ease-(--v-ease-ui) data-ending-style:opacity-0 data-starting-style:opacity-0",
        className
      )}
      {...props}
    />
  )
}

function SheetContent({
  className,
  children,
  side = "right",
  showCloseButton = true,
  ...props
}: SheetPrimitive.Popup.Props & {
  side?: "top" | "right" | "bottom" | "left"
  showCloseButton?: boolean
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      <SheetPrimitive.Popup
        data-slot="sheet-content"
        data-side={side}
        className={cn(
          "fixed z-50 flex flex-col gap-4 overscroll-contain rounded-g-shell border border-g-line bg-g-surface bg-clip-padding text-sm text-g-ink shadow-g-pop transition-[opacity,translate] duration-(--v-motion-panel) ease-(--v-ease-panel) data-ending-style:opacity-0 data-starting-style:opacity-0 data-[side=bottom]:inset-x-3 data-[side=bottom]:bottom-3 data-[side=bottom]:h-auto data-[side=bottom]:data-ending-style:translate-y-[calc(100%+0.75rem)] data-[side=bottom]:data-starting-style:translate-y-[calc(100%+0.75rem)] data-[side=left]:inset-y-3 data-[side=left]:left-3 data-[side=left]:w-3/4 data-[side=left]:data-ending-style:translate-x-[calc(-100%-0.75rem)] data-[side=left]:data-starting-style:translate-x-[calc(-100%-0.75rem)] data-[side=right]:inset-y-3 data-[side=right]:right-3 data-[side=right]:w-[min(1035px,80vw)] data-[side=right]:data-ending-style:translate-x-[calc(100%+0.75rem)] data-[side=right]:data-starting-style:translate-x-[calc(100%+0.75rem)] data-[side=top]:inset-x-3 data-[side=top]:top-3 data-[side=top]:h-auto data-[side=top]:data-ending-style:translate-y-[calc(-100%-0.75rem)] data-[side=top]:data-starting-style:translate-y-[calc(-100%-0.75rem)] data-[side=left]:sm:max-w-sm",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <SheetPrimitive.Close
            data-slot="sheet-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-5 right-5"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </SheetPrimitive.Close>
        )}
      </SheetPrimitive.Popup>
    </SheetPortal>
  )
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-header"
      className={cn("flex flex-col gap-1 p-6 pb-0", className)}
      {...props}
    />
  )
}

function SheetFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn("mt-auto flex flex-row items-center justify-between gap-2 p-6 pt-0 [&>:only-child]:ml-auto", className)}
      {...props}
    />
  )
}

function SheetTitle({ className, ...props }: SheetPrimitive.Title.Props) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn(
        "text-lg font-semibold tracking-h-lg text-foreground",
        className
      )}
      {...props}
    />
  )
}

function SheetDescription({
  className,
  ...props
}: SheetPrimitive.Description.Props) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
}
