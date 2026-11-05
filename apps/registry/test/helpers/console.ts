import type { LightMyRequestResponse } from "fastify";
import { CONSOLE_API_PREFIX, CSRF_COOKIE, CSRF_HEADER } from "@vibtra/console-api";
import type { RegistryServer } from "../../src/server.js";

export const CONSOLE_ORIGIN = "http://registry.test.local";

export const consoleUrl = (segment: string): string => `${CONSOLE_API_PREFIX}${segment}`;

export const consoleGet = (
  registry: RegistryServer,
  path: string,
  cookie?: string,
): Promise<LightMyRequestResponse> =>
  registry.app.inject({
    method: "GET",
    url: consoleUrl(path),
    ...(cookie === undefined ? {} : { headers: { cookie } }),
  });

export const csrfFrom = (res: LightMyRequestResponse): string | undefined => {
  const cookies = res.cookies as Array<{ name: string; value: string }>;
  return cookies.find((c) => c.name === CSRF_COOKIE)?.value;
};

export const consoleSession = async (
  registry: RegistryServer,
  sessionCookie: string,
): Promise<{ cookie: string; csrf: string }> => {
  const res = await consoleGet(registry, "/session", sessionCookie);
  const csrf = csrfFrom(res);
  if (res.statusCode !== 200 || csrf === undefined) {
    throw new Error(`console session did not mint a CSRF cookie: ${res.statusCode} ${res.body.slice(0, 300)}`);
  }
  return { cookie: `${sessionCookie}; ${CSRF_COOKIE}=${csrf}`, csrf };
};

export interface ConsolePostOptions {
  withoutCsrfHeader?: boolean;
  origin?: string | null;
}

export const consoleWrite = (
  registry: RegistryServer,
  method: "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  session: { cookie: string; csrf: string },
  body: unknown,
  options: ConsolePostOptions = {},
): Promise<LightMyRequestResponse> => {
  const headers: Record<string, string> = { cookie: session.cookie };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (options.origin !== null) headers.origin = options.origin ?? CONSOLE_ORIGIN;
  if (options.withoutCsrfHeader !== true) headers[CSRF_HEADER] = session.csrf;
  return registry.app.inject({
    method,
    url: consoleUrl(path),
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
};

export const consolePost = (
  registry: RegistryServer,
  path: string,
  session: { cookie: string; csrf: string },
  body: unknown,
  options: ConsolePostOptions = {},
): Promise<LightMyRequestResponse> => consoleWrite(registry, "POST", path, session, body, options);

export const jsonOf = <T>(res: LightMyRequestResponse): T => {
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new Error(`expected JSON, got ${res.statusCode}: ${res.body.slice(0, 300)}`);
  }
};

export const addConnection = async (
  registry: RegistryServer,
  sessionCookie: string,
  body: unknown,
): Promise<{ connectionId: string; displayName: string }> => {
  const session = await consoleSession(registry, sessionCookie);
  const res = await consoleWrite(registry, "POST", "/connections", session, body);
  if (res.statusCode !== 200) {
    throw new Error(`adding a connection: ${res.statusCode} ${res.body.slice(0, 300)}`);
  }
  return jsonOf<{ connectionId: string; displayName: string }>(res);
};

export const allowFallbackCredential = async (
  registry: RegistryServer,
  sessionCookie: string,
): Promise<void> => {
  const session = await consoleSession(registry, sessionCookie);
  const page = await consoleGet(registry, "/policies", session.cookie);
  if (page.statusCode !== 200) {
    throw new Error(`reading this org's policy: ${page.statusCode} ${page.body.slice(0, 300)}`);
  }
  const doc = jsonOf<{ org: { doc: PolicyDocShape } }>(page).org.doc;
  const res = await consoleWrite(registry, "PUT", "/policies", session, {
    doc: { ...doc, deploy: { ...doc.deploy, fallbackCredential: "allow" } },
  });
  if (res.statusCode !== 200) {
    throw new Error(`allowing the fallback credential: ${res.statusCode} ${res.body.slice(0, 300)}`);
  }
};

interface PolicyDocShape {
  deploy: { fallbackCredential: string; [key: string]: unknown };
  [key: string]: unknown;
}
