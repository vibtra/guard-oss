import { Link } from "react-router";
import { ChevronRightIcon } from "lucide-react";
import type { GuardProtectionPage } from "@vibtra/guard-contract";
import { cn } from "@/components/kit";
import { MODES, MODE_LABEL, countsByMode, peopleWords, protectionHref, type Mode } from "./model";

const SWATCH: Readonly<Record<Mode, string>> = {
  enforce: "bg-g-ink",
  monitor: "bg-g-subtle",
  off: "bg-g-surface shadow-[inset_0_0_0_1px_var(--g-line-control)]",
};

const AFTER: Readonly<Record<Mode, string>> = { enforce: "", monitor: "", off: " · not in scope" };

export function ModeMix({ page }: { page: GuardProtectionPage }) {
  const counts = countsByMode(page.people);
  const total = page.people.length;
  return (
    <section data-testid="overview-modes" aria-labelledby="overview-modes-title" className="mb-6 flex flex-col gap-3 rounded-g-card border border-g-line bg-g-surface px-5 py-4 max-md:px-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="overview-modes-title" className="text-14 font-medium text-g-ink-strong">
          Protection for {peopleWords(total)}
        </h2>
        <Link to={protectionHref()} className="focus-knox inline-flex items-center gap-1 rounded-sm text-13 font-medium text-g-muted outline-hidden transition-[color] duration-(--g-dur) ease-g hover:text-g-ink">
          Default: {MODE_LABEL[page.defaultMode]}
          <ChevronRightIcon aria-hidden className="size-3.5 rtl:-scale-x-100" />
        </Link>
      </div>
      {total === 0 ? null : (
        <span aria-hidden data-slot="mode-bar" className="flex h-2 w-full gap-0.5">
          {MODES.filter((mode) => counts[mode] > 0).map((mode) => (
            <span key={mode} className={cn("h-full rounded-full", SWATCH[mode])} style={{ flexGrow: counts[mode] }} />
          ))}
        </span>
      )}
      <ul aria-label="People by mode" className="flex flex-wrap gap-x-6 gap-y-2">
        {MODES.map((mode) => (
          <li key={mode}>
            <Link
              to={protectionHref({ mode })}
              data-testid="overview-mode"
              data-mode={mode}
              className="focus-knox group inline-flex items-center gap-2 rounded-sm text-14 text-g-ink outline-hidden"
            >
              <span aria-hidden className={cn("size-2.5 shrink-0 rounded-full", SWATCH[mode])} />
              <span className="font-medium tabular-nums">{counts[mode].toLocaleString("en-US")}</span>
              <span className="text-g-muted underline-offset-4 group-hover:underline">
                {MODE_LABEL[mode]}
                {AFTER[mode]}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
