import { spawn } from "node:child_process";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY_ORIGIN, startRegistry, type TestRegistry } from "../../support/registry.ts";
import { withHosted } from "./server-options.ts";

type Json = Record<string, any>;

const REFUSED = { error: "Not part of Guard" };
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_MAIN = path.join(REPO, "apps", "registry", "src", "main.ts");

interface RawReply {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly text: string;
}

const raw = (base: string, method: string, rawPath: string, init: { cookie?: string; body?: unknown } = {}): Promise<RawReply> =>
  new Promise((resolve, reject) => {
    const { port } = new URL(base);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: rawPath,
        headers: {
          origin: REGISTRY_ORIGIN,
          ...(init.cookie === undefined ? {} : { cookie: init.cookie }),
          ...(body === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(body) }),
        },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
      },
    );
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });

const jsonOf = (text: string): unknown => (text === "" ? undefined : JSON.parse(text));

const cookiesOf = (headers: http.IncomingHttpHeaders): string[] => (headers["set-cookie"] ?? []).map((line) => line.split(";")[0] ?? "");

const jar = (...lists: string[][]): string => {
  const byName = new Map<string, string>();
  for (const pair of lists.flat()) byName.set(pair.slice(0, pair.indexOf("=")), pair);
  return [...byName.values()].filter((pair) => !pair.endsWith("=")).join("; ");
};

