import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;
export const DialogPortal = DialogPrimitive.Portal;

export function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn("fixed inset-0 z-(--v-z-dialog) backdrop-scrim v-overlay-motion", className)}
      {...props}
    />
  );
}

export function menuOrigin(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const menu = document.activeElement?.closest('[role="menu"]');
  if (menu === null || menu === undefined) return null;
  const label = menu.getAttribute("aria-labelledby");
  const byLabel = label === null ? null : document.getElementById(label);
  return byLabel ?? document.querySelector<HTMLElement>('[aria-haspopup="menu"][aria-expanded="true"]');
}

function openerOf(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function DialogContent({
  className,
  children,
  showClose = true,
  size = "md",
  motion = "dialog",
  ref,
  onCloseAutoFocus,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showClose?: boolean;
  size?: "md" | "lg";
  motion?: "dialog" | "palette";
}) {
  const palette = motion === "palette";
  const origin = React.useRef<HTMLElement | null>(null);
  const callerRef = React.useRef(ref);
  React.useLayoutEffect(() => {
    callerRef.current = ref;
  });
  const setRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node !== null) origin.current = menuOrigin() ?? openerOf();
    const target = callerRef.current;
    if (typeof target === "function") target(node);
    else if (target) target.current = node;
  }, []);
  return (
    <DialogPortal>
      <DialogOverlay className={palette ? "[--v-overlay-dur:var(--v-motion-instant)]" : undefined} />
      <DialogPrimitive.Content
        ref={setRef}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          const back = origin.current;
          if (event.defaultPrevented || back === null || !back.isConnected) return;
          event.preventDefault();
          back.focus();
        }}
        data-slot="dialog-content"
        data-size={size}
        className={cn(
          "fixed top-1/2 left-1/2 z-(--v-z-dialog) w-full -translate-x-1/2 -translate-y-1/2",
          "max-h-[calc(100dvh-64px)] overflow-y-auto",
          size === "lg"
            ? "max-w-[min(var(--v-modal-wide-w),calc(100vw-64px))]"
            : "max-w-[min(var(--v-modal-w),calc(100vw-64px))]",
          "rounded-xl border border-border bg-card p-6 text-sm text-foreground shadow-dialog",
          palette ? "v-overlay-motion [--v-overlay-dur:var(--v-motion-instant)]" : "v-dialog-motion",
          className,
        )}
        {...props}
      >
        {children}
        {showClose ? (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon"
              className="absolute top-4 end-4 size-8 text-foreground"
              aria-label="Close"
            >
              <XIcon className="size-4" />
            </Button>
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

export function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="dialog-header" className={cn("mb-6 flex flex-col gap-1.5 pr-8", className)} {...props} />;
}

export function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex items-center justify-between gap-2 pt-6 [&>:only-child]:ml-auto", className)}
      {...props}
    />
  );
}

export function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold tracking-h-lg text-foreground", className)}
      {...props}
    />
  );
}

export function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}
