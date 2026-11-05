import { z } from "zod";
import { currentHandle, signInHrefFor } from "../auth/return-to";
import {
  CONSOLE_API_PREFIX,
  CSRF_COOKIE,
  CSRF_HEADER,
  ORG_HANDLE_HEADER,
  ConsolePeoplePage,
  ConsolePolicyDecided,
  type ConsolePolicyDecision,
  ConsolePolicyGrantsPage,
  ConsolePolicyRequestPage,
  ConsolePolicyRequestsPage,
  ConsoleSession,
} from "@vibtra/console-api";

export class ConsoleApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly body?: unknown;
  constructor(args: {
    status: number;
    code: string;
    message: string;
    detail?: string;
    body?: unknown;
  }) {
    super(args.message);
    this.name = "ConsoleApiError";
    this.status = args.status;
    this.code = args.code;
    if (args.detail !== undefined) this.detail = args.detail;
    if (args.body !== undefined) this.body = args.body;
  }
  get signedOut(): boolean {
    return this.status === 401;
  }
}

export function refusalSentence(error: unknown, next = ""): string {
  const raw = error instanceof ConsoleApiError ? error.message : error instanceof Error ? error.message : String(error);
  const t = raw.trim();
  const said = /[.!?]$/.test(t) ? t : `${t}.`;
  return next === "" ? said : `${said} ${next}`;
}

export function refusalWords(error: unknown, next = "Try again."): string {
  const sentence = (v: string): string => {
    const t = v.trim();
    return /[.!?]$/.test(t) ? t : `${t}.`;
  };
  const parts =
    error instanceof ConsoleApiError
      ? [error.message, error.detail].filter((v): v is string => v !== undefined && v.trim() !== "")
      : [error instanceof Error ? error.message : String(error)];
  const said = parts.map(sentence).join(" ");
  return next === "" || said.toLowerCase().includes(next.toLowerCase().replace(/\.$/, "")) ? said : `${said} ${next}`;
}

export const signInHref = (): string =>
  signInHrefFor(window.location.pathname + window.location.search);

const readCookie = (name: string): string | undefined => {
  for (const part of document.cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
};

const VibtraErrorBody = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  detail: z.string().optional(),
});

export const call = async <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  path: string,
  init?: RequestInit,
): Promise<T> => {
  let res: Response;
  try {
    res = await fetch(`${CONSOLE_API_PREFIX}${path}`, {
      credentials: "include",
      ...init,
      headers: {
        accept: "application/json",
        ...(currentHandle() === undefined ? {} : { [ORG_HANDLE_HEADER]: currentHandle() as string }),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new ConsoleApiError({
      status: 0,
      code: "NETWORK",
      message: "Could not reach the registry",
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  const text = await res.text();
  if (!res.ok) {
    const refusal = safeJson(text);
    const parsed = VibtraErrorBody.safeParse(refusal);
    throw new ConsoleApiError({
      status: res.status,
      code: parsed.success ? parsed.data.code : "INTERNAL",
      message: parsed.success
        ? parsed.data.message
        : res.status === 403
          ? "The registry refused this request (403). Try again, or sign in again if it keeps happening."
          : `The registry answered ${res.status}`,
      ...(parsed.success && parsed.data.detail !== undefined ? { detail: parsed.data.detail } : {}),
      ...(refusal === undefined ? {} : { body: refusal }),
    });
  }

  const body = schema.safeParse(safeJson(text));
  if (!body.success) {
    throw new ConsoleApiError({
      status: res.status,
      code: "VALIDATION",
      message: "This console does not understand the registry's answer",
      detail:
        "The registry and this console ship as one artifact and must be upgraded together. One of them is a " +
        "different version. Redeploy them from the same build. The field it could not read: " +
        body.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    });
  }
  return body.data;
};

const safeJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

export const send = async <T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  method: "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> => {
  const csrf = readCookie(CSRF_COOKIE);
  if (csrf === undefined) {
    throw new ConsoleApiError({
      status: 401,
      code: "DEPLOY_AUTH_EXPIRED",
      message: "Sign in again to make this change",
      detail: `no ${CSRF_COOKIE} cookie is present, so this browser has no session with the registry`,
    });
  }
  return call(schema, path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      [CSRF_HEADER]: csrf,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
};

export const write = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, path: string, body: unknown): Promise<T> =>
  send(schema, "POST", path, body);

export interface PolicyRequestsQuery {
  kind?: "guard";
  status?: "pending" | "approved" | "declined" | "expired" | "cancelled" | "superseded";
}

const queryOf = (params: Record<string, string | number | undefined>): string => {
  const pairs = Object.entries(params).filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== "");
  return pairs.length === 0 ? "" : `?${pairs.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&")}`;
};
export { queryOf };

export const api = {
  session: () => call(ConsoleSession, "/session"),
  people: () => call(ConsolePeoplePage, "/people"),
  policyRequests: (query: PolicyRequestsQuery = {}) => call(ConsolePolicyRequestsPage, `/policy-requests${queryOf({ kind: query.kind, status: query.status })}`),
  policyRequest: (id: string) => call(ConsolePolicyRequestPage, `/policy-requests/${encodeURIComponent(id)}`),
  approvePolicyRequest: (id: string, decision: ConsolePolicyDecision = {}) => write(ConsolePolicyDecided, `/policy-requests/${encodeURIComponent(id)}/approve`, decision),
  declinePolicyRequest: (id: string, note?: string) => write(ConsolePolicyDecided, `/policy-requests/${encodeURIComponent(id)}/decline`, note ? { note } : {}),
  policyGrants: () => call(ConsolePolicyGrantsPage, "/policy-grants"),
  revokePolicyGrant: (id: string) => write(z.unknown(), `/policy-grants/${encodeURIComponent(id)}/revoke`, {}),
};
