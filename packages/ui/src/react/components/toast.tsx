import * as React from "react";
import { Toaster as Sonner, toast } from "sonner";

export type ToasterProps = React.ComponentProps<typeof Sonner>;

export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      containerAriaLabel="Notifications"
      duration={5000}
      gap={8}
      toastOptions={{
        classNames: {
          toast:
            "!rounded-lg !border !border-border !bg-popover !text-foreground !shadow-medium !font-ui !text-sm !max-w-[420px] !p-3 !pl-4",
          description: "!text-muted-foreground",
          actionButton:
            "!h-(--v-control-h-sm) !rounded-lg !border !border-transparent !bg-primary !px-3 !text-sm !font-medium !text-primary-foreground",
          cancelButton:
            "!h-(--v-control-h-sm) !rounded-lg !border !border-border !bg-card !px-3 !text-sm !font-medium !text-foreground",
          icon: "!size-4",
          error: "[&_[data-icon]]:!text-danger-solid",
          success: "[&_[data-icon]]:!text-ok-solid",
          warning: "[&_[data-icon]]:!text-warn-solid",
          info: "[&_[data-icon]]:!text-info-solid",
        },
      }}
      style={{ zIndex: "var(--v-z-toast)" as unknown as number }}
      {...props}
    />
  );
}

export function toastError(message: string, description?: string) {
  return toast.error(message, { description, duration: Infinity });
}

export { toast };
