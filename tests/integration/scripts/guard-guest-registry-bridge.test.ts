import { X509Certificate } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { GUARD_PROTOCOL_VERSION } from "@vibtra/guard-contract";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runScript } from "./guard-guest-cli.js";
import { ACTIVE, GuestRun, REFUSAL, call, caFacts, facts, freePort, natBridge, occupy, portOpen, writeSourceProfile, type Reply, type RunOptions } from "./guard-guest-bridge.js";

const bridge = natBridge();
const GATEWAY_REFUSED = '{"code":"TEST_GATEWAY_REFUSED"}';
const NOT_A_DOOR = '{"error":"not an admin door"}';
const UNAUTHORIZED = '{"error":"unauthorized"}';
const ONE_MIB = 1024 * 1024;

if (bridge.kind === "missing") {
  const skipLocally = (process.env.CI ?? "") === "" && (process.env.GUARD_TEST_NAT_BRIDGE ?? "") === "";
  const title = `guest registry CLIs need a NAT bridge: ${bridge.reason}. CI creates bridge100 at 192.168.64.1/24 and sets GUARD_TEST_NAT_BRIDGE=bridge100`;
  if (skipLocally) console.warn(`skipped: ${title}`);
  describe("guest registry CLIs on a NAT bridge", () => {
    (skipLocally ? it.skip : it)(title, () => {
      throw new Error(bridge.reason);
    });
  });
} else {
  const { name, host } = bridge;
  const runs: GuestRun[] = [];
  const held: net.Server[] = [];
  let work = "";
  let cases = 0;
  let source = "";

  const prepare = (): { out: string; session: string } => {
    const out = path.join(work, `case-${(cases += 1)}`);
    const result = runScript("guard-guest-registry-prepare.mjs", ["--out", out, "--host", host, "--interface", name]);
    if (result.status !== 0) throw new Error(`prepare failed: ${result.stderr}`);
    return { out, session: path.join(out, "session") };
  };

  const launch = (options: Omit<RunOptions, "host" | "bridge">): GuestRun => {
    const run = new GuestRun({ ...options, host, bridge: name });
    runs.push(run);
    return run;
  };

  const expectRefusedAndGone = async (run: GuestRun, session: string): Promise<void> => {
    expect(await run.exit()).toEqual({ code: 1, signal: null });
    expect(run.stderr).toMatch(REFUSAL);
    expect(run.stdout).not.toContain(ACTIVE);
    expect(existsSync(session)).toBe(false);
  };

  const expectStoppedAndGone = async (run: GuestRun, out: string): Promise<void> => {
    expect(await run.exit()).toEqual({ code: 0, signal: null });
    expect(existsSync(path.join(out, "session"))).toBe(false);
    expect(existsSync(path.join(out, "server.key"))).toBe(true);
  };

  beforeAll(() => {
    work = mkdtempSync(path.join(os.tmpdir(), "guard-guest-bridge-"));
    source = path.join(work, "source-profile");
    writeSourceProfile(source);
  });

  afterAll(async () => {
    for (const run of runs) run.stop();
    await Promise.all(runs.map((run) => run.exited));
    await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
    if (work !== "") rmSync(work, { recursive: true, force: true });
  });

  describe(`guard-guest-registry-prepare.mjs on ${name}`, () => {
    it("prepares TLS material for the bridge address and records the bridge", () => {
      const { out } = prepare();
      expect(JSON.parse(readFileSync(path.join(out, "preparation.json"), "utf8"))).toEqual({
        status: "prepared-not-listening-not-enrolled",
        host,
        interfaceName: name,
        expiresInDays: 2,
        guestTrustApproved: false,
      });
      expect(new X509Certificate(readFileSync(path.join(out, "server.pem"))).checkIP(host)).toBe(host);
    });
  });

  describe(`guard-guest-registry-run.mjs on ${name}, active with an admin channel`, () => {
    let run: GuestRun;
    let out = "";
    let session = "";
    let gateway = "";
    let port = 0;
    let adminPort = 0;
    let ca = Buffer.alloc(0);
    let token = "";
    let admin = { url: "", authorization: "" };
    let enrolled: Reply = { status: 0, body: "" };
    let device = { deviceId: "", deviceToken: "" };

    const json = (body: unknown) => ({ headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const toGateway = (target: string, options: Parameters<typeof call>[2] = {}) => call(gateway, target, { ca, ...options });
    const toAdmin = (method: string, target: string, headers: Record<string, string> = { authorization: admin.authorization }, body?: string) => call(admin.url, target, { method, headers, body });
    const ruledownload = async () => {
      const reply = await toGateway(`/api/guard/v1/ruledownload/${device.deviceId}`, {
        headers: { authorization: `Bearer ${device.deviceToken}`, "content-type": "application/json" },
        body: JSON.stringify({ protocol: GUARD_PROTOCOL_VERSION }),
      });
      expect(reply.status, reply.body).toBe(200);
      return JSON.parse(reply.body).bundle.bundle;
    };

    beforeAll(async () => {
      ({ out, session } = prepare());
      port = await freePort(host);
      adminPort = await freePort("127.0.0.1");
      run = launch({ out, port, source, adminPort });
      await run.active();
      gateway = `https://${host}:${port}`;
      ca = readFileSync(path.join(out, "ca.pem"));
      token = JSON.parse(readFileSync(path.join(session, "enrollment.json"), "utf8")).token;
      admin = JSON.parse(readFileSync(path.join(session, "admin.json"), "utf8"));
      enrolled = await toGateway("/api/guard/v1/enrol", json({ protocol: GUARD_PROTOCOL_VERSION, enrolToken: token, device: facts, ca: caFacts }));
      if (enrolled.status === 201) device = JSON.parse(enrolled.body);
    });

    it("keeps the enrolment token only in a 0600 enrollment.json inside a 0700 session folder", () => {
      expect(statSync(session).mode & 0o777).toBe(0o700);
      expect(readdirSync(session).sort()).toEqual(["admin.json", "enrollment.json", "registry", "status.json"]);
      expect(statSync(path.join(session, "enrollment.json")).mode & 0o777).toBe(0o600);
      expect(token).toMatch(/^genr_[a-f0-9]{32}$/);
      expect(JSON.parse(readFileSync(path.join(session, "enrollment.json"), "utf8"))).toEqual({
        server: gateway,
        token,
        command: ["vibtra-guard", "enrol", "--server", gateway, "--token", token],
      });
      const status = readFileSync(path.join(session, "status.json"), "utf8");
      expect(JSON.parse(status)).toEqual({ status: "awaiting-guest-enrollment", endpoint: gateway, guestTrustVerified: false, hostPolicyChanged: false });
      expect(status).not.toContain(token);
      expect(statSync(path.join(session, "status.json")).mode & 0o777).toBe(0o600);
      expect(`${run.stdout}${run.stderr}`).not.toContain(token);
    });

    it("writes a 0600 admin.json with a loopback URL on the admin port and a bearer", () => {
      expect(statSync(path.join(session, "admin.json")).mode & 0o777).toBe(0o600);
      expect(admin.url).toBe(`http://127.0.0.1:${adminPort}`);
      expect(admin.authorization).toMatch(/^Bearer [a-f0-9]{48}$/);
      expect(`${run.stdout}${run.stderr}`).not.toContain(admin.authorization);
    });

    it("answers the admin port on loopback and not on the bridge address", async () => {
      expect(await portOpen("127.0.0.1", adminPort)).toBe(true);
      expect(await portOpen(host, adminPort)).toBe(false);
    });

    it("refuses a client that does not trust the prepared CA", async () => {
      await expect(call(gateway, "/api/guard/v1/enrol", { body: "{}" })).rejects.toMatchObject({ code: expect.stringMatching(/CERT|SIGNATURE|ISSUER/) });
    });

    it("forwards a canonical enrol to the fresh registry, which accepts the token from enrollment.json", () => {
      expect(enrolled.status, enrolled.body).toBe(201);
      expect(device.deviceId).toMatch(/^gdev_[a-f0-9]{16}$/);
      expect(device.deviceToken).toMatch(/^gdt_[a-f0-9]{48}$/);
    });

    it("serves the verified source policy on the rule download route", async () => {
      const bundle = await ruledownload();
      expect(bundle.defaultAction).toBe("block");
      expect(bundle.clientMode).toBe("enforce");
    });

    it.each([
      ["POST", "preflight", 400, "VALIDATION"],
      ["POST", "eventupload", 400, "VALIDATION"],
      ["POST", "postflight", 400, "VALIDATION"],
      ["POST", "requests", 400, "VALIDATION"],
      ["GET", "requests", 200, undefined],
    ])("passes %s on the %s route to the registry, which authenticates the device and answers %i", async (method, route, status, code) => {
      const reply = await toGateway(`/api/guard/v1/${route}/${device.deviceId}`, {
        method,
        headers: { authorization: `Bearer ${device.deviceToken}`, ...(method === "GET" ? {} : { "content-type": "application/json" }) },
        body: method === "GET" ? undefined : JSON.stringify({ protocol: GUARD_PROTOCOL_VERSION }),
      });
      expect(reply.body).not.toBe(GATEWAY_REFUSED);
      expect(reply.status, reply.body).toBe(status);
      expect(JSON.parse(reply.body).code).toBe(code);
    });

    it.each([
      ["a console route", "/api/console/guard/devices/enrol-links"],
      ["a traversal", "/api/guard/v1/../console"],
      ["a percent-encoded route", "/api/guard/v1/%65nrol"],
      ["a double slash", "//api/guard/v1/enrol"],
      ["an absolute URL", "https://elsewhere.example/api/guard/v1/enrol"],
      ["a query", "/api/guard/v1/enrol?x=1"],
      ["a trailing slash", "/api/guard/v1/enrol/"],
      ["a sync route with a traversal after the device id", "/api/guard/v1/preflight/gdev_0123456789abcdef/../../enrol"],
    ])("answers 404 itself for %s", async (_what, target) => {
      expect(await toGateway(target, { body: "{}" })).toEqual({ status: 404, body: GATEWAY_REFUSED });
    });

    it.each(["GET", "PUT", "DELETE", "OPTIONS", "PATCH"])("answers 404 itself for %s on the enrol route", async (method) => {
      expect(await toGateway("/api/guard/v1/enrol", { method, body: method === "GET" ? undefined : "{}" })).toEqual({ status: 404, body: GATEWAY_REFUSED });
    });

    it("answers 404 for HEAD on the enrol route", async () => {
      expect(await toGateway("/api/guard/v1/enrol", { method: "HEAD" })).toEqual({ status: 404, body: "" });
    });

    it("answers 413 itself for a declared body over 1 MiB and for an encoded body", async () => {
      expect(await toGateway("/api/guard/v1/enrol", { headers: { "content-type": "application/json", "content-length": ONE_MIB + 1 }, body: "{}" })).toEqual({ status: 413, body: GATEWAY_REFUSED });
      expect(await toGateway("/api/guard/v1/enrol", { headers: { "content-type": "application/json", "content-encoding": "gzip" }, body: "{}" })).toEqual({ status: 413, body: GATEWAY_REFUSED });
    });

    it("answers 413 itself for a streamed body that grows past 1 MiB", async () => {
      expect(await toGateway("/api/guard/v1/enrol", { headers: { "content-type": "application/json", "transfer-encoding": "chunked" }, body: Buffer.alloc(ONE_MIB + 1, 0x20) })).toEqual({ status: 413, body: GATEWAY_REFUSED });
    });

    it("refuses the admin channel without the bearer or with a wrong one", async () => {
      expect(await toAdmin("GET", "/guard/rules", {})).toEqual({ status: 401, body: UNAUTHORIZED });
      expect(await toAdmin("GET", "/guard/rules", { authorization: "Bearer wrong" })).toEqual({ status: 401, body: UNAUTHORIZED });
      expect(await toAdmin("GET", "/guard/rules", { authorization: admin.authorization.replace("Bearer", "Basic") })).toEqual({ status: 401, body: UNAUTHORIZED });
    });

    it.each([
      ["POST", "/guard/devices/gdev_0123456789abcdef/revoke"],
      ["GET", "/guard/../rules"],
      ["GET", "/guard/rules/../../people"],
      ["GET", "/guard/%72ules"],
      ["DELETE", "/guard/rules"],
      ["GET", "/people"],
    ])("answers 404 on the admin channel for %s %s", async (method, target) => {
      expect(await toAdmin(method, target)).toEqual({ status: 404, body: NOT_A_DOOR });
    });

    it("passes an admin PUT /guard/rules to the registry the gateway serves", async () => {
      const page = await toAdmin("GET", "/guard/rules");
      expect(page.status, page.body).toBe(200);
      const baseVersion = JSON.parse(page.body).document.version;
      const put = await toAdmin("PUT", "/guard/rules", { authorization: admin.authorization, "content-type": "application/json" }, JSON.stringify({ baseVersion, document: { defaultAction: "allow", serviceRules: [], contentRules: [] } }));
      expect(put.status, put.body).toBe(200);
      expect((await ruledownload()).defaultAction).toBe("allow");
    });

    it("on SIGTERM exits 0 with both listeners closed, deletes the session folder and keeps the prepared material", async () => {
      run.child.kill("SIGTERM");
      await expectStoppedAndGone(run, out);
      expect(`${run.stdout}${run.stderr}`).not.toContain(token);
    });
  });

  describe(`guard-guest-registry-run.mjs on ${name}, signals`, () => {
    it("on SIGINT while active exits 0 with the listener closed and deletes the session folder", async () => {
      const { out } = prepare();
      const port = await freePort(host);
      const run = launch({ out, port, source });
      await run.active();
      expect(await portOpen(host, port)).toBe(true);
      run.child.kill("SIGINT");
      await expectStoppedAndGone(run, out);
    }, 120_000);

    it("on SIGTERM during startup never reports active, exits 0 and deletes the session folder", async () => {
      const { out, session } = prepare();
      const port = await freePort(host);
      const run = launch({ out, port, source });
      await run.startingIn(session);
      run.child.kill("SIGTERM");
      await expectStoppedAndGone(run, out);
      expect(run.stdout).not.toContain(ACTIVE);
    }, 120_000);
  });

  describe(`guard-guest-registry-run.mjs on ${name}, startup failures`, () => {
    it("refuses a run without --guest-ready that would otherwise start, and leaves no session folder", async () => {
      const { out, session } = prepare();
      await expectRefusedAndGone(launch({ out, port: await freePort(host), source, guestReady: false }), session);
    }, 120_000);

    it("refuses --port 0, which the gateway would accept as any free port, and leaves no session folder", async () => {
      const { out, session } = prepare();
      await expectRefusedAndGone(launch({ out, port: 0, source }), session);
    }, 120_000);

    it("refuses --admin-port 0 with a free gateway port, and leaves no session folder", async () => {
      const { out, session } = prepare();
      await expectRefusedAndGone(launch({ out, port: await freePort(host), source, adminPort: 0 }), session);
    }, 120_000);

    it("a source profile whose signature fails exits 1 and leaves no session folder", async () => {
      const { out, session } = prepare();
      const tampered = path.join(work, `tampered-${cases}`);
      writeSourceProfile(tampered, { tamper: true });
      const port = await freePort(host);
      const run = launch({ out, port, source: tampered });
      await expectRefusedAndGone(run, session);
    }, 120_000);

    it("an occupied gateway port exits 1 and leaves no session folder", async () => {
      const { out, session } = prepare();
      const port = await freePort(host);
      held.push(await occupy(host, port));
      await expectRefusedAndGone(launch({ out, port, source }), session);
    }, 120_000);

    it("an occupied admin port, the last startup step after the token is written, exits 1 and leaves no session folder", async () => {
      const { out, session } = prepare();
      const port = await freePort(host);
      const adminPort = await freePort("127.0.0.1");
      held.push(await occupy("127.0.0.1", adminPort));
      const run = launch({ out, port, source, adminPort });
      await expectRefusedAndGone(run, session);
    }, 120_000);
  });
}
