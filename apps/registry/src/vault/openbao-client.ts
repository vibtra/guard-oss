import { VibtraError } from "../errors.js";

export const OPENBAO_TIMEOUT_MS = 10_000;

export const DEFAULT_NAMESPACE_PREFIX = "orgs";

export interface OpenBaoApiResult {
  status: number;
  ok: boolean;
  json: unknown;
}

export const openbaoUnreachable = (stage: string, cause: string): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "The org vault could not reach OpenBao",
    detail:
      `${stage} — ${cause}. The vault's keys live in OpenBao's transit engine and nothing falls back to a ` +
      "local key, so this credential can neither be sealed nor opened until OpenBao answers again. " +
      "No credential, ciphertext or token is included in this message, by design.",
  });

export const openbaoRefused = (stage: string, status: number): VibtraError =>
  new VibtraError({
    code: "INTERNAL",
    message: "OpenBao refused the org vault's request",
    detail:
      `${stage} — HTTP ${status}. The registry's AppRole can encrypt and decrypt through transit and nothing ` +
      "else (OPENBAO_PLAN D5); a refusal here usually means the policy or the namespace prefix does not match " +
      "what this registry was configured with. OpenBao's response body is deliberately not repeated.",
  });

export const describeTransport = (err: unknown): string => {
  if (err instanceof Error && err.name === "AbortError") return "the request timed out";
  const code = (err as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  if (typeof code === "string" && /^[A-Z_]{3,32}$/.test(code)) return `the connection failed (${code})`;
  return "the connection failed";
};

export const assertPathSegment = (orgId: string): void => {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) return;
  throw new VibtraError({
    code: "VALIDATION",
    message: "That organisation id cannot be an OpenBao namespace",
    detail:
      "an org's namespace name is one path segment of letters, digits, underscore or hyphen (OpenBao 2.6.2 " +
      "refuses a namespace name containing a slash); the value itself is not echoed",
  });
};

export const errorsOf = (result: OpenBaoApiResult): string[] => {
  const errors = (result.json as { errors?: unknown } | undefined)?.errors;
  return Array.isArray(errors) ? errors.filter((e): e is string => typeof e === "string") : [];
};

export const dataOf = (result: OpenBaoApiResult): Record<string, unknown> | undefined => {
  const data = (result.json as { data?: unknown } | undefined)?.data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : undefined;
};

export interface OpenBaoClientOptions {
  addr: string;
  roleId: string;
  secretId: string;
  namespacePrefix?: string | null | undefined;
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch | undefined;
  now?: (() => number) | undefined;
}

export interface OpenBaoClient {
  readonly namespacePrefix: string | undefined;
  request(
    method: string,
    path: string,
    stage: string,
    init?: { token?: string | undefined; body?: unknown },
  ): Promise<OpenBaoApiResult>;
  authed(method: string, path: string, stage: string, body?: unknown): Promise<OpenBaoApiResult>;
  ensureMount(
    orgId: string,
    type: string,
    prepare?: (mount: string) => Promise<void>,
  ): Promise<string>;
}

