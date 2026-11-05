import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { REGISTRY_ORIGIN, startRegistry, type Person, type TestRegistry } from "../../support/registry.ts";
import { page } from "./guard-device.ts";
import { withHosted } from "./server-options.ts";

type Json = Record<string, any>;

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const REGISTRY_MAIN = path.join(REPO, "apps", "registry", "src", "main.ts");
const SESSION_SECRET = "guard-tests-session-secret-0123456789abcdef0123";

const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const inline = (html: string, tag: "script" | "style") => [...html.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map((match) => match[1] ?? "");

interface Discovery {
  readonly issuer: string;
  readonly hits: () => number;
  close(): Promise<void>;
}

const startDiscovery = async (unavailableFirst = 0): Promise<Discovery> => {
  const jwk = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({ format: "jwk" });
  let hits = 0;
  const server = http.createServer((req, res) => {
    const issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/idp`;
    res.setHeader("content-type", "application/json");
    if (req.url === "/idp/.well-known/openid-configuration") {
      hits += 1;
      if (hits <= unavailableFirst) {
        res.statusCode = 503;
        res.end("{}");
        return;
      }
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
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    issuer: `http://127.0.0.1:${(server.address() as AddressInfo).port}/idp`,
    hits: () => hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

const oidcRegistry = (discovery: Discovery, name: string, issuer: string = discovery.issuer) =>
  startRegistry({
    domain: "guard-oidc.example",
    configure: withHosted((hosted) => ({
      ...hosted,
      oidc: { issuer, clientId: "guard-self-host", clientSecret: "self-host-client-secret-not-real", provider: "oidc", name },
    })),
  });

const registryEnv = (dataDir: string, extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: dataDir,
  NODE_ENV: "test",
  PORT: "0",
  HOST: "127.0.0.1",
  VIBTRA_REGISTRY_DATA_DIR: dataDir,
  REGISTRY_MODE: "hosted",
  REGISTRY_BASE_URL: "http://registry.test.local",
  REGISTRY_SESSION_SECRET: SESSION_SECRET,
  REGISTRY_OIDC_CLIENT_ID: "guard-self-host",
  REGISTRY_OIDC_CLIENT_SECRET: "self-host-client-secret-not-real",
  ...extra,
});

const refusedBoot = (dataDir: string, extra: Record<string, string>): string => {
  const result = spawnSync(process.execPath, ["--import", "tsx", REGISTRY_MAIN], { cwd: REPO, env: registryEnv(dataDir, extra), encoding: "utf8", timeout: 60_000 });
  expect(result.status, result.stdout + result.stderr).toBe(1);
  return result.stderr;
};

const bootedLogin = async (dataDir: string, extra: Record<string, string>): Promise<string> => {
  const child = spawn(process.execPath, ["--import", "tsx", REGISTRY_MAIN], { cwd: REPO, env: registryEnv(dataDir, extra), stdio: ["ignore", "pipe", "pipe"] });
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
    const login = await page(`${url}/login`);
    expect(login.status).toBe(200);
    return login.text;
  } finally {
    child.kill("SIGTERM");
  }
};

let registry: TestRegistry;
let owner: Person;
let admin: Person;
let member: Person;
let dee: Person;

beforeAll(async () => {
  registry = await startRegistry({ domain: "guard-entry.example" });
  ({ owner, admin, member } = registry.people);
  dee = await registry.join("dee");
});

afterAll(async () => {
  await registry?.close();
});

describe("the sign-in pages", () => {
  it("serves GET /login as a single card: Sign in to Guard, Continue with Google with the G, legal links, nothing external", async () => {
    const res = await page(`${registry.url}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/html/);
    const html = res.text;
    expect(html).toContain("<title>Sign in to Guard</title>");
    expect(html).toContain("<h1>Sign in to Guard</h1>");
    expect(html).toMatch(/<button type="button" class="provider" id="signin" data-provider="google" data-label="Google">/);
    expect(html).toContain("Continue with Google");
    for (const colour of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) expect(html).toContain(`fill="${colour}"`);
    expect(html).toContain('href="/privacy"');
    expect(html).toContain('href="/terms"');
    expect(html).toMatch(/id="status" role="status" aria-live="polite"/);
    expect(html).toContain("prefers-color-scheme:dark");
    expect(html).toContain("prefers-reduced-motion:reduce");
    expect(html).not.toMatch(/(?:src|href|action)=["']?(?:https?:)?\/\//i);
    expect(html).not.toMatch(/<link\b(?![^>]*href="data:,")|<script\s+src|@import|url\(/i);
    expect(html).not.toContain("main console");
  });

  it("ships a strict CSP on both pages whose hashes are exactly their one inline style and script, and echoes no query input", async () => {
    for (const url of ["/login", "/start", "/login?invitation=inv_1&error=VALIDATION"]) {
      const res = await page(`${registry.url}${url}`);
      expect([url, res.status]).toEqual([url, 200]);
      const body = res.text;
      const csp = String(res.headers.get("content-security-policy"));
      const scripts = inline(body, "script");
      const styles = inline(body, "style");
      expect([url, scripts.length, styles.length]).toEqual([url, 1, 1]);
      expect(csp).toContain(`script-src ${hashOf(scripts[0] ?? "")}`);
      expect(csp).toContain(`style-src ${hashOf(styles[0] ?? "")}`);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(body).not.toMatch(/\sstyle=/);
      expect(body).not.toMatch(/\son[a-z]+=/i);
      expect(body).not.toContain("inv_1");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("serves GET /start as the same card, saying it is signing you in, and keeps the redirect to /<handle>/guard", async () => {
    const res = await page(`${registry.url}/start`);
    expect(res.status).toBe(200);
    const body = res.text;
    expect(body).toContain("Signing you in…");
    expect(body).toContain('data-page="start"');
    expect(body).toContain("fetch('/api/console/session'");
    expect(body).toContain("location.replace('/'+encodeURIComponent(h)+'/guard')");
    expect(body).toContain("/api/auth/organization/accept-invitation");
  });
});

describe("people doors the Guard People page uses", () => {
  it("changes a role, refuses to leave no owner or to act on yourself, and removes somebody", async () => {
    const people = await registry.consoleGet(owner, "/people");
    expect((people.body as Json).mayManage).toBe(true);
    const row = (page: unknown, who: Person): Json => ((page as Json).rows as Json[]).find((entry) => entry.subject === who.userId) ?? {};
    expect(row(people.body, owner)).toMatchObject({ orgRole: "owner", isYou: true, mayManage: false });
    expect(row(people.body, member)).toMatchObject({ orgRole: "member", mayManage: true });

    const promoted = await registry.consoleWrite(owner, "POST", `/people/${member.userId}/role`, { role: "admin" });
    expect(promoted.status, promoted.text).toBe(200);
    expect(row(promoted.body, member).orgRole).toBe("admin");

    expect(row((await registry.consoleGet(admin, "/people")).body, owner).mayManage).toBe(false);
    const refused = await registry.consoleWrite(admin, "POST", `/people/${owner.userId}/role`, { role: "member" });
    expect([refused.status, (refused.body as Json).message]).toEqual([403, "This organisation would be left with no owner. Make somebody else an owner first"]);
    const self = await registry.consoleWrite(owner, "POST", `/people/${owner.userId}/role`, { role: "member" });
    expect([self.status, (self.body as Json).message]).toEqual([403, "You cannot do that to your own account"]);

    const removed = await registry.consoleWrite(owner, "DELETE", `/people/${dee.userId}`);
    expect(removed.status, removed.text).toBe(200);
    expect(((removed.body as Json).rows as Json[]).some((entry) => entry.subject === dee.userId)).toBe(false);
  });

  it("emails an invitation whose link is /login?invitation=, and Better Auth's accept door admits the invited person once", async () => {
    const sent: Json[] = [];
    const mailing = await startRegistry({
      domain: "guard-invite.example",
      configure: (options) =>
        withHosted((hosted) => ({ ...hosted, resendApiKey: "re_test_FAKE_not_a_key", mailFrom: "Guard <no-reply@guard-invite.example>" }))({
          ...options,
          mailFetch: async (_url: string, init?: RequestInit) => {
            sent.push(JSON.parse(String(init?.body)) as Json);
            return new Response(JSON.stringify({ id: "made-up-mail-id" }), { status: 200, headers: { "content-type": "application/json" } });
          },
        }),
    });
    try {
      const { owner: inviter, member: plain } = mailing.people;
      const memberTry = await mailing.consoleWrite(plain, "POST", "/people/invitations", { email: "new@elsewhere.example", role: "member" });
      expect([memberTry.status, (memberTry.body as Json).code]).toEqual([403, "admin_only"]);
      expect(sent).toEqual([]);

      const invited = await mailing.consoleWrite(inviter, "POST", "/people/invitations", { email: " New@Elsewhere.example ", role: "admin" });
      expect(invited.status, invited.text).toBe(200);
      expect(invited.body).toMatchObject({ email: "new@elsewhere.example", role: "admin", emailed: true });
      const id = String((invited.body as Json).invitationId);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.to).toEqual(["new@elsewhere.example"]);
      expect(String(sent[0]?.text)).toContain(`${REGISTRY_ORIGIN}/login?invitation=${encodeURIComponent(id)}`);
      expect(String(sent[0]?.text)).not.toContain("accept-invitation");

      const newcomer = await mailing.join("new", "elsewhere.example");
      const accept = () =>
        page(`${mailing.url}/api/auth/organization/accept-invitation`, {
          method: "POST",
          headers: { cookie: newcomer.cookie, origin: REGISTRY_ORIGIN, "content-type": "application/json" },
          body: JSON.stringify({ invitationId: id }),
        });
      expect((await accept()).status).toBe(200);
      const people = await mailing.consoleGet(inviter, "/people");
      expect(((people.body as Json).rows as Json[]).find((entry) => entry.email === "new@elsewhere.example")).toMatchObject({ orgRole: "admin" });
      const again = await accept();
      expect(again.status).toBe(400);
      expect(typeof (JSON.parse(again.text) as { message?: unknown }).message).toBe("string");
    } finally {
      await mailing.close();
    }
  });

  it("answers emailed:false when the registry has no mail transport", async () => {
    const invited = await registry.consoleWrite(owner, "POST", "/people/invitations", { email: "later@elsewhere.example", role: "member" });
    expect(invited.status, invited.text).toBe(200);
    expect(invited.body).toMatchObject({ email: "later@elsewhere.example", role: "member", emailed: false });
  });
});

describe("the Sign-ups doors", () => {
  it("name the operator's own domain to the operator, and hide from everybody else", async () => {
    const operator = await startRegistry({
      domain: "acme.example",
      configure: withHosted((hosted) => ({ ...hosted, registration: { mode: "allowlist", operatorDomain: "acme.example" } })),
    });
    try {
      const { owner: ada, admin: bo, member: cy } = operator.people;
      const page = await operator.consoleGet(ada, "/registration");
      expect(page.status, page.text).toBe(200);
      expect(page.body).toMatchObject({ mode: "allowlist", operatorDomain: "acme.example", mayManage: true, rows: [] });
      expect((await operator.consoleGet(bo, "/registration")).body).toMatchObject({ mayManage: false, operatorDomain: "acme.example" });
      expect((await operator.consoleGet(cy, "/registration")).status).toBe(403);

      const added = await operator.consoleWrite(ada, "POST", "/registration/allowlist", { subject: " Partner.Example " });
      expect(added.status, added.text).toBe(200);
      expect((added.body as Json).rows).toEqual([expect.objectContaining({ subject: "partner.example", kind: "domain", addedBy: ada.email })]);
      const person = await operator.consoleWrite(ada, "POST", "/registration/allowlist", { subject: "Lee@Partner.Example" });
      expect(((person.body as Json).rows as Json[]).map((entry) => entry.kind).sort()).toEqual(["domain", "email"]);
      const twice = await operator.consoleWrite(ada, "POST", "/registration/allowlist", { subject: "partner.example" });
      expect([twice.status, (twice.body as Json).message]).toEqual([403, "partner.example is already on the sign-up list"]);
      expect((await operator.consoleWrite(ada, "POST", "/registration/allowlist", { subject: "a@b@c.example" })).status).toBe(400);
      expect((await operator.consoleWrite(bo, "POST", "/registration/allowlist", { subject: "x.example" })).status).toBe(403);
      const removed = await operator.consoleWrite(ada, "DELETE", `/registration/allowlist/${((added.body as Json).rows as Json[])[0]?.id}`);
      expect((removed.body as Json).rows).toHaveLength(1);
    } finally {
      await operator.close();
    }

    const outsider = await startRegistry({
      domain: "other.example",
      configure: withHosted((hosted) => ({ ...hosted, registration: { mode: "open", operatorDomain: "acme.example" } })),
    });
    try {
      expect((await outsider.consoleGet(outsider.people.owner, "/registration")).status).toBe(403);
    } finally {
      await outsider.close();
    }
  });

  it("is a 404 on a registry with no operator domain", async () => {
    expect((await registry.consoleGet(owner, "/registration")).status).toBe(404);
  });
});

describe("self-hosted sign-in through the operator's OIDC provider", () => {
  const dirs: string[] = [];
  const discoveries: Discovery[] = [];

  const tempDir = async (): Promise<string> => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "guard-self-host-"));
    dirs.push(dir);
    return dir;
  };

  const discovery = async (unavailableFirst = 0): Promise<Discovery> => {
    const started = await startDiscovery(unavailableFirst);
    discoveries.push(started);
    return started;
  };

  afterEach(async () => {
    await Promise.all(discoveries.splice(0).map((started) => started.close()));
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reads the provider from the environment at boot and refuses unsafe or incomplete settings", async () => {
    expect(refusedBoot(await tempDir(), { REGISTRY_OIDC_PROVIDER: "oidc" })).toMatch(/requires REGISTRY_OIDC_ISSUER/);
    expect(refusedBoot(await tempDir(), { REGISTRY_OIDC_PROVIDER: "saml" })).toMatch(/'google' or 'oidc'/);
    expect(
      refusedBoot(await tempDir(), { REGISTRY_BASE_URL: "https://guard.acme.example", REGISTRY_OIDC_PROVIDER: "oidc", REGISTRY_OIDC_ISSUER: "http://login.acme.example" }),
    ).toMatch(/must use https/);
    const idp = await discovery();
    const named = await bootedLogin(await tempDir(), { REGISTRY_OIDC_PROVIDER: "oidc", REGISTRY_OIDC_ISSUER: idp.issuer, REGISTRY_OIDC_NAME: "Acme SSO" });
    expect(named).toContain('data-provider="oidc"');
    expect(named).toContain("Continue with Acme SSO");
    const google = await bootedLogin(await tempDir(), {});
    expect(google).toContain('data-provider="google"');
    expect(google).toContain("Continue with Google");
  }, 180_000);

  it("waits for discovery before it serves, and refuses an issuer that does not match exactly", async () => {
    const slow = await discovery(1);
    const waited = await oidcRegistry(slow, "Acme SSO");
    try {
      expect(slow.hits()).toBeGreaterThanOrEqual(2);
      expect((await page(`${waited.url}/login`)).status).toBe(200);
    } finally {
      await waited.close();
    }
    const idp = await discovery();
    await expect(oidcRegistry(idp, "Acme SSO", `${idp.issuer}/`)).rejects.toThrow(/does not match/);
  }, 30_000);

  it("escapes the provider's label, offers only that provider, and starts a PKCE and nonce authorization request", async () => {
    const idp = await discovery();
    const selfHosted = await oidcRegistry(idp, `Acme <SSO> & "Co"`);
    try {
      const login = await page(`${selfHosted.url}/login`);
      expect(login.status).toBe(200);
      const html = login.text;
      expect(html).toContain('data-provider="oidc"');
      expect(html).toContain("Continue with Acme &lt;SSO&gt; &amp; &quot;Co&quot;");
      expect(html).not.toContain("<SSO>");
      expect(html).not.toContain("#4285F4");
      expect(html).not.toContain("Google");

      const start = (provider: string) =>
        page(`${selfHosted.url}/api/auth/sign-in/social`, {
          method: "POST",
          headers: { "content-type": "application/json", origin: REGISTRY_ORIGIN },
          body: JSON.stringify({ provider, callbackURL: `${REGISTRY_ORIGIN}/start` }),
        });
      const started = await start("oidc");
      expect(started.status).toBe(200);
      const url = new URL(String((JSON.parse(started.text) as { url?: unknown }).url));
      expect(`${url.origin}${url.pathname}`).toBe(`${idp.issuer}/auth`);
      expect(url.searchParams.get("client_id")).toBe("guard-self-host");
      expect(url.searchParams.get("redirect_uri")).toBe(`${REGISTRY_ORIGIN}/api/auth/callback/oidc`);
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.get("nonce")).toBeTruthy();
      expect(url.searchParams.get("scope")?.split(" ")).toEqual(expect.arrayContaining(["openid", "email", "profile"]));
      expect((await start("google")).status).toBeGreaterThanOrEqual(400);
    } finally {
      await selfHosted.close();
    }
  });
});
