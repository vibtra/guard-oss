import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import http, { type IncomingHttpHeaders } from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls, { type TLSSocket } from "node:tls";
import { fileURLToPath } from "node:url";
import { GuardEnrolLink } from "@vibtra/guard-contract";
import { startCaSigner, type CaSigner } from "../fakes/ca-signer.ts";
import { createCleanup, startOrCleanUp } from "./cleanup.ts";
import { isRecord } from "./guards.ts";
import type { Person, TestRegistry } from "./registry.ts";

const AGENT_SOURCE_DIR = fileURLToPath(new URL("../../guard/agent-go/", import.meta.url));
const AGENT_BUILD_SCRIPT = path.join(AGENT_SOURCE_DIR, "build.sh");
const LISTENING = /proxy http:\/\/127\.0\.0\.1:(\d+).*local pages http:\/\/127\.0\.0\.1:(\d+)/;
const OPTIONAL_EVENT_FIELDS = ["serviceId", "ruleId", "matchType", "requestId"] as const;

export interface AgentBinary {
  readonly path: string;
  readonly caSigner?: CaSigner;
  close(): Promise<void>;
}

export interface BuildAgentOptions {
  readonly withoutCaSigner?: boolean;
}

export interface LaunchAgentOptions {
  readonly binary: string;
  readonly dataDir: string;
  readonly upstreamMap?: Readonly<Record<string, string>>;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

export interface StartAgentOptions {
  readonly registry: TestRegistry;
  readonly upstreamMap: Readonly<Record<string, string>>;
  readonly person?: Person;
  readonly admin?: Person;
  readonly binary?: string;
}

export interface AgentStatus {
  readonly state: string;
  readonly enrolled: boolean;
  readonly deviceId?: string;
  readonly bundleVersion?: number;
}

export interface AgentActivityEvent {
  readonly eventId: string;
  readonly kind: string;
  readonly action: string;
  readonly serviceId?: string;
  readonly ruleId?: string;
  readonly matchType?: string;
  readonly requestId?: string;
}

export interface AgentActivity {
  readonly events: readonly AgentActivityEvent[];
  readonly text: string;
}

export interface AgentEndpoint {
  readonly proxyPort: number;
  readonly caPem: string;
}

export interface RunningAgent extends AgentEndpoint {
  readonly dataDir: string;
  readonly localUrl: string;
  status(): Promise<AgentStatus>;
  activity(): Promise<AgentActivity>;
  sync(): Promise<void>;
  requestException(eventId: string, note: string): Promise<string>;
  waitForException(eventId: string): Promise<void>;
  log(): string;
  close(): Promise<void>;
}

export interface TestAgent extends RunningAgent {
  readonly deviceId: string;
}

export interface AgentRequest {
  readonly host: string;
  readonly port?: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly onData?: (received: Buffer) => void;
}

export interface AgentResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

const isActivityEvent = (value: unknown): value is AgentActivityEvent =>
  isRecord(value) &&
  typeof value.eventId === "string" &&
  typeof value.kind === "string" &&
  typeof value.action === "string" &&
  OPTIONAL_EVENT_FIELDS.every((field) => value[field] === undefined || typeof value[field] === "string");

const run = async (command: string, args: readonly string[], options: { cwd?: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<string> => {
  const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const keep = (chunk: Buffer): void => {
    output = (output + chunk.toString("utf8")).slice(-8192);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);
  const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs);
  try {
    const [code, signal]: unknown[] = await once(child, "close");
    if (code !== 0) throw new Error(`${path.basename(command)} ${args[0] ?? ""} exited with ${String(code ?? signal)}: ${output}`);
    return output;
  } finally {
    clearTimeout(timer);
  }
};

const stop = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
  try {
    await exited;
  } finally {
    clearTimeout(timer);
  }
};

const waitFor = async <T>(what: string, probe: () => Promise<T | undefined>, timeoutMs: number, detail: () => string): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}\n${detail()}`);
    await delay(200);
  }
};

const coverageDir = async (): Promise<string | undefined> => {
  const configured = process.env.GUARD_AGENT_COVERDIR;
  if (configured === undefined || configured === "") return undefined;
  const dir = path.resolve(configured);
  await mkdir(dir, { recursive: true });
  return dir;
};

export const agentRaceEnabled = (): boolean => process.env.GUARD_AGENT_RACE === "1";

export const agentRaceEnv = (): Readonly<Record<string, string>> =>
  agentRaceEnabled() ? { GORACE: process.env.GORACE ?? "halt_on_error=1 exitcode=66" } : {};

const caSigners = new Map<string, CaSigner>();

export const caSignerEnv = (binary: string): Readonly<Record<string, string>> => caSigners.get(binary)?.env ?? {};

const agentEnv = async (binary: string, dataDir: string, extra: Readonly<Record<string, string>> = {}): Promise<NodeJS.ProcessEnv> => {
  const coverDir = await coverageDir();
  return { ...process.env, ...agentRaceEnv(), ...caSignerEnv(binary), VIBTRA_GUARD_DIR: dataDir, ...(coverDir === undefined ? {} : { GOCOVERDIR: coverDir }), ...extra };
};

const raceGoFlags = (cover: boolean, tags: readonly string[]): string => [process.env.GOFLAGS, "-race", ...tags, ...(cover ? ["-cover"] : [])].filter((flag) => flag !== undefined && flag !== "").join(" ");

export const buildAgent = async (options: BuildAgentOptions = {}): Promise<AgentBinary> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "guard-agent-build-"));
  const tags = options.withoutCaSigner === true ? [] : ["-tags=guard_test"];
  const race = agentRaceEnabled();
  const binary = race ? path.join(root, "race", "vibtra-guard") : path.join(root, "vibtra-guard");
  let caSigner: CaSigner | undefined;
  const close = async (): Promise<void> => {
    caSigners.delete(binary);
    await caSigner?.close();
    await rm(root, { recursive: true, force: true });
  };
  try {
    const coverDir = await coverageDir();
    if (race) await run("zsh", [AGENT_BUILD_SCRIPT, binary], { env: { ...process.env, GOFLAGS: raceGoFlags(coverDir !== undefined, tags) }, timeoutMs: 600_000 });
    else await run("go", ["build", ...tags, ...(coverDir === undefined ? [] : ["-cover"]), "-o", binary, "."], { cwd: AGENT_SOURCE_DIR, env: process.env, timeoutMs: 600_000 });
    if (options.withoutCaSigner !== true) {
      caSigner = await startCaSigner();
      caSigners.set(binary, caSigner);
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { path: binary, ...(caSigner === undefined ? {} : { caSigner }), close };
};

export const launchAgent = async (options: LaunchAgentOptions): Promise<RunningAgent> => {
  const env = await agentEnv(options.binary, options.dataDir, options.env);
  const mapped = Object.entries(options.upstreamMap ?? {}).map(([host, url]) => `${host}=${url}`);
  const daemon = spawn(
    options.binary,
    [
      "run",
      "--proxy",
      "127.0.0.1:0",
      "--local",
      "127.0.0.1:0",
      ...(mapped.length === 0 ? [] : ["--upstream-map", mapped.join(",")]),
      "--sync-every",
      "1",
      ...(options.args ?? []),
    ],
    { env, stdio: ["ignore", "ignore", "pipe"] },
  );
  const close = (): Promise<void> => stop(daemon);
  let output = "";
  const log = (): string => output;
  const listening = Promise.withResolvers<{ proxyPort: number; localPort: number }>();
  const startupTimer = setTimeout(() => listening.reject(new Error(`the agent did not report its listeners\nagent log:\n${output}`)), 30_000);
  daemon.stderr.setEncoding("utf8");
  daemon.stderr.on("data", (chunk: string) => {
    output = (output + chunk).slice(-8192);
    const match = LISTENING.exec(output);
    if (match !== null) listening.resolve({ proxyPort: Number(match[1]), localPort: Number(match[2]) });
  });
  daemon.once("exit", (code, signal) => listening.reject(new Error(`the agent exited with ${code ?? signal} before it listened\nagent log:\n${output}`)));
  daemon.on("error", listening.reject);
  let ports: { proxyPort: number; localPort: number };
  try {
    ports = await listening.promise;
  } catch (error) {
    await close();
    throw error;
  } finally {
    clearTimeout(startupTimer);
  }
  const localUrl = `http://127.0.0.1:${ports.localPort}`;
  const detail = (): string => `agent log:\n${output}`;

  const local = async (localPath: string, init?: RequestInit): Promise<{ status: number; text: string; body: unknown }> => {
    const response = await fetch(`${localUrl}${localPath}`, init);
    const text = await response.text();
    try {
      return { status: response.status, text, body: JSON.parse(text) };
    } catch {
      return { status: response.status, text, body: undefined };
    }
  };

  let caPem = "";
  try {
    caPem = await readFile(path.join(options.dataDir, "ca.pem"), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      await close();
      throw error;
    }
  }

  return {
    dataDir: options.dataDir,
    proxyPort: ports.proxyPort,
    localUrl,
    caPem,
    status: async () => {
      const { text, body } = await local("/status");
      if (!isRecord(body) || typeof body.state !== "string" || typeof body.enrolled !== "boolean") {
        throw new Error(`the agent status was not understood: ${text.slice(0, 300)}`);
      }
      return {
        state: body.state,
        enrolled: body.enrolled,
        ...(typeof body.deviceId === "string" ? { deviceId: body.deviceId } : {}),
        ...(typeof body.bundleVersion === "number" ? { bundleVersion: body.bundleVersion } : {}),
      };
    },
    activity: async () => {
      const { text, body } = await local("/activity");
      const events = isRecord(body) ? body.events : undefined;
      if (!Array.isArray(events) || !events.every(isActivityEvent)) throw new Error(`the agent activity was not understood: ${text.slice(0, 300)}`);
      return { events, text };
    },
    sync: async () => {
      await run(options.binary, ["sync"], { env, timeoutMs: 60_000 });
    },
    requestException: async (eventId, note) => {
      const reply = await local(`/blocked/${eventId}/request`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note }),
      });
      const request = isRecord(reply.body) ? reply.body.request : undefined;
      const requestId = isRecord(request) ? request.requestId : undefined;
      if (reply.status !== 200 || typeof requestId !== "string") {
        throw new Error(`asking for an exception answered ${reply.status}: ${reply.text.slice(0, 300)}`);
      }
      return requestId;
    },
    waitForException: async (eventId) => {
      await waitFor(
        `the exception for ${eventId} to reach the agent`,
        async () => {
          const { body } = await local(`/blocked/${eventId}/status`);
          return isRecord(body) && body.applied === true ? true : undefined;
        },
        30_000,
        detail,
      );
    },
    log,
    close,
  };
};

