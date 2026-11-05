import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { cn } from "@/components/kit/cn";
import { ActionButton } from "./ActionButton";
import { OverlayClose } from "./DetailSheet";
import { useMountOpen } from "./useHeld";

type FinalFocus = NonNullable<React.ComponentProps<typeof Dialog.Popup>["finalFocus"]>;

const WIDTH: Readonly<Record<"form" | "list" | "confirm", string>> = {
  form: "w-[min(var(--g-modal-w),calc(100vw_-_32px))]",
  list: "w-[min(var(--g-modal-list-w),calc(100vw_-_32px))]",
  confirm: "w-[min(var(--g-confirm-w),calc(100vw_-_32px))]",
};

export function Modal({
  open,
  onClose,
  title,
  description,
  size = "form",
  footer,
  closable = true,
  role,
  initialFocus,
  finalFocus,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  size?: "form" | "list" | "confirm";
  footer?: React.ReactNode;
  closable?: boolean;
  role?: "dialog" | "alertdialog";
  initialFocus?: React.RefObject<HTMLElement | null>;
  finalFocus?: FinalFocus;
  children?: React.ReactNode;
  className?: string;
}) {
  const shown = useMountOpen(open);
  return (
    <Dialog.Root
      open={shown}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          data-slot="modal-overlay"
          className="fixed inset-0 z-50 bg-g-overlay-modal transition-[opacity] duration-(--g-dur) ease-g data-ending-style:duration-(--g-dur-fast) data-ending-style:opacity-0 data-starting-style:opacity-0"
        />
        <Dialog.Popup
          data-slot="modal"
          data-size={size}
          role={role}
          {...(initialFocus === undefined ? {} : { initialFocus })}
          {...(finalFocus === undefined ? {} : { finalFocus })}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-g-shell border border-g-line bg-g-surface text-g-ink shadow-g-pop outline-hidden",
            "transition-[opacity,scale] duration-(--g-dur-sheet) ease-g data-ending-style:duration-(--g-dur-exit) data-ending-style:scale-[.96] data-ending-style:opacity-0 data-starting-style:scale-[.96] data-starting-style:opacity-0",
            WIDTH[size],
            className,
          )}
        >
          <header className={cn("flex shrink-0 items-start gap-3", size === "confirm" ? "px-5 pt-5 pb-2" : "p-6 pb-4")}>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <Dialog.Title className={cn("text-g-ink-strong", size === "list" ? "text-24 font-[600]" : size === "confirm" ? "text-18 font-[600]" : "text-18 font-medium")}>
                {title}
              </Dialog.Title>
              {description === undefined ? null : <Dialog.Description className="text-14 text-g-muted">{description}</Dialog.Description>}
            </div>
            {closable ? <OverlayClose className="-mt-1 -me-2" /> : null}
          </header>
          {children === undefined ? null : (
            <div data-slot="modal-body" className={cn("scrollbar-knox min-h-0 flex-1 overflow-y-auto overscroll-contain", size === "confirm" ? "px-5 pb-4" : "border-t border-g-divider px-6 pt-4 pb-8")}>
              {children}
            </div>
          )}
          {footer === undefined ? null : footer}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ModalFooter({ children, start, plain = false, className }: { children?: React.ReactNode; start?: React.ReactNode; plain?: boolean; className?: string }) {
  return (
    <footer
      data-slot="modal-footer"
      className={cn("flex shrink-0 items-center gap-2", plain ? "px-5 pb-5" : "border-t border-g-divider bg-g-modal-foot px-6 py-4", className)}
    >
      {start === undefined ? null : <div className="flex items-center gap-2">{start}</div>}
      <div className="ms-auto flex items-center gap-2">{children}</div>
    </footer>
  );
}

export function ConfirmModal({
  open,
  onClose,
  title,
  children,
  confirmLabel,
  cancelLabel = "Cancel",
  onConfirm,
  destructive = true,
  busy = false,
  confirmDisabled = false,
  finalFocus,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  destructive?: boolean;
  busy?: boolean;
  confirmDisabled?: boolean;
  finalFocus?: FinalFocus;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={title}
      size="confirm"
      closable={false}
      role="alertdialog"
      initialFocus={cancelRef}
      {...(finalFocus === undefined ? {} : { finalFocus })}
      footer={
        <ModalFooter plain>
          <ActionButton ref={cancelRef} static aria-disabled={busy || undefined} onClick={onClose}>
            {cancelLabel}
          </ActionButton>
          <ActionButton variant={destructive ? "danger" : "primary"} loading={busy} disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </ActionButton>
        </ModalFooter>
      }
    >
      <div className="flex flex-col gap-3 text-14 text-g-muted">{children}</div>
    </Modal>
  );
}
