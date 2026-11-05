import type { FastifyInstance } from "fastify";
import { LANDING_DOCUMENT_CACHE_CONTROL, LEGAL_DOCUMENTS, PRICING_REDIRECT, renderLandingPage, type LegalDocumentReaders } from "./landing.js";
import { CACHE_CONTROL_MISS } from "./console-api/app.js";
import { registerHostedRoutes } from "./routes-hosted.js";

export interface RegistryRouteOptions {
  landingDocument?: () => Promise<string | undefined>;
  legalDocuments?: LegalDocumentReaders;
}

export const registerRegistryRoutes = (app: FastifyInstance, options: RegistryRouteOptions = {}): void => {
  app.get("/", async (_req, reply) => {
    const built = options.landingDocument === undefined ? undefined : await options.landingDocument();
    return reply
      .type("text/html; charset=utf-8")
      .header("cache-control", built === undefined ? CACHE_CONTROL_MISS : LANDING_DOCUMENT_CACHE_CONTROL)
      .send(built ?? renderLandingPage());
  });

  for (const name of LEGAL_DOCUMENTS) {
    app.get(`/${name}`, async (_req, reply) => {
      const built = options.legalDocuments === undefined ? undefined : await options.legalDocuments[name]();
      if (built === undefined) {
        return reply
          .code(404)
          .header("cache-control", CACHE_CONTROL_MISS)
          .type("text/plain; charset=utf-8")
          .send(`No ${name} page in this landing build. Run \`pnpm --filter @vibtra/landing build\`, then reload.`);
      }
      return reply
        .type("text/html; charset=utf-8")
        .header("cache-control", LANDING_DOCUMENT_CACHE_CONTROL)
        .send(built);
    });
  }

  app.get("/pricing", async (_req, reply) => reply.header("cache-control", LANDING_DOCUMENT_CACHE_CONTROL).redirect(PRICING_REDIRECT, 302));

  registerHostedRoutes(app);
};
