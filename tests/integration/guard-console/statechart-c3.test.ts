import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GuardDeviceRow } from "@vibtra/guard-contract";

type Row = Pick<GuardDeviceRow, "status" | "quiet" | "clientMode" | "health">;
type DeviceState = { key: string; label: string };

const consoleDir = fileURLToPath(new URL("../../../apps/guard-console/", import.meta.url));
let server: ViteDevServer;
let deviceState: (row: Row) => DeviceState;

beforeAll(async () => {
  server = await createServer({
    configFile: `${consoleDir}vite.config.ts`,
    root: consoleDir,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  ({ deviceState } = (await server.ssrLoadModule("/src/people/fleet.tsx")) as { deviceState: typeof deviceState });
});

afterAll(async () => {
  await server?.close();
});

const synced: Row = { status: "active", quiet: false, clientMode: "enforce", health: { interception: { on: true } } };
const off: Row["health"] = { interception: { on: false, reason: "no-secure-enclave" } };

describe("the console pill (deviceState)", () => {
  it("a synced enforcing Mac is Protected, a monitoring Mac is Monitoring, a Mac with interception off is Not protected, a revoked Mac is Revoked", () => {
    expect(deviceState(synced).key).toBe("protected");
    expect(deviceState({ ...synced, clientMode: "monitor" }).key).toBe("monitoring");
    expect(deviceState({ ...synced, health: off }).key).toBe("unprotected");
    expect(deviceState({ ...synced, status: "revoked", quiet: true, health: off }).key).toBe("revoked");
  });

  it("a quiet Mac whose last sync said interception is off still shows Not protected", () => {
    expect(deviceState({ ...synced, quiet: true, health: off })).toMatchObject({ key: "unprotected", label: "Not protected" });
  });

  it("a quiet Mac whose last sync said interception is on shows Quiet", () => {
    expect(deviceState({ ...synced, quiet: true })).toMatchObject({ key: "quiet", label: "Quiet" });
  });
});