const b64url = (value: unknown): string => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const idToken = (key: KeyObject, claims: Json): string => {
  const head = `${b64url({ alg: "ES256", kid: "k1", typ: "JWT" })}.${b64url(claims)}`;
  return `${head}.${sign("sha256", Buffer.from(head), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
};

const expectRefused = (reply: RawReply, what: string) => {
  expect.soft(reply.status, `${what}: ${reply.text}`).toBe(404);
  expect.soft(reply.headers["cache-control"], what).toBe("no-store");
  expect.soft(reply.text === "" ? undefined : jsonOf(reply.text), what).toEqual(REFUSED);
};

const expectReachesBetterAuth = (reply: RawReply, what: string) => {
  expect(reply.text === "" ? undefined : jsonOf(reply.text), `${what}: ${reply.status}`).not.toEqual(REFUSED);
  expect(reply.status, `${what}: ${reply.text}`).not.toBe(404);
};

const signInThrough = async (registry: TestRegistry, provider: string): Promise<{ url: URL; cookies: string[] }> => {
  const started = await raw(registry.url, "POST", "/api/auth/sign-in/social", {
    body: { provider, callbackURL: `${REGISTRY_ORIGIN}/start`, errorCallbackURL: `${REGISTRY_ORIGIN}/login` },
  });
  expect(started.status, started.text).toBe(200);
  return { url: new URL(String((jsonOf(started.text) as Json).url)), cookies: cookiesOf(started.headers) };
};

const finishSignIn = async (registry: TestRegistry, provider: string, started: { url: URL; cookies: string[] }, email: string) => {
  const state = started.url.searchParams.get("state") ?? "";
  const back = await raw(registry.url, "GET", `/api/auth/callback/${provider}?code=fake-code&state=${encodeURIComponent(state)}`, {
    cookie: jar(started.cookies),
  });
  expect(back.status, back.text).toBe(302);
  expect(back.headers.location).toBe(`${REGISTRY_ORIGIN}/start`);
  const cookie = jar(started.cookies, cookiesOf(back.headers));

  const session = await raw(registry.url, "GET", "/api/auth/get-session", { cookie });
  expect(session.status, session.text).toBe(200);
  expect((jsonOf(session.text) as Json).user.email).toBe(email);

  const out = await raw(registry.url, "POST", "/api/auth/sign-out", { cookie, body: {} });
  expect(out.status, out.text).toBe(200);
  const after = await raw(registry.url, "GET", "/api/auth/get-session", { cookie: jar(started.cookies, cookiesOf(back.headers), cookiesOf(out.headers)) });
  expect(after.status).toBe(200);
  expect(jsonOf(after.text) ?? null).toBeNull();
};

describe("the /api/auth allow-list", () => {
  let registry: TestRegistry;
  let orgId: string;

  beforeAll(async () => {
    registry = await startRegistry({ domain: "auth-allow-list.example" });
    const session = await registry.consoleGet(registry.people.owner, "/session");
    orgId = String((session.body as Json).orgId);
  });

  afterAll(async () => {
    await registry?.close();
  });

  it("refuses the Better Auth plugin doors Guard does not use, signed in or not", async () => {
    const { owner, member } = registry.people;
    expectRefused(await raw(registry.url, "POST", "/api/auth/organization/update", { cookie: owner.cookie, body: { organizationId: orgId, data: { name: "Renamed" } } }), "organization/update");
    expectRefused(await raw(registry.url, "GET", "/api/auth/token", { cookie: member.cookie }), "token");
    expectRefused(await raw(registry.url, "POST", "/api/auth/device/code", { body: { client_id: "vibtra-cli" } }), "device/code");
    expectRefused(await raw(registry.url, "POST", "/api/auth/update-user", { cookie: member.cookie, body: { image: "https://attacker.example/p.png" } }), "update-user");
    expectRefused(await raw(registry.url, "POST", "/api/auth/organization/invite-member", { cookie: owner.cookie, body: { organizationId: orgId, email: "x@elsewhere.example", role: "owner" } }), "invite-member");
    expectRefused(await raw(registry.url, "GET", "/api/auth/organization/get-invitation?id=nope", { cookie: member.cookie }), "get-invitation");
    expectRefused(await raw(registry.url, "GET", "/api/auth/jwks"), "jwks");
    expectRefused(await raw(registry.url, "GET", "/api/auth/error"), "error");
    expectRefused(await raw(registry.url, "POST", "/api/auth/sign-in/oauth2", { body: { providerId: "oidc" } }), "sign-in/oauth2");
  });

  it("refuses a listed door reached by a trailing slash, another case, dot segments, an encoded slash, a double slash or the wrong method", async () => {
    const { member } = registry.people;
    for (const [method, rawPath] of [
      ["GET", "/api/auth/get-session/"],
      ["GET", "/api/auth/Get-Session"],
      ["GET", "/api/auth/get-session/../token"],
      ["GET", "/api/auth/./token"],
      ["GET", "/api/auth/%2E%2E/auth/token"],
      ["GET", "/api/auth/callback/google%2F..%2F..%2Ftoken"],
      ["GET", "/api/auth/callback/..%2Ftoken"],
      ["GET", "/api/auth//token"],
      ["GET", "/api/auth/get-session\\..\\token"],
      ["GET", "/api/auth/sign-out"],
      ["POST", "/api/auth/ok"],
      ["GET", "/api/auth/sign-in/social"],
      ["POST", "/api/auth/callback/google"],
    ] as const) {
      expectRefused(await raw(registry.url, method, rawPath, { cookie: member.cookie, ...(method === "POST" ? { body: {} } : {}) }), `${method} ${rawPath}`);
    }
  });

  it("still serves the doors Guard's sign-in, invite and health check use", async () => {
    const { member } = registry.people;
    const session = await raw(registry.url, "GET", "/api/auth/get-session?disableCookieCache=true", { cookie: member.cookie });
    expect(session.status, session.text).toBe(200);
    expect((jsonOf(session.text) as Json).user.email).toBe(member.email);
    const ok = await raw(registry.url, "GET", "/api/auth/ok");
    expect([ok.status, jsonOf(ok.text)]).toEqual([200, { ok: true }]);
    expectReachesBetterAuth(await raw(registry.url, "POST", "/api/auth/organization/accept-invitation", { cookie: member.cookie, body: { invitationId: "no-such-invitation" } }), "accept-invitation");
    const sso = await raw(registry.url, "POST", "/api/auth/sign-in/sso", { body: { email: "someone@nobody-has-sso.example", callbackURL: `${REGISTRY_ORIGIN}/start` } });
    expect(jsonOf(sso.text), "sign-in/sso").toEqual({ message: "No provider found for the issuer" });
    expectReachesBetterAuth(await raw(registry.url, "GET", "/api/auth/sso/callback/sso-nobody-example?code=x&state=y"), "sso/callback");
    expectReachesBetterAuth(await raw(registry.url, "GET", "/api/auth/callback/google?code=x&state=y"), "callback/google");
  });

  it("signs a person in through Google, end to end, with Google's token endpoint mocked", async () => {
    const realFetch = globalThis.fetch;
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const email = "gina@auth-allow-list.example";
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://oauth2.googleapis.com/token") {
        const now = Math.floor(Date.now() / 1000);
        const token = idToken(privateKey, { iss: "https://accounts.google.com", aud: "guard-tests-client-id.apps.example", sub: "google-gina", email, email_verified: true, name: "Gina", hd: "auth-allow-list.example", iat: now, exp: now + 600 });
        return new Response(JSON.stringify({ access_token: "ya29.fake", id_token: token, token_type: "Bearer", expires_in: 600 }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return realFetch(input, init);
    };
    try {
      const started = await signInThrough(registry, "google");
      expect(started.url.origin).toBe("https://accounts.google.com");
      expect(started.url.searchParams.get("redirect_uri")).toBe(`${REGISTRY_ORIGIN}/api/auth/callback/google`);
      await finishSignIn(registry, "google", started, email);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("the /api/auth allow-list behind an OIDC provider", () => {
  it("signs a person in through the operator's OIDC provider, end to end", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const email = "dex@auth-oidc.example";
    let nonce = "";
    const idp = http.createServer((req, res) => {
      const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/idp`;
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, aud: "guard-self-host", sub: "dex-person", email, email_verified: true, name: "Dex Person", nonce, iat: now, exp: now + 600 };
      res.setHeader("content-type", "application/json");
      if (req.url === "/idp/.well-known/openid-configuration") {
        res.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/auth`,
            token_endpoint: `${issuer}/token`,
            userinfo_endpoint: `${issuer}/userinfo`,
            jwks_uri: `${issuer}/keys`,
            id_token_signing_alg_values_supported: ["ES256"],
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
          }),
        );
      } else if (req.url === "/idp/keys") {
        res.end(JSON.stringify({ keys: [{ ...jwk, kid: "k1", use: "sig", alg: "ES256" }] }));
      } else if (req.url === "/idp/token") {
        req.resume();
        req.on("end", () => res.end(JSON.stringify({ access_token: "dex-access", id_token: idToken(privateKey, claims), token_type: "Bearer", expires_in: 600 })));
      } else if (req.url?.startsWith("/idp/userinfo")) {
        res.end(JSON.stringify(claims));
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
    await new Promise<void>((resolve) => idp.listen(0, "127.0.0.1", resolve));
    const issuer = `http://127.0.0.1:${(idp.address() as AddressInfo).port}/idp`;
    const registry = await startRegistry({
      domain: "auth-oidc.example",
      configure: withHosted((hosted) => ({
        ...hosted,
        oidc: { issuer, clientId: "guard-self-host", clientSecret: "self-host-client-secret-not-real", provider: "oidc", name: "Dex" },
      })),
    });
    try {
      const started = await signInThrough(registry, "oidc");
      expect(`${started.url.origin}${started.url.pathname}`).toBe(`${issuer}/auth`);
      expect(started.url.searchParams.get("redirect_uri")).toBe(`${REGISTRY_ORIGIN}/api/auth/callback/oidc`);
      nonce = started.url.searchParams.get("nonce") ?? "";
      await finishSignIn(registry, "oidc", started, email);
    } finally {
      await registry.close();
      await new Promise<void>((resolve) => idp.close(() => resolve()));
    }
  });
});

