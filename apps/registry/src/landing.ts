import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import type { FastifyInstance } from "fastify";
import { tokens } from "@vibtra/ui";
import { CONSOLE_LOGIN_PATH, LANDING_ASSETS_PREFIX } from "@vibtra/console-api";
import { escapeHtml, pageShell } from "./page.js";
import { CACHE_CONTROL_HASHED, CACHE_CONTROL_MISS } from "./console-api/app.js";

export const defaultLandingDistDir = (): string =>
  fileURLToPath(new URL("../../landing/dist", import.meta.url));

export const LANDING_DOCUMENT_FILES = {
  landing: "index.html",
  privacy: "privacy.html",
  terms: "terms.html",
} as const;
export type LandingDocumentName = keyof typeof LANDING_DOCUMENT_FILES;

export const LEGAL_DOCUMENTS = ["privacy", "terms"] as const satisfies ReadonlyArray<LandingDocumentName>;

export const PRICING_REDIRECT = "/#faq-pilot";
export type LegalDocumentName = (typeof LEGAL_DOCUMENTS)[number];

export type BuiltDocumentReader = () => Promise<string | undefined>;

export const readBuiltDocument = (distDir: string, name: LandingDocumentName): BuiltDocumentReader => {
  const file = path.join(distDir, LANDING_DOCUMENT_FILES[name]);
  let lastGood: string | undefined;
  return async () => {
    try {
      const fresh = await readFile(file, "utf8");
      if (fresh !== "") lastGood = fresh;
    } catch {
    }
    return lastGood;
  };
};

export const readBuiltLanding = (distDir: string): BuiltDocumentReader => readBuiltDocument(distDir, "landing");

export type LegalDocumentReaders = Readonly<Record<LegalDocumentName, BuiltDocumentReader>>;

export const readBuiltLegalDocuments = (distDir: string): LegalDocumentReaders => ({
  privacy: readBuiltDocument(distDir, "privacy"),
  terms: readBuiltDocument(distDir, "terms"),
});

export const LANDING_DOCUMENT_CACHE_CONTROL = "public, max-age=300";

export const LANDING_PUBLIC_FILE_CACHE_CONTROL = "public, max-age=86400";

export const hasBuiltLanding = async (distDir: string): Promise<boolean> => {
  try {
    return (await stat(path.join(distDir, "index.html"))).isFile();
  } catch {
    return false;
  }
};

export const registerLandingAssets = async (app: FastifyInstance, distDir: string): Promise<void> => {
  await app.register(
    async (scope) => {
      await scope.register(fastifyStatic, {
        root: distDir,
        prefix: "/",
        wildcard: true,
        index: false,
        cacheControl: false,
        setHeaders: (res, filePath) => {
          const [firstSegment] = path.relative(distDir, filePath).split(path.sep);
          res.setHeader(
            "cache-control",
            firstSegment === "assets" ? CACHE_CONTROL_HASHED : LANDING_PUBLIC_FILE_CACHE_CONTROL,
          );
        },
      });
      scope.setNotFoundHandler(async (_req, reply) =>
        reply
          .code(404)
          .header("cache-control", CACHE_CONTROL_MISS)
          .type("text/plain; charset=utf-8")
          .send("No such file in this landing build. Rebuild the landing, then reload the page."),
      );
      scope.setErrorHandler(async (error, _req, reply) => {
        const status = (error as { statusCode?: number }).statusCode;
        if (typeof status !== "number" || status < 400 || status > 499) throw error;
        return reply
          .code(status)
          .header("cache-control", CACHE_CONTROL_MISS)
          .type("text/plain; charset=utf-8")
          .send(status === 403 ? "That path is not a file in this landing build." : "That is not a path this landing can serve.");
      });
    },
    { prefix: LANDING_ASSETS_PREFIX },
  );
};

const MONO = "ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";

