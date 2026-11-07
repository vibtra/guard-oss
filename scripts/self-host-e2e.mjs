#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { decideContent, GUARD_PROTOCOL_VERSION } = await import(path.join(ROOT, "packages/guard-contract/src/index.ts"));
const { digestOf, verifyGuardBundle, verifyGuardCatalogue } = await import(path.join(ROOT, "packages/guard-contract/src/signing.ts"));

const BASE = (process.env.GUARD_E2E_BASE_URL ?? "http://localhost:4700").replace(/\/+$/, "");
const OWNER = process.env.GUARD_E2E_EMAIL ?? "";
const PASSWORD = process.env.GUARD_E2E_PASSWORD ?? "";
const [phase, stateFile] = process.argv.slice(2);
const say = (line) => console.log(`[self-host-e2e] ${line}`);
const check = (ok, what) => {
  if (!ok) throw new Error(`FAILED: ${what}`);
  say(`ok  ${what}`);
};

const jar = new Map();
const cookieHeader = (url) => [...(jar.get(new URL(url).host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join("; ");
const keep = (url, res) => {
  const host = new URL(url).host;
  const mine = jar.get(host) ?? new Map();
  for (const line of res.headers.getSetCookie()) {
    const [pair, ...attrs] = line.split(";");
    const at = pair.indexOf("=");
    const name = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a)) || value === "";
    if (expired) mine.delete(name);
    else mine.set(name, value);
  }
  jar.set(host, mine);
};
const browse = async (url, init = {}) => {
  const res = await fetch(url, { ...init, redirect: "manual", headers: { ...(init.headers ?? {}), cookie: cookieHeader(url) } });
  keep(url, res);
  return res;
};
const json = async (res) => {
  const text = await res.text();
  return text ? JSON.parse(text) : {};
};

const signIn = async (email = OWNER, password = PASSWORD, expectRefusal = false) => {
  const login = await browse(`${BASE}/login`);
  const page = await login.text();
  check(login.status === 200 && /Continue with /.test(page) && page.includes('data-provider="oidc"'), "the /login page offers the configured OIDC provider");
  const started = await browse(`${BASE}/api/auth/sign-in/social`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ provider: "oidc", callbackURL: `${BASE}/start` }),
  });
  const { url } = await json(started);
  check(started.status === 200 && typeof url === "string", "Better Auth starts the OIDC authorization request");
  let at = url;
  let res = await browse(at);
  for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 10; hops += 1) {
    at = new URL(res.headers.get("location"), at).href;
    res = await browse(at);
  }
  const form = await res.text();
  const action = /<form[^>]*method="post"[^>]*action="([^"]+)"/i.exec(form)?.[1] ?? /<form[^>]*action="([^"]+)"[^>]*method="post"/i.exec(form)?.[1];
  check(res.status === 200 && action !== undefined, "the identity provider shows its own password form");
  at = new URL(action.replaceAll("&amp;", "&"), at).href;
  res = await browse(at, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ login: email, password }).toString() });
  for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 10; hops += 1) {
    at = new URL(res.headers.get("location"), at).href;
    if (at.startsWith(`${BASE}/api/auth/callback/oidc`)) break;
    res = await browse(at);
  }
  check(at.startsWith(`${BASE}/api/auth/callback/oidc`), "the provider redirects to /api/auth/callback/oidc with a code");
  const callback = await browse(at);
  const landed = callback.headers.get("location") ?? "";
  if (expectRefusal) {
    check(callback.status === 302 && !landed.startsWith(`${BASE}/start`) && landed.includes("error"), `the callback refuses ${email} (lands on ${landed.split("?")[0]} with an error)`);
    return session();
  }
  check(callback.status === 302 && landed.startsWith(`${BASE}/start`), `the callback signs in and lands on /start (got ${callback.status} ${landed.split("?")[0]})`);
  const start = await browse(`${BASE}/start`);
  check(start.status === 200, "/start loads");
  return session();
};

const session = async () => {
  const res = await browse(`${BASE}/api/console/session`);
  const body = await json(res);
  const csrf = jar.get(new URL(BASE).host)?.get("vibtra_csrf");
  return { status: res.status, body, csrf };
};

