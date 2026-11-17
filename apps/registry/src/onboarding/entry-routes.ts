import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { guardInvitationPath } from "../guard/entry-pages.js";
import { timed } from "../telemetry.js";
import { ONBOARDING_LINK_PATHS, type OnboardingLinkClaims, type OnboardingLinks } from "./links.js";

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
  { kind: "text", text: "This link is not one Guard made, or it was changed on the way. Open the link in your invitation email again, or ask IT to re-send the invitation." },
];

const EXPIRED_LINK: readonly Paragraph[] = [
  { kind: "text", text: "This link from your invitation email has expired. Ask IT to re-send the invitation; the new email has fresh links." },
];

export interface OnboardingEnrolDoor {
  isMember(orgId: string, email: string): Promise<boolean>;
  mintEnrolLink(orgId: string, email: string): Promise<{ url: string; command: string }>;
}

export interface OnboardingEntryRoutesOptions {
  links: OnboardingLinks;
  baseUrl: string;
  downloadUrl: string | undefined;
  enrol: OnboardingEnrolDoor | undefined;
}

export const registerOnboardingEntryRoutes = (root: FastifyInstance, options: OnboardingEntryRoutesOptions): void => {
  void root.register(async (app) => {
    app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 1024 }, (_req, _body, done) => done(null, {}));
    registerRoutes(app, options);
  });
};

const registerRoutes = (app: FastifyInstance, options: OnboardingEntryRoutesOptions): void => {
  const checked = (purpose: "download" | "enrol", token: string, reply: FastifyReply): OnboardingLinkClaims | undefined => {
    const check = options.links.check(purpose, token);
    if (check.kind === "valid") return check.claims;
    void sendPage(reply, check.kind === "expired" ? 410 : 404, check.kind === "expired" ? "This link has expired" : "This link does not work", check.kind === "expired" ? EXPIRED_LINK : UNKNOWN_LINK);
    return undefined;
  };

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.download}/:token`, async (req, reply) => {
    if (checked("download", req.params.token, reply) === undefined) return reply;
    if (options.downloadUrl !== undefined) return reply.code(303).header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(options.downloadUrl);
    return sendPage(reply, 200, "Your IT team sends Guard", [
      { kind: "text", text: "This organisation installs Guard for you, or sends you its own signed copy. Ask IT for it, then come back to the enrol link in your invitation email." },
    ]);
  });

  const enrolDoor = (reply: FastifyReply): OnboardingEnrolDoor | undefined => {
    if (options.enrol !== undefined) return options.enrol;
    void sendPage(reply, 503, "Enrolment is not available", [{ kind: "text", text: "This server cannot enrol Macs right now. Ask IT for an enrol link instead." }]);
    return undefined;
  };

  const notYetMember = (claims: OnboardingLinkClaims, reply: FastifyReply): FastifyReply =>
    sendPage(reply, 200, "Accept your invitation first", [
      { kind: "text", text: `Sign in as ${claims.email} to join your organisation. Then open this enrol link again on the Mac you are enrolling.` },
      { kind: "link", href: guardInvitationPath(claims.invitationId, options.baseUrl), label: "Accept the invitation" },
    ]);

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const claims = checked("enrol", req.params.token, reply);
    if (claims === undefined) return reply;
    const door = enrolDoor(reply);
    if (door === undefined) return reply;
    if (!(await timed(req.log, "members", () => door.isMember(claims.orgId, claims.email)))) return notYetMember(claims, reply);
    return sendPage(reply, 200, "Enrol this Mac in Guard", [
      { kind: "text", text: `Open this page on the Mac you are enrolling, after Guard is installed. Guard enrols it for ${claims.email}.` },
      { kind: "post", label: "Make my enrol link" },
    ]);
  });

  app.post<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const claims = checked("enrol", req.params.token, reply);
    if (claims === undefined) return reply;
    const door = enrolDoor(reply);
    if (door === undefined) return reply;
    if (!(await timed(req.log, "members", () => door.isMember(claims.orgId, claims.email)))) return notYetMember(claims, reply);
    const minted = await timed(req.log, "guard.enrol_link", () => door.mintEnrolLink(claims.orgId, claims.email));
    return sendPage(reply, 200, "Your enrol link is ready", [
      { kind: "text", text: "Open Guard with it. The link works once, on one Mac, for 24 hours." },
      { kind: "link", href: minted.url, label: "Open Guard and enrol" },
      { kind: "text", text: "Or run this in Terminal:" },
      { kind: "code", text: minted.command },
    ]);
  });
};
