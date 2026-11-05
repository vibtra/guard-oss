import { CONSOLE_LOGIN_PATH, consolePathFor, orgHandleProblem } from "@vibtra/console-api";
import { GUARD_CONSOLE_PATH } from "@vibtra/guard-contract";

const MAX_RETURN_LENGTH = 1024;

export const sanitizeReturnPath = (raw: unknown): string | undefined => {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim();
  if (value === "" || value.length > MAX_RETURN_LENGTH) return undefined;
  if (!value.startsWith("/")) return undefined;
  if (value.startsWith("//")) return undefined;
  if (value.includes("\\")) return undefined;
  if (/[\u0000-\u001f\u007f]/.test(value)) return undefined;
  return value;
};

export const handleFromPath = (pathname: string): string | undefined => {
  const first = pathname.split("/")[1] ?? "";
  return orgHandleProblem(first) === undefined ? first : undefined;
};

export const currentHandle = (): string | undefined =>
  typeof window === "undefined" ? undefined : handleFromPath(window.location.pathname);

export const basenameFromPath = (pathname: string): string => {
  const [, first, second] = pathname.split("/");
  if (first !== undefined && orgHandleProblem(first) === undefined && `/${second ?? ""}` === GUARD_CONSOLE_PATH) return `/${first}${GUARD_CONSOLE_PATH}`;
  return "/";
};

export const guardAddressFor = (handle: string, route = "/"): string => consolePathFor(handle, `${GUARD_CONSOLE_PATH}${route === "/" ? "" : route}`);

export const returnPathOf = (search: string): string | undefined =>
  sanitizeReturnPath(new URLSearchParams(search).get("return"));

export const signInHrefFor = (returnTo?: string): string => {
  const safe = sanitizeReturnPath(returnTo);
  return safe === undefined ? CONSOLE_LOGIN_PATH : `${CONSOLE_LOGIN_PATH}?return=${encodeURIComponent(safe)}`;
};

export const addressOf = (pathname: string, search = "", handle = currentHandle()): string =>
  handle === undefined ? `${pathname}${search}` : `${guardAddressFor(handle, pathname)}${search}`;