export const startAgent = async (options: StartAgentOptions): Promise<TestAgent> => {
  const person = options.person ?? options.registry.people.member;
  const admin = options.admin ?? options.registry.people.admin;
  const cleanup = createCleanup();
  return startOrCleanUp(cleanup, async () => {
    let binary = options.binary;
    if (binary === undefined) {
      const built = await buildAgent();
      cleanup.defer(built.close);
      binary = built.path;
    }
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-agent-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const dataDir = path.join(root, "profile");

    const link = await options.registry.consoleWrite(admin, "POST", "/guard/devices/enrol-links", {
      personEmail: person.email,
      note: "Disposable test agent",
    });
    if (link.status !== 201) throw new Error(`minting an enrol link answered ${link.status}: ${link.text.slice(0, 300)}`);
    await run(binary, ["enrol", "--server", options.registry.url, "--token", GuardEnrolLink.parse(link.body).token], {
      env: await agentEnv(binary, dataDir),
      timeoutMs: 60_000,
    });

    const agent = await launchAgent({ binary, dataDir, upstreamMap: options.upstreamMap });
    cleanup.defer(agent.close);
    const deviceId = await waitFor(
      "the agent to load its signed policy",
      async () => {
        const current = await agent.status();
        return current.bundleVersion === undefined ? undefined : current.deviceId;
      },
      30_000,
      () => `agent log:\n${agent.log()}`,
    );
    return { ...agent, deviceId, close: cleanup.run };
  });
};