const inventoryCss = `
  .card {
    background: ${tokens.card};
    border-radius: ${tokens.radius.card}px;
    padding: 12px;
    box-shadow: 0 1px 2px rgba(16,16,16,0.05), 0 16px 48px rgba(16,16,16,0.09);
  }
  .lede { padding: 24px 20px 8px; }
  .lede-title { font-size: 24px; font-weight: 700; letter-spacing: -0.02em; color: ${tokens.ink}; }
  .lede-sub { margin-top: 6px; font-size: 13.5px; color: ${tokens.body}; opacity: 0.7; }
  .tool-row { display: flex; gap: 16px; padding: 18px 20px; border-top: 1px solid ${tokens.surface}; align-items: flex-start; flex-wrap: wrap; }
  .tool-main { flex: 1 1 260px; min-width: 0; }
  .tool-name { font-size: 16px; font-weight: 700; color: ${tokens.ink}; letter-spacing: -0.01em; }
  .tool-name .archived-badge {
    margin-left: 8px; font-size: 10.5px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase;
    background: ${tokens.surfaceDeep}; color: ${tokens.ink}; border-radius: 999px; padding: 3px 10px; vertical-align: 2px;
  }
  .tool-ids { margin-top: 3px; font-family: ${MONO}; font-size: 11.5px; color: ${tokens.body}; opacity: 0.6; word-break: break-all; }
  .tool-owner { margin-top: 5px; font-size: 13px; color: ${tokens.body}; opacity: 0.8; }
  .tool-deploy { flex: 0 1 auto; min-width: 180px; }
  .deploy-chip {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase;
    border-radius: 999px; padding: 6px 14px; color: ${tokens.card};
  }
  .deploy-chip.live { background: ${tokens.green}; }
  .deploy-chip.failed { background: ${tokens.black}; }
  .deploy-chip.none { background: ${tokens.pill}; color: ${tokens.ink}; }
  .deploy-url { display: block; margin-top: 8px; font-family: ${MONO}; font-size: 12px; color: ${tokens.ink}; word-break: break-all; text-decoration: none; }
  .deploy-url:hover { text-decoration: underline; }
  .deploy-meta { margin-top: 6px; font-size: 12px; color: ${tokens.body}; opacity: 0.65; }
  .receipt-links { margin-top: 6px; font-family: ${MONO}; font-size: 11.5px; }
  .receipt-links a { color: ${tokens.ink}; text-decoration: none; background: ${tokens.pill}; border-radius: 6px; padding: 2px 8px; margin-right: 6px; display: inline-block; margin-top: 4px; }
  .receipt-links a:hover { background: ${tokens.surfaceDeep}; }
  .empty { padding: 36px 20px 40px; text-align: center; font-size: 14px; color: ${tokens.body}; opacity: 0.65; }
  .foot { margin-top: 22px; text-align: center; font-size: 12.5px; color: ${tokens.body}; opacity: 0.55; }
  .org-strip {
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
    margin-bottom: 14px; padding: 12px 16px;
    background: ${tokens.card}; border-radius: ${tokens.radius.card}px;
    box-shadow: 0 1px 2px rgba(16,16,16,0.05);
    font-size: 13px; color: ${tokens.body};
  }
  .org-strip .org-name { font-weight: 700; color: ${tokens.ink}; font-size: 14px; }
  .org-strip .org-meter { background: ${tokens.pill}; color: ${tokens.ink}; border-radius: 999px; padding: 4px 12px; font-size: 11.5px; font-weight: 600; }
  .org-strip .org-meter + .org-meter { margin-left: -4px; }
  .org-strip .org-spacer { flex: 1 1 auto; }
  .org-strip a { color: ${tokens.ink}; }
  .org-strip a + a { margin-left: 2px; }
  .org-strip form { display: inline; }
  .org-strip button {
    border: 0; cursor: pointer; background: none; padding: 0;
    font-family: ${tokens.font.body}; font-size: 13px; color: ${tokens.ink}; text-decoration: underline;
  }
`;

