import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readSession } from "../auth/session.js";
import { guardSignInPath } from "../guard/entry-pages.js";
import type { Coordinator } from "../store/coordination.js";
import { timed } from "../telemetry.js";
import { ONBOARDING_LINK_PATHS, type OnboardingLinks, type OnboardingLinkSubject } from "./links.js";

const STYLE =
  ":root{color-scheme:light dark}body{margin:0;font:400 15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;background:Canvas;color:CanvasText}" +
  "main{max-width:34rem;margin:12vh auto;padding:0 16px}h1{font-size:1.5rem;font-weight:600;margin:0 0 .5rem}p{margin:.5rem 0}" +
  "a.button,button{display:inline-block;margin-top:1rem;padding:.6rem 1rem;border-radius:8px;border:1px solid currentColor;background:none;color:inherit;font:inherit;text-decoration:none;cursor:pointer}" +
  "code{display:block;margin-top:.5rem;padding:.6rem;border-radius:6px;background:color-mix(in srgb,CanvasText 8%,Canvas);overflow-wrap:anywhere}";

const CSP = [
  "default-src 'none'",
  `style-src 'sha256-${createHash("sha256").update(STYLE, "utf8").digest("base64")}'`,
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

type Paragraph = { kind: "text"; text: string } | { kind: "link"; href: string; label: string } | { kind: "code"; text: string } | { kind: "post"; label: string };

const paragraphHtml = (part: Paragraph): string => {
  switch (part.kind) {
    case "text":
      return `<p>${escapeHtml(part.text)}</p>`;
    case "link":
      return `<p><a class="button" href="${escapeHtml(part.href)}">${escapeHtml(part.label)}</a></p>`;
    case "code":
      return `<code>${escapeHtml(part.text)}</code>`;
    case "post":
      return `<form method="post"><button type="submit">${escapeHtml(part.label)}</button></form>`;
    default: {
      const unreachable: never = part;
      return unreachable;
    }
  }
};

const sendPage = (reply: FastifyReply, status: number, title: string, parts: readonly Paragraph[]): FastifyReply =>
  reply
    .code(status)
    .type("text/html; charset=utf-8")
    .header("content-security-policy", CSP)
    .header("cache-control", "no-store")
    .header("referrer-policy", "no-referrer")
    .header("x-content-type-options", "nosniff")
    .header("x-robots-tag", "noindex")
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<meta name="robots" content="noindex"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>` +
        `<body><main><h1>${escapeHtml(title)}</h1>${parts.map(paragraphHtml).join("")}</main></body></html>`,
    );

const UNKNOWN_LINK: readonly Paragraph[] = [
  {
    kind: "text",
    text: "This link is not one Guard made, it was changed on the way, or a newer email replaced it. Open the link in your latest email from IT, or ask IT to send it again.",
  },
];

const EXPIRED_LINK: readonly Paragraph[] = [{ kind: "text", text: "This link has expired. Ask IT to send it again; the new email has fresh links." }];

const LINK_REQUESTS_PER_MINUTE = 30;

const MINUTE_MS = 60_000;

interface OnboardingLinkHolder {
  orgId: string;
  email: string;
  linkGeneration: string | undefined;
  pendingInvitationId: string | undefined;
}

interface OnboardingEnrolMinter {
  mint(input: { orgId: string; personEmail: string; actorEmail: string }): Promise<{ url: string; command: string }>;
}

export interface OnboardingEntryRoutesOptions {
  links: OnboardingLinks;
  baseUrl: string;
  downloadUrl: string | undefined;
  holderOf(subject: OnboardingLinkSubject): Promise<OnboardingLinkHolder | undefined>;
  enrol: OnboardingEnrolMinter | undefined;
  limiter: Coordinator;
  now: () => Date;
}

type TokenRequest = FastifyRequest<{ Params: { token: string } }>;

const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export const registerOnboardingEntryRoutes = (app: FastifyInstance, options: OnboardingEntryRoutesOptions): void => {
  const baseOrigin = new URL(options.baseUrl).origin;

  const holding = async (purpose: "download" | "enrol", req: TokenRequest, reply: FastifyReply): Promise<OnboardingLinkHolder | undefined> => {
    const take = await timed(req.log, "rate_limit", () => options.limiter.take(`onboarding-link:${req.ip}`, LINK_REQUESTS_PER_MINUTE, MINUTE_MS));
    if (!take.ok) {
      if (take.firstRefusal) req.log.warn({ route: req.routeOptions.url, count: take.count }, "onboarding link rate limited");
      void sendPage(reply.header("retry-after", String(take.retryAfterSeconds)), 429, "Too many tries", [
        { kind: "text", text: `Wait ${String(take.retryAfterSeconds)} seconds, then open the link again.` },
      ]);
      return undefined;
    }
    const read = options.links.read(purpose, req.params.token);
    const holder = read.kind === "signed" ? await timed(req.log, "link_holder", () => options.holderOf(read.subject)) : undefined;
    if (read.kind !== "signed" || holder === undefined || !read.signedFor(holder.linkGeneration)) {
      void sendPage(reply, 404, "This link does not work", UNKNOWN_LINK);
      return undefined;
    }
    if (read.expiresAt.getTime() <= options.now().getTime()) {
      void sendPage(reply, 410, "This link has expired", EXPIRED_LINK);
      return undefined;
    }
    return holder;
  };

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.download}/:token`, async (req, reply) => {
    if ((await holding("download", req, reply)) === undefined) return reply;
    if (options.downloadUrl !== undefined) return reply.code(303).header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(options.downloadUrl);
    return sendPage(reply, 200, "Your IT team sends Guard", [
      { kind: "text", text: "This organisation installs Guard for you, or sends you its own signed copy. Ask IT for it, then come back to the enrol link in your email." },
    ]);
  });

  const enrolling = async (req: TokenRequest, reply: FastifyReply, posted: boolean): Promise<{ minter: OnboardingEnrolMinter; holder: OnboardingLinkHolder; actorEmail: string } | undefined> => {
    if (posted && req.headers.origin !== undefined && req.headers.origin !== baseOrigin) {
      void sendPage(reply, 403, "This form did not come from Guard", [{ kind: "text", text: "Open the enrol link from your email again and press the button there." }]);
      return undefined;
    }
    const holder = await holding("enrol", req, reply);
    if (holder === undefined) return undefined;
    const minter = options.enrol;
    if (minter === undefined) {
      void sendPage(reply, 503, "Enrolment is not available", [{ kind: "text", text: "This server cannot enrol Macs right now. Ask IT for an enrol link instead." }]);
      return undefined;
    }
    const next = `${ONBOARDING_LINK_PATHS.enrol}/${req.params.token}`;
    if (holder.pendingInvitationId !== undefined) {
      void sendPage(reply, posted ? 403 : 200, "Accept your invitation first", [
        { kind: "text", text: `Sign in as ${holder.email} to join your organisation. Guard brings you back here to enrol this Mac.` },
        { kind: "link", href: guardSignInPath({ invitationId: holder.pendingInvitationId, next }, options.baseUrl), label: "Accept the invitation" },
      ]);
      return undefined;
    }
    const session = readSession(req);
    if (session === undefined || !sameEmail(session.email, holder.email)) {
      const wrong = session !== undefined;
      void sendPage(reply, posted ? (wrong ? 403 : 401) : 200, `Sign in as ${holder.email}`, [
        {
          kind: "text",
          text: wrong
            ? `This enrol link is for ${holder.email}, and you are signed in with another account. Sign in as ${holder.email} to enrol this Mac.`
            : `Sign in as ${holder.email} to enrol this Mac. Guard brings you back here.`,
        },
        { kind: "link", href: guardSignInPath({ next }, options.baseUrl), label: "Sign in" },
      ]);
      return undefined;
    }
    return { minter, holder, actorEmail: session.email };
  };

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const ready = await enrolling(req, reply, false);
    if (ready === undefined) return reply;
    return sendPage(reply, 200, "Enrol this Mac in Guard", [
      { kind: "text", text: `Open this page on the Mac you are enrolling, after Guard is installed. Guard enrols it for ${ready.holder.email}.` },
      { kind: "post", label: "Make my enrol link" },
    ]);
  });

  app.post<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const ready = await enrolling(req, reply, true);
    if (ready === undefined) return reply;
    const { minter, holder, actorEmail } = ready;
    const minted = await timed(req.log, "guard.enrol_link", () => minter.mint({ orgId: holder.orgId, personEmail: holder.email, actorEmail }));
    return sendPage(reply, 200, "Your enrol link is ready", [
      { kind: "text", text: "Open Guard with it. The link works once, on one Mac, for 24 hours." },
      { kind: "link", href: minted.url, label: "Open Guard and enrol" },
      { kind: "text", text: "Or run this in Terminal:" },
      { kind: "code", text: minted.command },
    ]);
  });
};
