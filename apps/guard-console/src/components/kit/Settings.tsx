import * as React from "react";
import { Link } from "react-router";
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import { ActionButton } from "./ActionButton";
import { Toggle } from "./Fields";
import { Pill } from "./Pill";

export function SettingsColumn({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="settings-column" className={cn("mx-auto flex w-full max-w-(--g-settings-w) flex-col gap-10", className)} {...props} />;
}

export function SettingsSection({
  title,
  description,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} data-slot="settings-section" className={cn("flex flex-col gap-4", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="text-16 font-[600] text-g-ink-strong">
            {title}
          </h2>
          {description === undefined ? null : <p className="max-w-[72ch] text-14 text-pretty text-g-muted">{description}</p>}
        </div>
        {action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}

export function SettingsCard({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="settings-group" className={cn("overflow-hidden rounded-g-card border border-g-line bg-g-surface", className)} {...props} />;
}

export type SettingsRowControl =
  | { kind: "toggle"; checked: boolean; onCheckedChange: (checked: boolean) => void; disabled?: boolean }
  | { kind: "link"; to: string }
  | { kind: "link"; onClick: () => void }
  | { kind: "value"; value: React.ReactNode; to: string }
  | { kind: "value"; value: React.ReactNode; onClick: () => void }
  | { kind: "control"; children: React.ReactNode }
  | { kind: "danger"; label: string; icon?: LucideIcon; onClick: () => void; disabled?: boolean };

const ROW = "flex min-h-[92px] w-full items-center gap-6 border-t border-g-divider px-5 py-6 text-start first:border-t-0";

export function SettingsRow({ title, description, problem, control, className }: { title: React.ReactNode; description?: React.ReactNode; problem?: React.ReactNode; control: SettingsRowControl; className?: string }) {
  const id = React.useId();
  const words = (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span id={`${id}-title`} className="text-14 font-medium text-g-ink-strong">
        {title}
      </span>
      {description === undefined ? null : (
        <span id={`${id}-desc`} className="max-w-[72ch] text-14 text-pretty text-g-muted">
          {description}
        </span>
      )}
      {problem === undefined || problem === null ? null : (
        <span id={`${id}-problem`} data-slot="settings-row-problem" className="max-w-[72ch] text-14 text-pretty text-g-danger">
          {problem}
        </span>
      )}
    </span>
  );
  const describedBy = [description === undefined ? undefined : `${id}-desc`, problem === undefined || problem === null ? undefined : `${id}-problem`].filter(Boolean).join(" ") || undefined;
  const chevron = <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-g-chevron" />;

  if (control.kind === "link" || control.kind === "value") {
    const inner = (
      <>
        {words}
        <span className="flex shrink-0 items-center gap-2">
          {control.kind === "value" ? <Pill tone="neutral">{control.value}</Pill> : null}
          {chevron}
        </span>
      </>
    );
    const linkClass = cn(ROW, "focus-knox cursor-pointer outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-hover", className);
    return "to" in control ? (
      <Link to={control.to} data-slot="settings-row" data-kind={control.kind} className={linkClass}>
        {inner}
      </Link>
    ) : (
      <button type="button" onClick={control.onClick} data-slot="settings-row" data-kind={control.kind} className={linkClass}>
        {inner}
      </button>
    );
  }

  return (
    <div data-slot="settings-row" data-kind={control.kind} className={cn(ROW, control.kind === "control" && "max-md:flex-col max-md:items-stretch max-md:gap-3", className)}>
      {words}
      <div className="flex shrink-0 items-center gap-2">
        {control.kind === "toggle" ? (
          <Toggle
            checked={control.checked}
            onCheckedChange={control.onCheckedChange}
            disabled={control.disabled}
            aria-labelledby={`${id}-title`}
            aria-describedby={describedBy}
          />
        ) : control.kind === "danger" ? (
          <ActionButton variant="danger" icon={control.icon} disabled={control.disabled} onClick={control.onClick}>
            {control.label}
          </ActionButton>
        ) : (
          <div className="w-60 max-md:w-full">{control.children}</div>
        )}
      </div>
    </div>
  );
}
