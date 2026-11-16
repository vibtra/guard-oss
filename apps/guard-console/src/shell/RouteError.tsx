import { CircleAlertIcon } from "lucide-react";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { actionButtonClass } from "@/components/kit/ActionButton";
import { EmptyState } from "@/components/kit/EmptyState";
import { refusalWords } from "../api/client";

export function RouteError() {
  const raised = useRouteError();
  const error = isRouteErrorResponse(raised) ? new Error(`${raised.status} ${raised.statusText}`.trim()) : raised;
  return (
    <main className="mx-auto max-w-xl p-6">
      <EmptyState
        data-slot="route-error"
        icon={CircleAlertIcon}
        title="This page could not be shown"
        description={refusalWords(error, "Reload the page.")}
        action={
          <a href={window.location.pathname} className={actionButtonClass("primary")}>
            Reload
          </a>
        }
      />
    </main>
  );
}
