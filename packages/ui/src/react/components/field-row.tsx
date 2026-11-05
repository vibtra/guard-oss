import * as React from "react";
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

const MASK = "•".repeat(10);

export type FieldRowProps = {
  label: string;
  value: string;
  secret?: boolean;
  mono?: boolean;
  copyable?: boolean;
  hint?: string;
  actions?: React.ReactNode;
  labelWidth?: string;
  className?: string;
};

export function FieldRow({
  label,
  value,
  secret = false,
  mono = false,
  copyable = true,
  hint,
  actions,
  labelWidth,
  className,
}: FieldRowProps) {
  const [revealed, setRevealed] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  React.useEffect(() => () => clearTimeout(timer.current), []);

  const copy = React.useCallback(() => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  const hidden = secret && !revealed;
  const shown = hidden ? MASK : value;

  return (
    <div
      data-slot="field-row"
      className={cn("group/field flex items-start gap-6", className)}
    >
      <div
        className="shrink-0 text-sm font-medium tracking-h-xs text-foreground"
        style={{ width: labelWidth ?? "var(--v-settings-label-w)" }}
      >
        {label}
      </div>

      <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            className={cn("truncate text-sm text-foreground", (mono || hidden) && "v-mono text-xs")}
            title={hidden ? undefined : value}
          >
            {shown}
          </div>
          {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
        </div>

        <div
          className={cn(
            "flex shrink-0 items-center gap-1 opacity-0 transition-opacity duration-(--v-dur-1)",
            "group-hover/field:opacity-100 group-focus-within/field:opacity-100",
            "group-data-[test-hover]/field:opacity-100",
          )}
        >
          {actions}
          {secret ? (
            <FieldAction
              label={revealed ? `Hide ${label}` : `Reveal ${label}`}
              onClick={() => setRevealed((r) => !r)}
              icon={revealed ? <EyeOffIcon /> : <EyeIcon />}
            />
          ) : null}
          {copyable ? (
            <FieldAction
              label={`Copy ${label}`}
              onClick={copy}
              icon={copied ? <CheckIcon className="size-4 text-ok-solid" /> : <CopyIcon />}
            />
          ) : null}
        </div>
      </div>

      <span role="status" aria-live="polite" className="sr-only">
        {copied ? `${label} copied` : ""}
      </span>
    </div>
  );
}

function FieldAction({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <Button variant="ghost" size="icon-sm" onClick={onClick} aria-label={label} title={label}>
      {icon}
    </Button>
  );
}

export function KeyValue({
  heading,
  children,
  className,
}: {
  heading?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-6", className)}>
      {heading ? (
        <h3 className="mb-4 text-sm font-medium tracking-h-xs text-foreground">{heading}</h3>
      ) : null}
      <div className="flex flex-col gap-9">{children}</div>
    </section>
  );
}
