import { readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { bundleDocument, createSigner, jsonLines, signEnvelope, startFakeRegistry, waitUntil, type FakeRegistry, type Json, type PolicySigner, type RegistryReply } from "./harness.ts";
import { policyProfile, startRunning, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();
const NO_RETRY_DELAY = { VIBTRA_GUARD_TEST_WAIT_RETRY_MAX: "1ms" };

interface Wait {
  readonly at: number;
  readonly stamp: string | null;
  readonly hold: number;
  answer(reply: RegistryReply): void;
}

interface LongPollRegistry {
  readonly registry: FakeRegistry;
  readonly waits: Wait[];
  readonly checkIns: number[];
  preflight(body: Json): void;
}

const quietPreflight = (signer: PolicySigner): Json => ({ clientMode: "enforce", syncIntervalSeconds: 60, batchSize: 100, cleanSync: false, rulesChanged: false, catalogueChanged: false, signingKeyId: signer.keyId });

const unchanged: RegistryReply = { status: 200, body: { answer: "unchanged" } };

type WaitDoor = "holds" | "parks" | "absent" | "unsupported";

const longPollRegistry = async (signer: PolicySigner, door: WaitDoor = "holds"): Promise<LongPollRegistry> => {
  const registry = await startFakeRegistry(suite.cleanup, signer);
  const waits: Wait[] = [];
  const checkIns: number[] = [];
  let preflight = quietPreflight(signer);
  registry.override((call) => {
    if (call.door === "preflight") {
      checkIns.push(performance.now());
      return { status: 200, body: preflight };
    }
    if (call.door !== "sync" || door === "absent") return undefined;
    const query = new URL(call.path, "http://registry.test").searchParams;
    return new Promise<RegistryReply>((resolve) => {
      const hold = Number(query.get("hold"));
      waits.push({ at: performance.now(), stamp: query.get("stamp"), hold, answer: resolve });
      if (door === "unsupported") resolve({ status: 200, body: { answer: "unsupported" } });
      if (door === "holds") setTimeout(() => resolve(unchanged), hold * 1000).unref();
    });
  });
  return {
    registry,
    waits,
    checkIns,
    preflight: (body) => {
      preflight = body;
    },
  };
};

const nth = (waits: readonly Wait[], n: number, timeoutMs = 30_000): Promise<Wait> => waitUntil(`wait ${n}`, async () => waits[n - 1], timeoutMs);

const waitLines = async (dataDir: string): Promise<Json[]> => {
  const text = await readFile(path.join(dataDir, "logs", "vibtra-guard.log"), "utf8").catch(() => "");
  return jsonLines(text).filter((line) => typeof line.msg === "string" && line.msg.startsWith("long-poll"));
};

interface CutProxy {
  readonly url: string;
  cutAll(): void;
}

const startCutProxy = async (target: string, idleCutMs?: number): Promise<CutProxy> => {
  const upstream = new URL(target);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const origin = net.connect(Number(upstream.port), upstream.hostname);
    sockets.add(client).add(origin);
    const end = (): void => {
      client.destroy();
      origin.destroy();
      sockets.delete(client);
      sockets.delete(origin);
    };
    if (idleCutMs !== undefined) {
      client.setTimeout(idleCutMs, end);
      origin.setTimeout(idleCutMs, end);
    }
    client.pipe(origin);
    origin.pipe(client);
    client.on("close", end).on("error", end);
    origin.on("close", end).on("error", end);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the cut proxy did not listen on a TCP port");
  suite.cleanup.defer(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  return {
    url: `http://127.0.0.1:${address.port}`,
    cutAll: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
};

describe("the long-poll wait", () => {
  it("asks for the policy it holds, and a change answered on a parked wait reaches a check-in in about a second", { timeout: 60_000 }, async () => {
    const signer = createSigner();
    const lp = await longPollRegistry(signer, "parks");
    const profile = await policyProfile(suite, { signer, serverUrl: lp.registry.url, bundle: { bundleVersion: 7, protectionRevision: 4 } });
    await startRunning(suite, profile, { args: ["--sync-every", "600"] });
    const first = await nth(lp.waits, 1);
    expect([first.stamp, first.hold]).toEqual(["7.4", 55]);
    await waitUntil("the check-in at start", async () => lp.checkIns[0]);
    await delay(Math.max(0, (lp.checkIns[0] ?? 0) + 10_500 - performance.now()));

    lp.registry.serve({ bundle: signEnvelope(signer, "bundle", bundleDocument(signer, { bundleVersion: 7, protectionRevision: 5, clientMode: "monitor" })), catalogue: null });
    lp.preflight({ ...quietPreflight(signer), clientMode: "monitor", rulesChanged: true });
    const before = lp.checkIns.length;
    const answeredAt = performance.now();
    first.answer({ status: 200, body: { answer: "changed" } });
    const checkIn = await waitUntil("the check-in the change asked for", async () => lp.checkIns[before], 5000);
    const next = await nth(lp.waits, 2, 5000);
    expect(next.stamp, "the next wait carries the new policy's stamp").toBe("7.5");
    expect(checkIn - answeredAt, "from the answer to the check-in").toBeLessThan(1000);
    expect(lp.waits.length, "one wait per stamp, no spinning").toBe(2);
    console.info(`agent long-poll: answer to check-in ${(checkIn - answeredAt).toFixed(0)} ms, to the next wait ${(next.at - answeredAt).toFixed(0)} ms`);
  });

  it("completes a hold at the maximum instead of cancelling it", { timeout: 150_000 }, async () => {
    const signer = createSigner();
    const lp = await longPollRegistry(signer);
    const profile = await policyProfile(suite, { signer, serverUrl: lp.registry.url });
    await startRunning(suite, profile, { args: ["--sync-every", "600"], env: { ...NO_RETRY_DELAY, VIBTRA_LOG_LEVEL: "debug" } });
    const first = await nth(lp.waits, 1);
    const second = await nth(lp.waits, 2, 70_000);
    expect([first.hold, second.hold]).toEqual([55, 55]);
    expect((second.at - first.at) / 1000, "the next wait starts when the 55 s hold is answered").toBeGreaterThanOrEqual(55);
    const lines = await waitLines(profile.dataDir);
    expect(lines.filter((line) => line.msg === "long-poll wait failed; trying again after a random delay"), "no wait ended in an error").toEqual([]);
    const answered = lines.find((line) => line.msg === "long-poll wait answered");
    expect([answered?.answer, Number(answered?.elapsed_ms) >= 55_000]).toEqual(["unchanged", true]);
  });

  it("holds for less behind a proxy that cuts idle connections at 20 s, and a change still arrives", { timeout: 150_000 }, async () => {
    const signer = createSigner();
    const lp = await longPollRegistry(signer);
    const proxy = await startCutProxy(lp.registry.url, 20_000);
    const profile = await policyProfile(suite, { signer, serverUrl: proxy.url });
    await startRunning(suite, profile, { args: ["--sync-every", "600"], env: NO_RETRY_DELAY });
    const shortened = await nth(lp.waits, 3, 60_000);
    expect(lp.waits.map((w) => w.hold), "two cuts at 20 s, then a hold that ends before the cut").toEqual([55, 55, 15]);
    const fourth = await nth(lp.waits, 4, 25_000);
    expect((fourth.at - shortened.at) / 1000, "the 15 s hold is answered, not cut").toBeLessThan(17);

    const before = lp.checkIns.length;
    const answeredAt = performance.now();
    fourth.answer({ status: 200, body: { answer: "changed" } });
    const checkIn = await waitUntil("the check-in behind the proxy", async () => lp.checkIns[before], 15_000);
    expect(checkIn - answeredAt).toBeLessThan(1000);
  });

  it("spreads reconnects over 0-30 s when every wait is cut at once, as when the server restarts", { timeout: 120_000 }, async () => {
    const signer = createSigner();
    const lp = await longPollRegistry(signer, "parks");
    const proxy = await startCutProxy(lp.registry.url);
    const AGENTS = 8;
    for (let i = 0; i < AGENTS; i += 1) {
      const profile = await policyProfile(suite, { signer, serverUrl: proxy.url });
      await startRunning(suite, profile, { args: ["--sync-every", "600"] });
    }
    await nth(lp.waits, AGENTS);
    await delay(500);
    expect(lp.waits.length, "one parked wait per agent").toBe(AGENTS);
    const cutAt = performance.now();
    proxy.cutAll();
    await nth(lp.waits, 2 * AGENTS, 40_000);
    const arrivals = lp.waits.slice(AGENTS).map((w) => (w.at - cutAt) / 1000).sort((a, b) => a - b);
    expect(Math.max(...arrivals), `arrivals ${arrivals.map((s) => s.toFixed(1)).join(" ")} s`).toBeLessThan(31);
    expect(Math.max(...arrivals) - Math.min(...arrivals), "spread, not a herd").toBeGreaterThan(5);
    expect(arrivals.filter((s) => s < 1).length, "no spike in the first second").toBeLessThanOrEqual(3);
    expect(lp.checkIns.filter((at) => at > cutAt).length, "a cut wait does not make the agent check in").toBe(0);
    console.info(`agent long-poll reconnects after a cut: ${arrivals.map((s) => s.toFixed(1)).join(" ")} s`);
  });

  it("falls back to the check-in when the registry has no wait door or says long polling is off", { timeout: 60_000 }, async () => {
    for (const registryKind of ["absent", "unsupported"] as const) {
      const signer = createSigner();
      const lp = await longPollRegistry(signer, registryKind);
      const profile = await policyProfile(suite, { signer, serverUrl: lp.registry.url });
      await startRunning(suite, profile, { args: ["--sync-every", "2"], env: NO_RETRY_DELAY });
      await waitUntil(`${registryKind}: four check-ins`, async () => lp.checkIns[3], 20_000);
      const waitCalls = lp.registry.calls.filter((call) => call.door === "sync");
      expect(waitCalls.length, `${registryKind}: one wait, then the agent stops asking`).toBe(1);
    }
  });
});