const openTunnel = (proxyPort: number, authority: string): Promise<Socket> => {
  const tunnel = Promise.withResolvers<Socket>();
  const connect = http.request({ host: "127.0.0.1", port: proxyPort, method: "CONNECT", path: authority, headers: { host: authority }, agent: false });
  connect.setTimeout(30_000, () => connect.destroy(new Error(`CONNECT ${authority} through the agent timed out`)));
  connect.once("connect", (response, socket) => {
    if (response.statusCode === 200) {
      tunnel.resolve(socket);
      return;
    }
    socket.destroy();
    tunnel.reject(new Error(`CONNECT ${authority} answered ${response.statusCode ?? "nothing"}`));
  });
  connect.on("error", tunnel.reject);
  connect.end();
  return tunnel.promise;
};

export const connectThroughAgent = async (agent: AgentEndpoint, host: string, port = 443): Promise<TLSSocket> => {
  const socket = tls.connect({
    socket: await openTunnel(agent.proxyPort, `${host}:${port}`),
    servername: host,
    ca: agent.caPem,
    ALPNProtocols: ["http/1.1"],
  });
  try {
    await once(socket, "secureConnect");
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return socket;
};

export const requestThroughAgent = async (agent: AgentEndpoint, request: AgentRequest): Promise<AgentResponse> => {
  const port = request.port ?? 443;
  const socket = await connectThroughAgent(agent, request.host, port);
  try {
    const exchange = Promise.withResolvers<AgentResponse>();
    const outgoing = http.request({
      method: request.method,
      path: request.path,
      headers: {
        ...request.headers,
        host: port === 443 ? request.host : `${request.host}:${port}`,
        ...(request.body === undefined ? {} : { "content-length": String(request.body.length) }),
      },
      createConnection: () => socket,
    });
    outgoing.setTimeout(30_000, () => outgoing.destroy(new Error(`${request.method} https://${request.host}${request.path} through the agent timed out`)));
    outgoing.on("error", exchange.reject);
    outgoing.once("response", (incoming) => {
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        request.onData?.(Buffer.concat(chunks));
      });
      incoming.on("error", exchange.reject);
      incoming.once("end", () => exchange.resolve({ status: incoming.statusCode ?? 0, headers: incoming.headers, body: Buffer.concat(chunks) }));
    });
    outgoing.end(request.body);
    return await exchange.promise;
  } finally {
    socket.destroy();
  }
};
