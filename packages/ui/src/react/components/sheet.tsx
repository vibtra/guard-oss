import * as React from "react";
import * as SheetPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;

const sides = {
  right: "inset-y-3 right-3 w-[min(1035px,80vw)] max-w-none rounded-2xl",
  left: "inset-y-3 left-3 w-full max-w-md rounded-2xl",
  top: "inset-x-3 top-3 rounded-2xl",
  bottom: "inset-x-3 bottom-3 rounded-2xl",
} as const;

export function SheetContent({
  className,
  children,
  side = "right",
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & { side?: keyof typeof sides }) {
  const opener = React.useRef<HTMLElement | null>(null);

  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay className="fixed inset-0 z-(--v-z-dialog) backdrop-scrim v-overlay-motion" />
      <SheetPrimitive.Content
        data-slot="sheet-content"
        data-side={side}
        onOpenAutoFocus={(event) => {
          const active = document.activeElement;
          opener.current = active instanceof HTMLElement ? active : null;
          onOpenAutoFocus?.(event);
        }}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const back = opener.current;
          opener.current = null;
          if (event.defaultPrevented || back === null || !back.isConnected) return;
          event.preventDefault();
          back.focus();
        }}
        className={cn(
          "fixed z-(--v-z-dialog) flex flex-col gap-4 overscroll-contain bg-card p-4 shadow-high v-sheet-motion",
          sides[side],
          className,
        )}
        {...props}
      >
        {children}
        <SheetPrimitive.Close asChild>
          <Button variant="ghost" size="icon-sm" className="absolute top-5 right-5 text-foreground" aria-label="Close">
            <XIcon />
          </Button>
        </SheetPrimitive.Close>
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
}

export function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="sheet-header" className={cn("flex flex-col gap-1", className)} {...props} />;
}

export function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn("text-lg font-semibold tracking-h-lg text-foreground", className)}
      {...props}
    />
  );
}

export function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn("text-xs text-muted-foreground", className)}
      {...props}
    />
  );
}
