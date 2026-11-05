import { CircleAlertIcon, LogInIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { ActionButton, actionButtonClass } from "@/components/kit/ActionButton";
import { EmptyState } from "@/components/kit/EmptyState";
import { ConsoleApiError, signInHref } from "../api/client";
import { RefusalDetail } from "./Refusal";

export function DoorSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div data-slot="door-skeleton" className="v-skeleton-delay space-y-2" aria-busy="true">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-(--v-table-td-h-compact)" />
      ))}
    </div>
  );
}

export function DoorError({ error, onRetry }: { error: ConsoleApiError; onRetry: () => void }) {
  if (error.signedOut) {
    return (
      <EmptyState
        data-slot="door-error"
        data-signed-out=""
        icon={LogInIcon}
        title="Your session has ended"
        description="Sign in again to see this page. Nothing was lost: this console reads, it does not hold your work."
        action={
          <a href={signInHref()} className={actionButtonClass("primary")}>
            Sign in
          </a>
        }
      />
    );
  }
  return (
    <EmptyState
      data-slot="door-error"
      icon={CircleAlertIcon}
      title={error.message}
      description={
        <>
          Try again. If it keeps happening, give IT the code <code className="font-mono text-g-ink">{error.code}</code>.
        </>
      }
      detail={error.detail ? <RefusalDetail detail={error.detail} /> : undefined}
      action={<ActionButton onClick={onRetry}>Try again</ActionButton>}
    />
  );
}