const consoleCall = async (method, p, body) => {
  const s = method === "GET" ? undefined : await session();
  const res = await browse(`${BASE}/api/console${p}`, {
    method,
    headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...(s ? { origin: BASE, "x-vibtra-csrf": s.csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await json(res) };
};

const FACTS = { hostname: "selfhost-sim-mac", osVersion: "26.0.1", osBuild: "25A362", agentVersion: "0.1.0", arch: "arm64", primaryUser: "owner", modelIdentifier: "Mac16,1" };
const CA = { fingerprintSha256: "cd".repeat(32), subject: "CN=Vibtra Guard local CA (self-host proof)", notAfter: "2036-10-24T00:00:00.000Z" };
const agent = async (method, p, token, body) => {
  const res = await fetch(`${BASE}/api/guard/v1${p}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, json: await json(res) };
};
const eventId = () => `gev_${randomBytes(8).toString("hex")}`;

const syncRules = async (device) => {
  const pre = await agent("POST", `/preflight/${device.deviceId}`, device.deviceToken, { protocol: GUARD_PROTOCOL_VERSION, device: FACTS, ca: CA, clientMode: "enforce", pendingEvents: 0, health: { caTrusted: true, proxyListening: true } });
  check(pre.status === 200, `preflight with the device bearer (HTTP ${pre.status})`);
  check(pre.json.signingKeyId === device.keyId, "the server signs with the key the laptop pinned at enrolment");
  const dl = await agent("POST", `/ruledownload/${device.deviceId}`, device.deviceToken, { protocol: GUARD_PROTOCOL_VERSION });
  check(dl.status === 200 && dl.json.bundle !== undefined && dl.json.catalogue !== undefined, "ruledownload sends the bundle and the catalogue");
  check(verifyGuardBundle(dl.json.bundle, device.publicKeyPem, device.keyId, device.deviceId).ok, "the bundle signature verifies with the pinned public key");
  check(verifyGuardCatalogue(dl.json.catalogue, device.publicKeyPem, device.keyId).ok, "the catalogue signature verifies with the pinned public key");
  return { pre: pre.json, bundle: dl.json.bundle.bundle, catalogue: dl.json.catalogue.catalogue };
};

const RULE_NAME = "Project Nightjar";
const KEYWORD = "PROJECT-NIGHTJAR";

const setup = async () => {
  check(OWNER !== "" && PASSWORD !== "", "GUARD_E2E_EMAIL and GUARD_E2E_PASSWORD are set");
  const me = await signIn();
  check(me.status === 200 && typeof me.body.handle === "string", `signed in with an organisation (${me.body.handle})`);
  check(me.body.orgRole === "owner" && me.body.role === "admin", "the first person from the operator's domain is the owner");
  const handle = me.body.handle;

  const dash = await browse(`${BASE}/${handle}/guard`);
  const html = await dash.text();
  const asset = /\/assets\/guard\/[^"']+\.js/.exec(html)?.[0];
  check(dash.status === 200 && asset !== undefined, "the web dashboard is served at /<handle>/guard");
  check((await browse(`${BASE}${asset}`)).status === 200, "the dashboard's script loads");

  check((await consoleCall("PUT", "/guard/settings", { clientMode: "enforce" })).status === 200, "Guard set to enforce");
  const rules = await consoleCall("PUT", "/guard/rules", {
    baseVersion: 0,
    document: {
      defaultAction: "allow",
      serviceRules: [],
      contentRules: [{ name: RULE_NAME, detector: { kind: "keyword", keywords: [KEYWORD] }, services: "*", audience: { kind: "org" }, action: "block", enabled: true, note: "Synthetic rule for the self-host proof." }],
    },
  });
  check(rules.status === 200, `policy saved (HTTP ${rules.status})`);
  const ruleId = rules.json.document.contentRules.find((r) => r.name === RULE_NAME)?.ruleId;
  check(typeof ruleId === "string", "the content rule has an id");

  const link = await consoleCall("POST", "/guard/devices/enrol-links", { personEmail: me.body.email ?? OWNER, note: "self-host proof laptop" });
  check(link.status === 201 && typeof link.json.token === "string", "enrol link minted");
  const enrol = await agent("POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.json.token, device: FACTS, ca: CA });
  check(enrol.status === 201, `simulated laptop enrolled through POST /api/guard/v1/enrol (HTTP ${enrol.status})`);
  check(enrol.json.server.baseUrl === BASE, "the enrolment names this server's URL");
  const device = { deviceId: enrol.json.deviceId, deviceToken: enrol.json.deviceToken, keyId: enrol.json.signing.keyId, publicKeyPem: enrol.json.signing.publicKeyPem };
  check((await agent("POST", "/enrol", undefined, { protocol: GUARD_PROTOCOL_VERSION, enrolToken: link.json.token, device: FACTS, ca: CA })).status >= 400, "the enrol link is single use");

  const synced = await syncRules(device);
  check(synced.bundle.contentRules.some((r) => r.ruleId === ruleId), "the signed bundle carries the synthetic content rule");

  const nonce = randomBytes(6).toString("hex");
  const prompts = [`What is a good name for a cat? ${nonce}`, `Summarise the ${KEYWORD} budget for me ${nonce}`, `Thanks, and a dog name? ${nonce}`];
  const service = { serviceId: "openai-chatgpt" };
  const decisions = prompts.map((text) => decideContent(synced.bundle, service, { text }));
  check(decisions.map((d) => d.action).join(",") === "allow,block,allow", "normal → blocked → normal under the signed bundle");
  check(decisions[1].decidedBy?.ruleId === ruleId, "the block is decided by the synthetic rule");

  const now = Date.now();
  const at = (i) => new Date(now + i * 1000).toISOString();
  const base = { kind: "flow", host: "chatgpt.com", port: 443, method: "POST", pathHint: "/backend-api", serviceId: "openai-chatgpt", app: { name: "Safari", bundleId: "com.apple.Safari" }, bundleVersion: synced.bundle.bundleVersion };
  const events = [
    { ...base, eventId: eventId(), occurredAt: at(0), action: "allowed", bytes: 220 },
    { ...base, eventId: eventId(), occurredAt: at(1), kind: "content", action: "blocked", ruleId, ruleKind: "content", matchType: "keyword", matchCount: 1, bytes: 240 },
    { ...base, eventId: eventId(), occurredAt: at(2), action: "allowed", bytes: 210 },
  ];
  const smuggled = eventId();
  const withBody = await agent("POST", `/eventupload/${device.deviceId}`, device.deviceToken, { protocol: GUARD_PROTOCOL_VERSION, events: [{ ...events[0], eventId: smuggled, body: prompts[1] }] });
  check(
    withBody.status === 400 || (withBody.status === 200 && withBody.json.accepted === 0 && withBody.json.rejected?.[0]?.eventId === smuggled),
    `an event carrying a prompt body is rejected (HTTP ${withBody.status}, accepted ${withBody.json.accepted ?? 0})`,
  );
  const up = await agent("POST", `/eventupload/${device.deviceId}`, device.deviceToken, { protocol: GUARD_PROTOCOL_VERSION, events });
  check(up.status === 200 && up.json.accepted === 3, "three metadata-only events uploaded");
  const post = await agent("POST", `/postflight/${device.deviceId}`, device.deviceToken, {
    protocol: GUARD_PROTOCOL_VERSION,
    bundleVersion: synced.bundle.bundleVersion,
    catalogueVersion: synced.catalogue.version,
    rulesReceived: synced.bundle.contentRules.length,
    rulesProcessed: synced.bundle.contentRules.length,
    clientMode: "enforce",
    bundleDigest: digestOf(synced.bundle),
  });
  check(post.status === 200, "postflight recorded");

  const activity = await consoleCall("GET", "/guard/activity?limit=50");
  const text = JSON.stringify(activity.json);
  check(activity.status === 200 && text.includes(events[1].eventId) && text.includes(ruleId), "the owner sees the block event on Activity");
  check(text.includes(events[0].eventId) && text.includes(events[2].eventId), "the owner sees the allowed prompts before and after the block on Activity");
  check(!text.includes(nonce) && !text.includes(`the ${KEYWORD} budget`), "Activity holds no prompt text");
  const devices = await consoleCall("GET", "/guard/devices");
  check(devices.status === 200 && JSON.stringify(devices.json).includes(device.deviceId), "the device is listed on Devices");

  const state = { handle, ruleId, rulesVersion: rules.json.document.version ?? rules.json.version, blockedEventId: events[1].eventId, nonce, device, cookies: Object.fromEntries(jar.get(new URL(BASE).host)) };
  writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
  say(`PASS setup: org ${handle}, rule ${ruleId}, device ${device.deviceId}, bundle ${synced.bundle.bundleVersion}; prompt nonce ${nonce}`);
};

const verify = async () => {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  jar.set(new URL(BASE).host, new Map(Object.entries(state.cookies)));
  const me = await session();
  check(me.status === 200 && me.body.handle === state.handle, "the owner's existing session is still valid");
  const rules = await consoleCall("GET", "/guard/rules");
  const rule = rules.json.document?.contentRules?.find((r) => r.ruleId === state.ruleId);
  check(rules.status === 200 && rule?.detector?.kind === "keyword", "the policy and its content rule survived");
  const devices = await consoleCall("GET", "/guard/devices");
  check(devices.status === 200 && JSON.stringify(devices.json).includes(state.device.deviceId), "the device is still listed");
  const synced = await syncRules(state.device);
  check(synced.pre.person !== undefined, "the device syncs with its original bearer, no re-enrolment");
  const decision = decideContent(synced.bundle, { serviceId: "openai-chatgpt" }, { text: `Summarise the PROJECT-NIGHTJAR plan ${state.nonce}` });
  check(decision.action === "block" && decision.decidedBy?.ruleId === state.ruleId, "the restored bundle still blocks the synthetic content");
  const activity = await consoleCall("GET", "/guard/activity?limit=50");
  check(activity.status === 200 && JSON.stringify(activity.json).includes(state.blockedEventId), "the earlier block event is still on Activity");
  jar.clear();
  const again = await signIn();
  check(again.status === 200 && again.body.handle === state.handle, "a fresh sign-in lands in the same organisation");
  say(`PASS verify: org ${state.handle}, device ${state.device.deviceId}, signing key ${state.device.keyId}`);
};

const restore = (state) => jar.set(new URL(BASE).host, new Map(Object.entries(state.cookies)));

const link = async () => {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  restore(state);
  const me = await session();
  check(me.status === 200 && me.body.handle === state.handle, "the owner's session mints a link for the guest Mac");
  const minted = await consoleCall("POST", "/guard/devices/enrol-links", { personEmail: me.body.email ?? OWNER, note: "guest Mac (self-host walk)" });
  check(minted.status === 201 && typeof minted.json.url === "string" && minted.json.url.startsWith("vibtra-guard://enrol?"), "enrol link minted for the guest Mac");
  writeFileSync(process.argv[4], `${minted.json.url}\n`, { mode: 0o600 });
};

const activityOf = async () => {
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  restore(state);
  const walk = JSON.parse(readFileSync(process.argv[4], "utf8"));
  const activity = await consoleCall("GET", `/guard/activity?deviceId=${encodeURIComponent(walk.deviceId)}&limit=200`);
  const rows = activity.json.rows ?? [];
  const blocked = rows.find((r) => r.eventId === walk.blockedEventId);
  check(activity.status === 200 && blocked?.action === "blocked" && blocked?.ruleId === state.ruleId, `the owner sees the guest Mac's block ${walk.blockedEventId} on Activity, decided by the synthetic rule`);
  const allowedBefore = rows.filter((r) => r.action === "allowed" && blocked !== undefined && r.occurredAt < blocked.occurredAt).length;
  const allowedAfter = rows.filter((r) => r.action === "allowed" && blocked !== undefined && r.occurredAt > blocked.occurredAt).length;
  check(allowedBefore >= 1 && allowedAfter >= 1, `the owner sees the guest Mac's allowed traffic before (${allowedBefore}) and after (${allowedAfter}) the block on Activity`);
  check(!JSON.stringify(rows).includes("budget for me"), "the guest Mac's Activity holds no prompt text");
  const devices = await consoleCall("GET", "/guard/devices");
  check(devices.status === 200 && JSON.stringify(devices.json).includes(walk.deviceId), `Devices lists the guest Mac ${walk.deviceId}`);
};

const personal = async () => {
  const email = process.env.GUARD_E2E_PERSONAL_EMAIL ?? "";
  const stranger = process.env.GUARD_E2E_STRANGER_EMAIL ?? "";
  check(email !== "" && stranger !== "", "GUARD_E2E_PERSONAL_EMAIL and GUARD_E2E_STRANGER_EMAIL are set");
  jar.clear();
  const second = await signIn(email, PASSWORD, true);
  check(second.status !== 200 || second.body.handle === undefined, `REGISTRY_OWNER_EMAIL ${email} gets no second organisation once this one-organisation server has one`);
  jar.clear();
  const refused = await signIn(stranger, PASSWORD, true);
  check(refused.status !== 200 || refused.body.handle === undefined, `another personal mailbox (${stranger}) gets no organisation`);
};

try {
  if (phase === "setup") await setup();
  else if (phase === "verify") await verify();
  else if (phase === "link") await link();
  else if (phase === "activity") await activityOf();
  else if (phase === "personal") await personal();
  else throw new Error("usage: self-host-e2e.mjs setup|verify|link|activity|personal <state.json> [file]");
} catch (error) {
  console.error(`[self-host-e2e] ${error.message}`);
  process.exit(1);
}
