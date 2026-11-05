import * as React from "react";
import { useLocation } from "react-router";
import { Button } from "@vibtra/ui/react";
import { ShieldIcon } from "lucide-react";
import { EmptyState } from "@/components/kit/EmptyState";
import { authClient } from "./client";
import { addressOf, signInHrefFor } from "./return-to";
import { ADMIN_ONLY_NOTICE, useRole } from "./roles";
import { canVisit } from "../nav";
import { AuthFrame } from "./AuthFrame";

export function AuthSplash({ children, detail }: { children: React.ReactNode; detail?: string }) {
  return (
    <AuthFrame state="checking" mark="outline" {...(detail === undefined ? {} : { detail })}>
      <div className="mx-auto max-w-sm text-center text-sm leading-para text-muted-foreground">{children}</div>
    </AuthFrame>
  );
}

export function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isPending, error } = authClient.useSession();
  const location = useLocation();

  if (isPending) return <AuthSplash>Checking your session…</AuthSplash>;

  if (error !== null && data === null) {
    return (
      <AuthSplash detail="unreachable">
        <span className="block text-foreground">Could not reach the registry</span>
        <span className="mt-1 block text-xs text-muted-foreground">{error.message}</span>
        <Button type="button" variant="neutral" className="mt-3" onClick={() => window.location.reload()}>
          Try again
        </Button>
      </AuthSplash>
    );
  }

  if (data === null || data === undefined) {
    window.location.replace(signInHrefFor(addressOf(location.pathname, location.search)));
    return null;
  }

  return <>{children}</>;
}

export const useAuthUser = () => authClient.useSession().data?.user;

export function RequireRole({ children }: { children: React.ReactNode }) {
  const role = useRole();
  const location = useLocation();
  const allowed = canVisit(role, location.pathname);
  if (allowed) return <>{children}</>;
  return (
    <div data-testid="admin-only" className="rounded-g-card border border-g-line">
      <EmptyState
        icon={ShieldIcon}
        title={ADMIN_ONLY_NOTICE}
        description="Vibtra Guard’s console is for the people who set the organisation’s AI rules. Ask an admin of this organisation if you need something changed."
      />
    </div>
  );
}
