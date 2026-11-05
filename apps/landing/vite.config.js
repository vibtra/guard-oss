import { defineConfig } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const stripComments = {
  name: "strip-html-comments",
  transformIndexHtml: { order: "post", handler: (html) => html.replace(/<!--(?!\s*\/?chrome:)[\s\S]*?-->/g, "") },
};

export default defineConfig({
  base: "/landing/",
  plugins: [stripComments],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(HERE, "index.html"),
        privacy: resolve(HERE, "privacy.html"),
        terms: resolve(HERE, "terms.html"),
      },
    },
  },
});
