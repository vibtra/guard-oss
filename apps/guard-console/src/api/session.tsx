import * as React from "react";
import type { ConsoleSession } from "@vibtra/console-api";
import { ConsoleApiError, api } from "./client";
import { useDoor } from "./useDoor";
import { redactCredentials } from "./redact";
import { authClient } from "../auth/client";

interface SessionValue {
  session: ConsoleSession;
  reload: () => void;
}

const SessionContext = React.createContext<SessionValue | undefined>(undefined);

export const useSession = (): ConsoleSession => {
  const value = React.useContext(SessionContext);
  if (value === undefined) throw new Error("useSession outside SessionProvider");
  return value.session;
};

export const useReloadSession = (): (() => void) => {
  const value = React.useContext(SessionContext);
  if (value === undefined) throw new Error("useReloadSession outside SessionProvider");
  return value.reload;
};

export const useOrg = (): { id: string; name: string; plan: string } => {
  const session = useSession();
  return { id: session.orgId, name: session.orgName, plan: session.usage.plan };
};

export const useAccount = (): {
  name: string;
  email: string;
  initials: string;
  imageUrl?: string;
} => {
  const session = useSession();
  const user = authClient.useSession().data?.user;
  const local = session.email.split("@")[0] ?? session.email;
  const name = user?.name !== undefined && user.name !== "" ? user.name : local;
  const parts = name.split(/[\s._-]+/).filter((p) => p !== "");
  const initials = (
    parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2)
  ).toUpperCase();
  const image = user?.image;
  return {
    name,
    email: session.email,
    initials,
    ...(typeof image === "string" && image !== "" ? { imageUrl: image } : {}),
  };
};

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const door = useDoor(() => api.session(), []);
  const value = React.useMemo<SessionValue | undefined>(
    () => (door.state.status === "ready" ? { session: door.state.data, reload: door.reask } : undefined),
    [door.state, door.reask],
  );

  if (door.state.status === "loading") return <Splash>Loading your organisation…</Splash>;
  if (door.state.status === "error") {
    const error: ConsoleApiError = door.state.error;
    if (error.signedOut) {
      return (
        <Splash>
          <span className="block text-ink">This account is not in an organisation</span>
          <span className="mt-1 block text-xs leading-para text-body">
            You are signed in, but the registry has no membership for you, so there is no
            organisation for this console to show. An owner of the organisation you expected can
            invite you; signing in again will not change it.
          </span>
          <button
            type="button"
            onClick={() => {
              void authClient.signOut().finally(() => window.location.reload());
            }}
            className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm font-medium"
          >
            Sign out
          </button>
        </Splash>
      );
    }
    return (
      <Splash>
        <span className="block text-ink">{error.message}</span>
        {error.detail ? (
          <span className="mt-1 block text-xs text-body">{redactCredentials(error.detail)}</span>
        ) : null}
        <button
          type="button"
          onClick={door.reload}
          className="mt-3 rounded-md border border-line px-3 py-1.5 text-sm font-medium"
        >
          Try again
        </button>
      </Splash>
    );
  }
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function Splash({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-dvh items-center justify-center bg-app px-6">
      <div className="max-w-sm text-center text-sm leading-para text-body">{children}</div>
    </div>
  );
}
