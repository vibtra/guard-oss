import { fileURLToPath, URL } from "node:url";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const REGISTRY_PATHS = ["/api", "/login", "/signin", "/auth", "/r", "/tools"];

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VIBTRA_");
  const target = env.VIBTRA_REGISTRY_URL ?? "http://127.0.0.1:4700";
  return {
    base: "/assets/guard/",
    build: { assetsDir: "" },
    plugins: [react(), tailwindcss()],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: {
      port: 5181,
      strictPort: true,
      proxy: Object.fromEntries(REGISTRY_PATHS.map((path) => [path, { target, changeOrigin: false }])),
    },
  };
});
