import * as React from "react";
import { useLocation } from "react-router";
import type { ConsolePolicyRequestRow } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { useRole } from "../auth/roles";

export interface ShellCounts {
  openRequests: readonly ConsolePolicyRequestRow[] | undefined;
  devices: number | undefined;
  refresh: () => void;
}

const EMPTY: ShellCounts = { openRequests: undefined, devices: undefined, refresh: () => undefined };

const CountsContext = React.createContext<ShellCounts>(EMPTY);

export function useShellCounts(): ShellCounts {
  return React.useContext(CountsContext);
}

function useCount<T>(enabled: boolean, ask: () => Promise<T>, stamp: string, tick: number): T | undefined {
  const [value, setValue] = React.useState<T | undefined>(undefined);
  const askRef = React.useRef(ask);
  askRef.current = ask;
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    let request: Promise<T>;
    try {
      request = askRef.current();
    } catch {
      return;
    }
    request
      .then((answer) => {
        if (live) setValue(answer);
      })
      .catch(() => {
        if (live) setValue(undefined);
      });
    return () => {
      live = false;
    };
  }, [enabled, stamp, tick]);
  return value;
}

export function ShellCountsProvider({ children }: { children: React.ReactNode }) {
  const role = useRole();
  const { pathname } = useLocation();
  const [tick, setTick] = React.useState(0);
  const admin = role === "admin";

  const requests = useCount(admin, () => guard.policyRequests("pending"), pathname, tick);
  const devices = useCount(admin, () => guard.devices(), pathname, tick);

  const value = React.useMemo<ShellCounts>(
    () => ({
      openRequests:
        requests === undefined
          ? undefined
          : requests.requests.filter((row) => row.status === "pending").sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      devices: devices === undefined ? undefined : devices.rows.filter((row) => row.status === "active").length,
      refresh: () => setTick((n) => n + 1),
    }),
    [requests, devices],
  );

  return <CountsContext.Provider value={value}>{children}</CountsContext.Provider>;
}
