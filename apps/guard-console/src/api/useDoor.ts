import * as React from "react";
import { ConsoleApiError } from "./client";

export type DoorState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ConsoleApiError };

export interface Door<T> {
  state: DoorState<T>;
  reload: () => void;
  reask: () => void;
}

const sameRequest = (before: readonly unknown[] | undefined, now: readonly unknown[]): boolean =>
  before !== undefined &&
  before.length === now.length &&
  before.every((value, index) => Object.is(value, now[index]));

export const useDoor = <T>(load: () => Promise<T>, deps: readonly unknown[]): Door<T> => {
  const [state, setState] = React.useState<DoorState<T>>({ status: "loading" });
  const [nonce, setNonce] = React.useState(0);

  const loadRef = React.useRef(load);
  loadRef.current = load;

  const asked = React.useRef<readonly unknown[] | undefined>(undefined);

  const different = React.useRef(false);

  React.useEffect(() => {
    let live = true;
    const held = !different.current && sameRequest(asked.current, deps);
    different.current = false;
    asked.current = deps;
    setState((current) =>
      held && current.status === "ready" ? current : { status: "loading" },
    );
    loadRef
      .current()
      .then((data) => {
        if (live) setState({ status: "ready", data });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          status: "error",
          error:
            error instanceof ConsoleApiError
              ? error
              : new ConsoleApiError({
                  status: 0,
                  code: "INTERNAL",
                  message: "Something went wrong reading this page",
                  detail: error instanceof Error ? error.message : String(error),
                }),
        });
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return {
    state,
    reload: React.useCallback(() => setNonce((n) => n + 1), []),
    reask: React.useCallback(() => {
      different.current = true;
      setNonce((n) => n + 1);
    }, []),
  };
};
