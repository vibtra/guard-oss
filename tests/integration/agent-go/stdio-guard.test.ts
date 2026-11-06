import { spawn, type StdioOptions } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { buildAgent } from "../../support/agent.ts";
import { createCleanup } from "../../support/cleanup.ts";

const runVersion = async (binary: string, stdio: StdioOptions): Promise<{ code: unknown; received: number }> => {
  const child = spawn(binary, ["--version"], { stdio });
  let received = 0;
  child.stdout?.on("data", (chunk: Buffer) => (received += chunk.length));
  child.stderr?.on("data", (chunk: Buffer) => (received += chunk.length));
  const [code]: unknown[] = await once(child, "close");
  return { code, received };
};

describe.runIf(process.platform === "darwin")("a shipped darwin agent refuses a socket as its stdio", () => {
  it("exits 2 and writes nothing when stderr or stdin is a socketpair (Node's stdio pipe), and runs with plain stdio", { timeout: 600_000 }, async () => {
    const cleanup = createCleanup();
    try {
      const plain = await buildAgent({ withoutCaSigner: true });
      cleanup.defer(plain.close);
      expect(await runVersion(plain.path, ["ignore", "ignore", "pipe"]), "stderr is a socket").toEqual({ code: 2, received: 0 });
      expect(await runVersion(plain.path, ["pipe", "ignore", "ignore"]), "stdin is a socket").toEqual({ code: 2, received: 0 });
      expect((await runVersion(plain.path, ["ignore", "ignore", "ignore"])).code, "plain stdio").toBe(0);
    } finally {
      await cleanup.run();
    }
  });
});
