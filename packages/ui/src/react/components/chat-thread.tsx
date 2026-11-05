import * as React from "react";
import { cn } from "../lib/cn";

export function ChatThread({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="chat-thread"
      role="log"
      aria-live="polite"
      className={cn("mx-auto flex w-180 max-w-full flex-col gap-6 px-4 py-6", className)}
      {...props}
    />
  );
}

export function ChatMessage({
  from,
  className,
  children,
}: {
  from: "person" | "assistant";
  className?: string;
  children: React.ReactNode;
}) {
  if (from === "person") {
    return (
      <div data-slot="chat-message" data-from="person" className={cn("flex justify-end", className)}>
        <div className="max-w-[80%] rounded-3xl bg-accent p-4 text-sm tracking-body-sm text-foreground">{children}</div>
      </div>
    );
  }
  return (
    <div
      data-slot="chat-message"
      data-from="assistant"
      className={cn(
        "text-sm leading-5 tracking-body-sm text-foreground",
        "[&_strong]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_p+p]:mt-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function InlineCode({ className, ...props }: React.ComponentProps<"code">) {
  return (
    <code
      data-slot="inline-code"
      className={cn(
        "rounded-sm bg-accent px-1 py-0.5 font-mono text-xs leading-4 font-normal text-inline-code shadow-[inset_0_0_0_0.5px_var(--border)]",
        className,
      )}
      {...props}
    />
  );
}

export function ChatActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="chat-actions"
      role="toolbar"
      className={cn("inline-flex h-8 items-center gap-1 rounded-full bg-card p-1 shadow-low", className)}
      {...props}
    />
  );
}
