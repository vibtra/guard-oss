import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance, FastifyReply } from "fastify";
import { orgHandleProblem } from "@vibtra/console-api";
import { GUARD_ASSETS_PREFIX, GUARD_CONSOLE_PATH } from "@vibtra/guard-contract";
import { CACHE_CONTROL_CONSOLE_UNHASHED, CACHE_CONTROL_HASHED, CACHE_CONTROL_MISS, hasViteContentHash } from "../console-api/app.js";

export const defaultGuardConsoleDistDir = (): string => fileURLToPath(new URL("../../../guard-console/dist", import.meta.url));

const UNBUILT =
  "The Guard console has not been built into this registry. Run `pnpm --filter @vibtra/guard-console build`, or point " +
  "VIBTRA_GUARD_CONSOLE_DIST at a built directory, and restart.";

const ASSET_EXTENSIONS = new Set(["js", "mjs", "cjs", "css", "map", "json", "wasm", "svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "woff", "woff2", "ttf", "otf", "eot", "txt", "xml", "webmanifest"]);
const looksLikeAsset = (url: string): boolean => {
  const pathname = url.split("?")[0]?.split("#")[0] ?? "";
  const segment = pathname.slice(pathname.lastIndexOf("/") + 1);
  const dot = segment.lastIndexOf(".");
  return dot > 0 && ASSET_EXTENSIONS.has(segment.slice(dot + 1).toLowerCase());
};

type HandleReq = { params: { handle?: string }; url: string };

export const registerGuardConsoleApp = async (app: FastifyInstance, options: { distDir: string }): Promise<boolean> => {
  const indexFile = path.join(options.distDir, "index.html");
  let index: string | undefined;
  try {
    if ((await stat(indexFile)).isFile()) index = await readFile(indexFile, "utf8");
  } catch {
  }
  const page = `/:handle${GUARD_CONSOLE_PATH}`;

  if (index === undefined) {
    const say = (reply: FastifyReply) => reply.code(503).type("text/plain; charset=utf-8").send(UNBUILT);
    const sayOr404 = async (req: HandleReq, reply: FastifyReply) => (orgHandleProblem(req.params.handle ?? "") === undefined ? say(reply) : reply.callNotFound());
    app.get<{ Params: { handle: string } }>(page, sayOr404);
    app.get<{ Params: { handle: string } }>(`${page}/*`, sayOr404);
    app.get(`${GUARD_ASSETS_PREFIX}/*`, async (_req, reply) => say(reply));
    return false;
  }

  let html = index;
  const currentIndex = async (): Promise<string> => {
    try {
      const fresh = await readFile(indexFile, "utf8");
      if (fresh !== "") html = fresh;
    } catch {
    }
    return html;
  };
  const spaOr404 = async (req: HandleReq, reply: FastifyReply) => {
    if (orgHandleProblem(req.params.handle ?? "") !== undefined) return reply.callNotFound();
    return reply.type("text/html; charset=utf-8").send(await currentIndex());
  };
  app.get<{ Params: { handle: string } }>(page, spaOr404);
  app.get<{ Params: { handle: string } }>(`${page}/*`, async (req, reply) => {
    if (looksLikeAsset(req.url)) {
      return reply.code(404).type("text/plain; charset=utf-8").send("No such file in this Guard console build. Assets are served from /assets/guard — rebuild and reload.");
    }
    return spaOr404(req, reply);
  });

  await app.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: options.distDir,
        prefix: "/",
        wildcard: true,
        index: false,
        cacheControl: false,
        setHeaders: (res, filePath) => {
          res.setHeader("cache-control", hasViteContentHash(path.basename(filePath)) ? CACHE_CONTROL_HASHED : CACHE_CONTROL_CONSOLE_UNHASHED);
        },
      });
      scope.setNotFoundHandler(async (_req, reply) =>
        reply.code(404).header("cache-control", CACHE_CONTROL_MISS).type("text/plain; charset=utf-8").send("No such file in this Guard console build. Rebuild it, then reload the page."),
      );
      scope.setErrorHandler(async (error, _req, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        if (typeof status !== "number" || status < 400 || status > 499) throw error;
        return reply
          .code(status)
          .header("cache-control", CACHE_CONTROL_MISS)
          .type("text/plain; charset=utf-8")
          .send(status === 403 ? "That path is not inside this Guard console build." : "That is not a path this Guard console can serve.");
      });
    },
    { prefix: GUARD_ASSETS_PREFIX },
  );
  return true;
};
