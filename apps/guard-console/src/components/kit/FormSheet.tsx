import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/components/kit/cn";
import { useNarrow } from "@/components/ui/sidebar";
import { ActionButton } from "./ActionButton";
import { OverlayClose, SHEET_BACKDROP, SHEET_MOTION } from "./DetailSheet";
import { focusIsVisible, useMountOpen } from "./useHeld";

const FIRST_FIELD =
  "input:not([type='hidden']):not([disabled]), textarea:not([disabled]), select:not([disabled]), [role='combobox']:not([disabled]):not([data-disabled]), [role='checkbox']:not([data-disabled]), [role='switch']:not([disabled])";

export function FormSheet({
  open,
  onClose,
  title,
  description,
  size = "md",
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  primaryVariant = "primary",
  busy = false,
  cancelLabel = "Cancel",
  back,
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: "md" | "sm";
  primaryLabel?: string;
  onPrimary?: () => void;
  primaryDisabled?: boolean;
  primaryVariant?: "primary" | "danger";
  busy?: boolean;
  cancelLabel?: string;
  back?: { label?: string; onClick: () => void };
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const narrow = useNarrow();
  const popupRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const shown = useMountOpen(open);
  return (
    <Dialog.Root
      open={shown}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-slot="form-sheet-overlay" className={SHEET_BACKDROP} />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={(type) => {
            const keyboard = type === "keyboard" || (type === "" && focusIsVisible());
            return (keyboard ? bodyRef.current?.querySelector<HTMLElement>(FIRST_FIELD) : null) ?? popupRef.current;
          }}
          tabIndex={-1}
          data-slot="form-sheet"
          data-size={size}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-g-surface text-g-ink outline-hidden",
            SHEET_MOTION,
            narrow
              ? "inset-0"
              : cn(
                  "top-(--g-sheet-inset) end-(--g-sheet-inset) bottom-(--g-sheet-inset) rounded-g-shell border border-g-line shadow-g-pop",
                  size === "sm" ? "w-[min(var(--g-form-w-sm),calc(100vw_-_24px))]" : "w-[min(var(--g-form-w),calc(100vw_-_24px))]",
                ),
            className,
          )}
        >
          <form
            noValidate
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              if (!primaryDisabled && !busy) onPrimary?.();
            }}
          >
            <header className="flex shrink-0 items-start gap-3 border-b border-g-line p-6 max-md:p-4">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Dialog.Title className="text-16 font-[600] text-g-ink-strong">{title}</Dialog.Title>
                {description === undefined ? null : <Dialog.Description className="text-14 text-g-muted">{description}</Dialog.Description>}
              </div>
              <OverlayClose className="-mt-1 -me-2" />
            </header>
            <div ref={bodyRef} data-slot="form-sheet-body" className={cn("scrollbar-knox min-h-0 flex-1 overflow-y-auto overscroll-contain max-md:p-4", size === "sm" ? "p-6" : "p-8")}>
              {children}
            </div>
            <footer data-slot="form-sheet-footer" className="flex shrink-0 items-center gap-2 border-t border-g-line px-6 py-4 max-md:px-4">
              {footer ?? (
                <>
                  {back === undefined ? (
                    <ActionButton static className="flex-1" aria-disabled={busy || undefined} onClick={onClose}>
                      {primaryLabel === undefined ? "Close" : cancelLabel}
                    </ActionButton>
                  ) : (
                    <ActionButton static className="flex-1" aria-disabled={busy || undefined} onClick={back.onClick}>
                      {back.label ?? "Back"}
                    </ActionButton>
                  )}
                  {primaryLabel === undefined ? null : (
                    <ActionButton static type="submit" variant={primaryVariant} className="flex-1" disabled={primaryDisabled} loading={busy}>
                      {primaryLabel}
                    </ActionButton>
                  )}
                </>
              )}
            </footer>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
