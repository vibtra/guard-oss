import * as React from "react";

export type Theme = "light" | "dark" | "system";

export type ResolvedTheme = "light" | "dark";

const KEY = "vibtra.console.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStored(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
  }
  return "system";
}

function darkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

const prefersDark = (): boolean => darkQuery()?.matches ?? false;

export function useTheme(): [Theme, () => void, ResolvedTheme, (next: Theme) => void] {
  const [theme, setStored] = React.useState<Theme>(readStored);
  const [systemDark, setSystemDark] = React.useState<boolean>(prefersDark);

  React.useEffect(() => {
    const mql = darkQuery();
    if (!mql) return;
    const onChange = () => setSystemDark(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  const resolved: ResolvedTheme = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  React.useEffect(() => {
    const root = document.documentElement;
    if (root.classList.contains("dark") === (resolved === "dark")) return;
    const style = document.createElement("style");
    style.append(document.createTextNode("*,*::before,*::after{transition:none!important}"));
    document.head.append(style);
    root.classList.toggle("dark", resolved === "dark");
    void document.body?.offsetHeight;
    const remove = () => style.remove();
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => requestAnimationFrame(remove));
    else remove();
  }, [resolved]);

  const setTheme = React.useCallback((next: Theme) => {
    setStored(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
    }
  }, []);

  const toggle = React.useCallback(() => {
    setTheme(resolved === "dark" ? "light" : "dark");
  }, [resolved, setTheme]);

  return [theme, toggle, resolved, setTheme];
}
