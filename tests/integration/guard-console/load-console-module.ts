import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const consoleDir = fileURLToPath(new URL("../../../apps/guard-console/", import.meta.url));

export interface ConsoleModule<T> {
  module: T;
  close: () => Promise<void>;
}

export async function loadConsoleModule<T>(path: `/src/${string}`): Promise<ConsoleModule<T>> {
  const server = await createServer({
    configFile: `${consoleDir}vite.config.ts`,
    root: consoleDir,
    logLevel: "error",
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    return { module: (await server.ssrLoadModule(path)) as T, close: () => server.close() };
  } catch (error) {
    await server.close();
    throw error;
  }
}
