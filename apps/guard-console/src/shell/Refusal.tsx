import * as React from "react";
import { ChevronRightIcon } from "lucide-react";
import { hasCredentialUrl, redactCredentials } from "../api/redact";

export function RefusalDetail({
  detail,
  className,
}: {
  detail: string;
  className?: string;
}) {
  const redacted = React.useMemo(() => redactCredentials(detail), [detail]);
  const changed = React.useMemo(() => hasCredentialUrl(detail), [detail]);
  return (
    <details className={className}>
      <summary className="focus-knox inline-flex cursor-pointer list-none items-center gap-1 rounded-sm text-12 font-medium text-g-muted outline-hidden transition-[color] duration-(--g-dur) ease-g hover:text-g-ink [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-[rotate] duration-(--g-dur) ease-g in-[details[open]]:rotate-90 rtl:-scale-x-100 rtl:in-[details[open]]:-rotate-90" />
        Details for IT
      </summary>
      <p className="mt-1 text-12 leading-para break-words text-g-ink">{redacted}</p>
      {changed ? (
        <p className="mt-1 text-12 leading-para text-g-muted">
          A connection string in this sentence had its user and password removed before it was
          shown. The host and the database name are the registry&rsquo;s own.
        </p>
      ) : null}
    </details>
  );
}
