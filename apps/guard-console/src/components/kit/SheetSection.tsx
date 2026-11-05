import * as React from "react";
import { cn } from "@/components/kit/cn";

export function SheetSection({
  title,
  description,
  action,
  children,
  className,
  testId,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const id = React.useId();
  return (
    <section aria-labelledby={id} data-slot="sheet-section" data-testid={testId} className={cn("flex flex-col gap-3", className)}>
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={id} className="text-14 font-[600] text-g-ink-strong">
            {title}
          </h3>
          {description === undefined ? null : <p className="max-w-[72ch] text-13 text-pretty text-g-muted">{description}</p>}
        </div>
        {action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      {children}
    </section>
  );
}
