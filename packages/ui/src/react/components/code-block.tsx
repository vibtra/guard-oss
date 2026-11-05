import * as React from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

export type CodeBlockProps = React.ComponentProps<"pre"> & {
  copyText?: string;
  action?: React.ReactNode;
};

export function CodeBlock({ className, copyText, action, children, ...props }: CodeBlockProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = React.useCallback(() => {
    if (copyText === undefined) return;
    void navigator.clipboard?.writeText(copyText).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [copyText]);

  return (
    <div data-slot="code-block" className={cn("relative", className)}>
      <pre
        className={cn(
          "overflow-x-auto rounded-xl bg-accent px-4 py-3 font-mono text-xs leading-4 whitespace-pre text-foreground",
          copyText !== undefined || action ? "pr-12" : undefined,
        )}
        {...props}
      >
        {children}
      </pre>
      {copyText !== undefined || action ? (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          {action}
          {copyText !== undefined ? (
            <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy" title="Copy">
              {copied ? <CheckIcon className="size-4 text-ok-solid" /> : <CopyIcon />}
            </Button>
          ) : null}
        </div>
      ) : null}
      <span role="status" aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
