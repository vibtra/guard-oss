import { spawn, type ChildProcess } from "node:child_process";
import { generateGuardSigningKey, signGuardBundle, signGuardCatalogue } from "@vibtra/guard-contract/signing";
import { GUARD_PROTOCOL_VERSION, GUARD_SNIPPET_MAX, seedCatalogue } from "@vibtra/guard-contract";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

export const ACTIVE = "Guest test registry active.";
export const REFUSAL = /No fallback was attempted/;

export type Bridge = { kind: "present"; name: string; host: string } | { kind: "missing"; reason: string };

export const natBridge = (): Bridge => {
  const name = process.env.GUARD_TEST_NAT_BRIDGE ?? "";
  if (name === "") return { kind: "missing", reason: "GUARD_TEST_NAT_BRIDGE is not set" };
  const host = os.networkInterfaces()[name]?.find((row) => net.isIPv4(row.address) && !row.internal)?.address;
  return host === undefined ? { kind: "missing", reason: `GUARD_TEST_NAT_BRIDGE=${name} has no IPv4 address on this machine` } : { kind: "present", name, host };
};

export const freePort = (host: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address !== null ? address.port : 0));
    });
  });

export const portOpen = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = net.connect(port, host);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

export const occupy = (host: string, port: number): Promise<net.Server> =>
  new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });

export const writeSourceProfile = (dir: string, { tamper = false } = {}): void => {
  const key = generateGuardSigningKey();
  const orgId = "org_fixture_source";
  const deviceId = "gdev_00000000000000f1";
  const catalogue = signGuardCatalogue(seedCatalogue(), orgId, key);
  const bundle = signGuardBundle(
    {
      protocol: GUARD_PROTOCOL_VERSION,
      orgId,
      deviceId,
      bundleVersion: 1,
      catalogueVersion: catalogue.catalogue.version,
      generatedAt: "2026-10-26T00:00:00.000Z",
      person: { userId: "user_fixture_source", email: "source@fixture.example" },
      clientMode: "monitor",
      defaultAction: "block",
      services: {},
      contentRules: [],
      exceptions: [],
      settings: { requestsEnabled: false, workspaceRedirect: { enabled: false }, snippetPolicy: "none", snippetMax: GUARD_SNIPPET_MAX },
    },
    key,
  );
  if (tamper) bundle.bundle.defaultAction = "allow";
  mkdirSync(dir, { mode: 0o700 });
  const put = (name: string, value: unknown) => writeFileSync(path.join(dir, name), JSON.stringify(value), { mode: 0o600 });
  put("device.json", { deviceId, orgId, signing: { keyId: key.keyId, publicKeyPem: key.publicKeyPem } });
  put("bundle.json", bundle);
  put("catalogue.json", catalogue);
};

export type RunOptions = { out: string; host: string; bridge: string; port: number; source: string; adminPort?: number; guestReady?: boolean };

export class GuestRun {
  readonly child: ChildProcess;
  stdout = "";
  stderr = "";
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(options: RunOptions) {
    const args = [...(options.guestReady === false ? [] : ["--guest-ready"]), "--out", options.out, "--host", options.host, "--interface", options.bridge, "--port", String(options.port), "--source-profile", options.source];
    if (options.adminPort !== undefined) args.push("--admin-port", String(options.adminPort));
    this.child = spawn(process.execPath, ["--import", "tsx", path.join(repoRoot, "scripts", "guard-guest-registry-run.mjs"), ...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });
    this.child.stdout!.on("data", (data: Buffer) => (this.stdout += data.toString("utf8")));
    this.child.stderr!.on("data", (data: Buffer) => (this.stderr += data.toString("utf8")));
    this.exited = new Promise((resolve) => this.child.once("exit", (code, signal) => resolve({ code, signal })));
  }

  async until(ready: () => boolean, what: string, timeoutMs = 90_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let gone = false;
    void this.exited.then(() => (gone = true));
    while (!ready()) {
      if (gone) throw new Error(`run exited before ${what}: ${this.stderr}`);
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}: ${this.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  exit(timeoutMs = 30_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`run still running ${timeoutMs} ms after it should have exited`)), timeoutMs);
    });
    return Promise.race([this.exited, late]).finally(() => clearTimeout(timer));
  }

  active(): Promise<void> {
    return this.until(() => this.stdout.includes(ACTIVE), "the active log line");
  }

  startingIn(session: string): Promise<void> {
    return this.until(() => existsSync(session) && !existsSync(path.join(session, "status.json")), "the session folder");
  }

  stop(): void {
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
  }
}

export type Reply = { status: number; body: string };

export const call = (
  url: string,
  target: string,
  { method = "POST", headers = {}, body, ca }: { method?: string; headers?: Record<string, string | number>; body?: string | Buffer; ca?: Buffer } = {},
): Promise<Reply> =>
  new Promise((resolve, reject) => {
    const base = new URL(url);
    const options = { host: base.hostname, port: Number(base.port), path: target, method, headers, ...(ca === undefined ? {} : { ca }) };
    const req = (base.protocol === "https:" ? https : http).request(options, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: text }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  });

export const facts = { hostname: "fixture-guest-mac", osVersion: "26.0", agentVersion: "0.1.0", arch: "arm64", primaryUser: "fixture" } as const;
export const caFacts = { fingerprintSha256: "cd".repeat(32), subject: "CN=Fixture guest CA", notAfter: "2036-10-16T00:00:00.000Z" } as const;