const landingCss = `
  .hero { padding: 72px 20px 40px; text-align: center; }
  .hero-title { font-size: 40px; font-weight: 700; letter-spacing: -0.03em; color: ${tokens.ink}; line-height: 1.1; }
  .hero-sub { margin: 14px auto 0; max-width: 560px; font-size: 16px; line-height: 1.55; color: ${tokens.body}; opacity: 0.8; }
  .hero-actions { margin-top: 26px; display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; }
  .hero-actions a {
    display: inline-block; text-decoration: none; font-size: 14px; font-weight: 600;
    border-radius: 10px; padding: 11px 20px;
  }
  .hero-actions a.primary { background: ${tokens.ink}; color: ${tokens.card}; }
  .hero-actions a.secondary { background: ${tokens.pill}; color: ${tokens.ink}; }
  .facts { display: flex; gap: 16px; flex-wrap: wrap; justify-content: center; padding: 8px 20px 48px; }
  .fact {
    flex: 1 1 240px; max-width: 320px; text-align: left;
    background: ${tokens.card}; border-radius: ${tokens.radius.card}px; padding: 18px 20px;
    box-shadow: 0 1px 2px rgba(16,16,16,0.05), 0 16px 48px rgba(16,16,16,0.06);
  }
  .fact-title { font-size: 14px; font-weight: 700; color: ${tokens.ink}; letter-spacing: -0.01em; }
  .fact-body { margin-top: 6px; font-size: 13.5px; line-height: 1.5; color: ${tokens.body}; opacity: 0.78; }
  .apex-foot { padding: 0 20px 48px; text-align: center; font-size: 12.5px; color: ${tokens.body}; opacity: 0.55; }
`;

const FACTS: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: "An append-only record of what was deployed",
    body:
      "Every tool created, renamed and deployed is written once and never rewritten. A receipt page shows what " +
      "a deploy actually did, including the checks that ran and the ones that did not.",
  },
  {
    title: "Credentials the tool never holds",
    body:
      "A connection is sealed in the registry and resolved into a deploy's environment at the moment it is " +
      "needed. Who may read it is an audience, and the audience is checked before the credential moves.",
  },
  {
    title: "Sign-in your own identity provider decides",
    body:
      "Deployed tools sit behind one OIDC issuer. Who may open one is decided here, at sign-in — so it changes " +
      "on the next sign-in with no redeploy, and nothing per-tenant is frozen into a deployed app.",
  },
];

const fact = (f: { title: string; body: string }): string => `
  <div class="fact">
    <div class="fact-title">${escapeHtml(f.title)}</div>
    <div class="fact-body">${escapeHtml(f.body)}</div>
  </div>`;

export const renderLandingPage = (): string => {
  const body = `
<div class="wrap">
  <div class="masthead">
    <div class="wordmark">vibtra</div>
    <div class="doclabel">Registry</div>
  </div>
  <div class="hero">
    <div class="hero-title">The registry for tools your team deployed</div>
    <div class="hero-sub">${escapeHtml(
      "Vibtra records what your team deployed, holds the credentials those tools read, and decides who may " +
        "open them — at sign-in, not inside the app.",
    )}</div>
    <div class="hero-actions">
      <!-- THE ONE CALL TO ACTION, AND IT IS A LINK THAT WORKS (host-14).
           Sign-in is on the apex above every handle, because a person arriving
           here has no session and therefore no organisation for a path to
           name.

           AND IT IS DRAWN ONLY WHERE IT EXISTS (adversarial review, 13 Sep
           2026). The sign-in address is registered by console-api/app.ts,
           which server.ts calls in HOSTED mode only — a self-hosted registry
           has no Better Auth, no session and no console SPA, so the same
           button there would be a 404 on the one page whose whole
           specification is that every claim on it is true. What that
           deployment gets instead is its own status, and its inventory below.
           (No backticks in this comment on purpose: it is inside a template
           literal.) -->
      <a class="primary" href="${CONSOLE_LOGIN_PATH}">Sign in</a>
      <a class="secondary" href="/healthz">Service status</a>
    </div>
  </div>
  <div class="facts">${FACTS.map(fact).join("")}</div>
  
  <div class="apex-foot">Vibtra · every record is append-only — history is never rewritten</div>
</div>`;
  return pageShell("Vibtra", `${inventoryCss}${landingCss}`, body);
};
