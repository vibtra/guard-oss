import * as React from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router";

const MARK = "guardSheet";

export interface SheetParam {
  value: string | null;
  open: (id: string) => void;
  close: () => void;
}

export function useSheetParam(name: string): SheetParam {
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const value = params.get(name);
  const pushedHere = (location.state as Record<string, unknown> | null)?.[MARK] === name;

  const open = React.useCallback(
    (id: string) => {
      const next = new URLSearchParams(location.search);
      next.set(name, id);
      navigate({ pathname: location.pathname, search: `?${next.toString()}` }, { state: { [MARK]: name }, replace: value !== null });
    },
    [location.pathname, location.search, name, navigate, value],
  );

  const close = React.useCallback(() => {
    if (value === null) return;
    if (pushedHere && location.key !== "default") {
      navigate(-1);
      return;
    }
    const next = new URLSearchParams(location.search);
    next.delete(name);
    const search = next.toString();
    navigate({ pathname: location.pathname, search: search === "" ? "" : `?${search}` }, { replace: true });
  }, [location.key, location.pathname, location.search, name, navigate, pushedHere, value]);

  return { value, open, close };
}