export const createOpenBaoClient = (options: OpenBaoClientOptions): OpenBaoClient => {
  const base = options.addr.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? OPENBAO_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => Date.now());
  const namespacePrefix =
    options.namespacePrefix === null
      ? undefined
      : (options.namespacePrefix ?? DEFAULT_NAMESPACE_PREFIX).replace(/^\/+|\/+$/g, "");
  if (namespacePrefix !== undefined) assertPathSegment(namespacePrefix);

  let session: { token: string; renewAt: number } | undefined;
  let loggingIn: Promise<string> | undefined;
  const mounts = new Map<string, string>();
  const provisioning = new Map<string, Promise<string>>();

  const request = async (
    method: string,
    path: string,
    stage: string,
    init: { token?: string | undefined; body?: unknown } = {},
  ): Promise<OpenBaoApiResult> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (init.token !== undefined) headers["x-vault-token"] = init.token;
      const res = await doFetch(`${base}/v1/${path}`, {
        method,
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal: controller.signal,
      });
      const text = await res.text();
      let json: unknown;
      try {
        json = text === "" ? undefined : JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, ok: res.ok, json };
    } catch (err) {
      throw openbaoUnreachable(stage, describeTransport(err));
    } finally {
      clearTimeout(timer);
    }
  };

  const login = async (): Promise<string> => {
    const running = loggingIn;
    if (running !== undefined) return running;
    const attempt = (async (): Promise<string> => {
      const res = await request("POST", "auth/approle/login", "logging in to OpenBao with the registry's AppRole", {
        body: { role_id: options.roleId, secret_id: options.secretId },
      });
      if (res.status >= 500) throw openbaoUnreachable("logging in to OpenBao", `HTTP ${res.status}`);
      const auth = (res.json as { auth?: { client_token?: unknown; lease_duration?: unknown } } | undefined)?.auth;
      const token = auth?.client_token;
      if (!res.ok || typeof token !== "string" || token === "") {
        throw new VibtraError({
          code: "INTERNAL",
          message: "OpenBao refused the registry's AppRole credential",
          detail:
            `the AppRole login answered HTTP ${res.status} with no usable token — check OPENBAO_ROLE_ID and ` +
            "OPENBAO_SECRET_ID (neither is echoed here) and that the role still exists. The vault refuses " +
            "every seal and every open until it can log in; nothing falls back to a local key.",
        });
      }
      const lease = typeof auth?.lease_duration === "number" && auth.lease_duration > 0 ? auth.lease_duration : 0;
      const renewAt = lease === 0 ? Number.POSITIVE_INFINITY : now() + Math.floor(lease * 1000 * (2 / 3));
      session = { token, renewAt };
      return token;
    })();
    loggingIn = attempt;
    try {
      return await attempt;
    } finally {
      loggingIn = undefined;
    }
  };

  const currentToken = async (): Promise<string> => {
    const held = session;
    if (held === undefined) return login();
    if (now() < held.renewAt) return held.token;
    const res = await request("POST", "auth/token/renew-self", "renewing the registry's OpenBao token", {
      token: held.token,
      body: {},
    });
    const lease = (res.json as { auth?: { lease_duration?: unknown } } | undefined)?.auth?.lease_duration;
    if (res.ok && typeof lease === "number" && lease > 0) {
      session = { token: held.token, renewAt: now() + Math.floor(lease * 1000 * (2 / 3)) };
      return held.token;
    }
    session = undefined;
    return login();
  };

  const authed = async (method: string, path: string, stage: string, body?: unknown): Promise<OpenBaoApiResult> => {
    const token = await currentToken();
    const first = await request(method, path, stage, { token, ...(body === undefined ? {} : { body }) });
    if (first.status !== 403) {
      if (first.status >= 500) throw openbaoUnreachable(stage, `HTTP ${first.status}`);
      return first;
    }
    session = undefined;
    const fresh = await login();
    const second = await request(method, path, stage, { token: fresh, ...(body === undefined ? {} : { body }) });
    if (second.status >= 500) throw openbaoUnreachable(stage, `HTTP ${second.status}`);
    return second;
  };

  const provision = async (
    orgId: string,
    type: string,
    prepare?: (mount: string) => Promise<void>,
  ): Promise<string> => {
    assertPathSegment(orgId);
    if (namespacePrefix === undefined) {
      if (prepare !== undefined) await prepare(type);
      return type;
    }
    const namespace = `${namespacePrefix}/${orgId}`;
    const stage = "creating the organisation's OpenBao namespace";
    const existing = await authed("GET", `${namespacePrefix}/sys/namespaces/${orgId}`, stage);
    if (!existing.ok) {
      if (existing.status !== 404) throw openbaoRefused(stage, existing.status);
      const made = await authed("POST", `${namespacePrefix}/sys/namespaces/${orgId}`, stage);
      if (!made.ok && !errorsOf(made).some((e) => /exist/i.test(e))) throw openbaoRefused(stage, made.status);
    }
    const mountStage = `mounting ${type} in the organisation's namespace`;
    const mounted = await authed("POST", `${namespace}/sys/mounts/${type}`, mountStage, { type });
    if (!mounted.ok && !errorsOf(mounted).some((e) => /already in use/i.test(e))) {
      throw openbaoRefused(mountStage, mounted.status);
    }
    const mount = `${namespace}/${type}`;
    if (prepare !== undefined) await prepare(mount);
    return mount;
  };

  return {
    namespacePrefix,
    request,
    authed,

    async ensureMount(orgId, type, prepare) {
      const cacheKey = `${type} ${orgId}`;
      const cached = mounts.get(cacheKey);
      if (cached !== undefined) return cached;
      const running = provisioning.get(cacheKey);
      if (running !== undefined) return running;
      const started = provision(orgId, type, prepare).then(
        (mount) => {
          mounts.set(cacheKey, mount);
          provisioning.delete(cacheKey);
          return mount;
        },
        (err: unknown) => {
          provisioning.delete(cacheKey);
          throw err;
        },
      );
      provisioning.set(cacheKey, started);
      return started;
    },
  };
};

export interface OpenBaoConfig {
  openbaoAddr?: string | undefined;
  openbaoRoleId?: string | undefined;
  openbaoSecretId?: string | undefined;
  openbaoNamespacePrefix?: string | undefined;
}

export const createOpenBaoClientFor = (config: OpenBaoConfig): OpenBaoClient | undefined => {
  if (
    config.openbaoAddr === undefined ||
    config.openbaoRoleId === undefined ||
    config.openbaoSecretId === undefined
  ) {
    return undefined;
  }
  return createOpenBaoClient({
    addr: config.openbaoAddr,
    roleId: config.openbaoRoleId,
    secretId: config.openbaoSecretId,
    ...(config.openbaoNamespacePrefix === undefined ? {} : { namespacePrefix: config.openbaoNamespacePrefix }),
  });
};