describe("the /api/auth allow-list without test sign-in", () => {
  it("refuses password sign-up and sign-in when test sign-in is off", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "guard-auth-allow-list-"));
    const child = spawn(process.execPath, ["--import", "tsx", REGISTRY_MAIN], {
      cwd: REPO,
      env: {
        PATH: process.env.PATH,
        HOME: dataDir,
        NODE_ENV: "test",
        PORT: "0",
        HOST: "127.0.0.1",
        VIBTRA_REGISTRY_DATA_DIR: dataDir,
        REGISTRY_MODE: "hosted",
        REGISTRY_BASE_URL: "http://registry.test.local",
        REGISTRY_SESSION_SECRET: "guard-tests-session-secret-0123456789abcdef0123",
        REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
        REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`the registry did not listen within 60 s:\n${output}`)), 60_000);
        const read = (chunk: Buffer) => {
          output += chunk.toString("utf8");
          const listening = /listening at (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
          if (listening?.[1] !== undefined) {
            clearTimeout(timer);
            resolve(listening[1]);
          }
        };
        child.stdout.on("data", read);
        child.stderr.on("data", read);
        child.on("exit", (code) => {
          clearTimeout(timer);
          reject(new Error(`the registry exited with ${code}:\n${output}`));
        });
      });
      const body = { email: "pat@registry.test.local", password: "vibtra-test-passphrase-pat", name: "Pat" };
      expectRefused(await raw(url, "POST", "/api/auth/sign-up/email", { body }), "sign-up/email");
      expectRefused(await raw(url, "POST", "/api/auth/sign-in/email", { body }), "sign-in/email");
      const ok = await raw(url, "GET", "/api/auth/ok");
      expect(ok.status).toBe(200);
    } finally {
      const exited = new Promise<void>((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));
      child.kill("SIGTERM");
      await exited;
      await rm(dataDir, { recursive: true, force: true });
    }
  }, 90_000);
});
