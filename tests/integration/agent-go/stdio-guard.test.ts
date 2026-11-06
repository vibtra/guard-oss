import { spawn, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useAgentSuite } from "./running.ts";

const suite = useAgentSuite();

const runVersion = async (stdio: StdioOptions): Promise<{ code: unknown; output: string }> => {
  const child = spawn(suite.binary(), ["--version"], { stdio });
  let output = "";
  child.stdout?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => (output += chunk.toString("utf8")));
  const [code]: unknown[] = await once(child, "close");
  return { code, output };
};

const withPeer = async (fd: 0 | 1 | 2, listen: (server: net.Server) => Promise<net.Socket>): Promise<{ code: unknown; received: number }> => {
  let received = 0;
  const accepted = Promise.withResolvers<void>();
  const server = net.createServer((conn) => {
    conn.on("data", (chunk: Buffer) => (received += chunk.length));
    conn.on("close", () => accepted.resolve());
  });
  const client = await listen(server);
  await once(client, "connect");
  const stdio: ("ignore" | net.Socket)[] = ["ignore", "ignore", "ignore"];
  stdio[fd] = client;
  const { code } = await runVersion(stdio);
  client.destroy();
  await accepted.promise;
  await new Promise((resolve) => server.close(resolve));
  return { code, received };
};

const namedUnix = async (server: net.Server): Promise<net.Socket> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-stdio-"));
  suite.cleanup.defer(() => rm(dir, { recursive: true, force: true }));
  server.listen(path.join(dir, "named.sock"));
  await once(server, "listening");
  return net.connect(path.join(dir, "named.sock"));
};

const loopbackTcp = async (server: net.Server): Promise<net.Socket> => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the TCP listener has no port");
  return net.connect(address.port, "127.0.0.1");
};

describe.runIf(process.platform === "darwin")("the darwin agent refuses a stdio socket that could be a signer connection", () => {
  it.each([0, 1, 2] as const)("exits 2 and writes nothing when fd %i is connected to a named Unix socket", async (fd) => {
    expect(await withPeer(fd, namedUnix)).toEqual({ code: 2, received: 0 });
  });

  it("exits 2 and writes nothing when stderr is a TCP socket", async () => {
    expect(await withPeer(2, loopbackTcp)).toEqual({ code: 2, received: 0 });
  });

  it("runs normally with a socketpair (Node's stdio pipe) or no stdio", async () => {
    const piped = await runVersion(["pipe", "pipe", "pipe"]);
    expect([piped.code, piped.output]).toEqual([0, expect.stringContaining("vibtra-guard")]);
    expect((await runVersion(["ignore", "ignore", "ignore"])).code).toBe(0);
  });
});
