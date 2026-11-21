import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { readSession, toWebHeaders, type RegistrySession, type SignedInAccount } from "../auth/session.js";
import { GUARD_ACCEPT_INVITATION_ROUTE, GUARD_OWN_INVITATIONS_PATH, guardSignInPath, guardStartPath } from "../guard/entry-pages.js";
import type { Coordinator } from "../store/coordination.js";
import { INVITATION_REFUSALS, type InvitationClaim } from "../tenancy/claim.js";
import { timed } from "../telemetry.js";
import { ONBOARDING_LINK_PATHS, type OnboardingLinks, type OnboardingLinkSubject } from "./links.js";
import type { OwnInvitation } from "./own-invitations.js";

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

const INVITATION_ID = /^[A-Za-z0-9_-]{1,128}$/;

const REFUSAL_STATUS: Record<keyof typeof INVITATION_REFUSALS, number> = {
  INVITATION_NOT_FOUND: 400,
  YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION: 403,
  EMAIL_VERIFICATION_REQUIRED_BEFORE_ACCEPTING_OR_REJECTING_INVITATION: 403,
};

const NOT_A_MAC = /\b(?:iPhone|iPad|iPod|Android|Windows|CrOS|Linux)\b/;

interface OnboardingLinkHolder {
  orgId: string;
  email: string;
  linkGeneration: string | undefined;
  pendingInvitationId: string | undefined;
}

interface OnboardingEnrolMinter {
  mint(input: { orgId: string; personEmail: string; actorEmail: string; via: "email" | "enrol_page" }): Promise<{ url: string; command: string }>;
}

export interface OnboardingEntryRoutesOptions {
  links: OnboardingLinks;
  baseUrl: string;
  downloadUrl: string | undefined;
  holderOf(subject: OnboardingLinkSubject): Promise<OnboardingLinkHolder | undefined>;
  enrol: OnboardingEnrolMinter | undefined;
  verifiedIdentity(session: RegistrySession, orgId: string): Promise<boolean>;
  account(headers: Headers): Promise<SignedInAccount | undefined>;
  orgName(orgId: string): Promise<string | undefined>;
  invitationsFor(email: string): Promise<OwnInvitation[]>;
  acceptInvitation(headers: Headers, invitationId: string): Promise<InvitationClaim | { kind: "signed_out" }>;
  limiter: Coordinator;
  now: () => Date;
}

type TokenRequest = FastifyRequest<{ Params: { token: string } }>;

type Ready = { minter: OnboardingEnrolMinter; session: RegistrySession };

type Refusal = "page" | "json";

interface Enrolment {
  email: string;
  orgName: string;
}

const sameEmail = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const originOf = (url: string | undefined): string | undefined => {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

const headerOf = (req: FastifyRequest, name: string): string | undefined => {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
};

const postedFrom = (req: FastifyRequest, baseOrigin: string): boolean => {
  const origin = headerOf(req, "origin");
  if (origin !== undefined) return origin === baseOrigin;
  const site = headerOf(req, "sec-fetch-site");
  if (site !== undefined) return site === "same-origin";
  return originOf(headerOf(req, "referer")) === baseOrigin;
};

const saysItIsNotAMac = (req: FastifyRequest): boolean => NOT_A_MAC.test(headerOf(req, "user-agent") ?? "");

const installFirst = (downloadUrl: string | undefined): Paragraph[] =>
  downloadUrl === undefined
    ? [{ kind: "text", text: "Install Guard first, if it is not on this Mac yet. Your IT team sends it." }]
    : [
        { kind: "text", text: "Install Guard first, if it is not on this Mac yet." },
        { kind: "link", href: downloadUrl, label: "Download Guard" },
      ];

export const registerOnboardingEntryRoutes = (app: FastifyInstance, options: OnboardingEntryRoutesOptions): void => {
  const baseOrigin = new URL(options.baseUrl).origin;
  const ownEnrolUrl = `${options.baseUrl.replace(/\/+$/, "")}${ONBOARDING_LINK_PATHS.enrol}`;

  const limited = async (req: FastifyRequest, reply: FastifyReply, bucket: string, refusal: Refusal = "page"): Promise<boolean> => {
    const take = await timed(req.log, "rate_limit", () => options.limiter.take(`onboarding-link:${bucket}:${req.ip}`, LINK_REQUESTS_PER_MINUTE, MINUTE_MS));
    if (take.ok) return false;
    if (take.firstRefusal) req.log.warn({ route: req.routeOptions.url, count: take.count }, "onboarding link rate limited");
    const wait = String(take.retryAfterSeconds);
    void reply.header("retry-after", wait);
    if (refusal === "json") {
      void reply.code(429).header("cache-control", "no-store").send({ code: "rate_limited", message: `Too many tries. Wait ${wait} seconds, then try again.` });
    } else {
      void sendPage(reply, 429, "Too many tries", [{ kind: "text", text: `Wait ${wait} seconds, then open the link again.` }]);
    }
    return true;
  };

  const unreadable = (req: FastifyRequest, reply: FastifyReply, error: unknown): undefined => {
    req.log.error({ step: "session", error: error instanceof Error ? error.name : "unknown" }, "the sign-in could not be checked");
    void sendPage(reply.header("retry-after", "5"), 503, "Guard could not check your sign-in", [
      { kind: "text", text: "This is on our side, not yours. Wait a moment, then try again." },
      { kind: "link", href: req.url, label: "Try again" },
    ]);
    return undefined;
  };

  const sessionOr503 = (req: FastifyRequest, reply: FastifyReply): { session: RegistrySession | undefined } | undefined => {
    try {
      return { session: readSession(req) };
    } catch (error) {
      return unreadable(req, reply, error);
    }
  };

  const accountOr503 = async (req: FastifyRequest, reply: FastifyReply): Promise<{ account: SignedInAccount | undefined } | undefined> => {
    try {
      return { account: await timed(req.log, "account", () => options.account(toWebHeaders(req.headers))) };
    } catch (error) {
      return unreadable(req, reply, error);
    }
  };

  const enrolmentIn = async (req: FastifyRequest, orgId: string, email: string): Promise<Enrolment> => ({
    email,
    orgName: (await timed(req.log, "org", () => options.orgName(orgId))) ?? "your organisation",
  });

  const foreignPost = (req: FastifyRequest, reply: FastifyReply, again: string): boolean => {
    if (postedFrom(req, baseOrigin)) return false;
    void sendPage(reply, 403, "This form did not come from Guard", [{ kind: "text", text: again }]);
    return true;
  };

  const minterOf = (reply: FastifyReply): OnboardingEnrolMinter | undefined => {
    if (options.enrol === undefined) {
      void sendPage(reply, 503, "Enrolment is not available", [{ kind: "text", text: "This server cannot enrol Macs right now. Ask IT for an enrol link instead." }]);
    }
    return options.enrol;
  };

  const elsewhere = (req: FastifyRequest, reply: FastifyReply, opened: "email" | "page"): boolean => {
    if (!saysItIsNotAMac(req)) return false;
    void sendPage(
      reply,
      200,
      opened === "email" ? "Open this email on the Mac you are enrolling" : "Open this page on the Mac you are enrolling",
      opened === "email"
        ? [{ kind: "text", text: "Guard enrols the Mac that opens this link, and this device is not a Mac. Open the email from IT on the Mac you are enrolling, and press the enrol link there." }]
        : [
            { kind: "text", text: "Guard enrols the Mac that opens this page, and this device is not a Mac. On the Mac you are enrolling, open:" },
            { kind: "code", text: ownEnrolUrl },
          ],
    );
    return true;
  };

  const unverified = async (req: FastifyRequest, reply: FastifyReply, session: RegistrySession, orgId: string, posted: boolean): Promise<boolean> => {
    if (await timed(req.log, "identity", () => options.verifiedIdentity(session, orgId))) return false;
    void sendPage(reply, posted ? 403 : 200, "Your email address is not verified", [
      {
        kind: "text",
        text: `Guard enrols a Mac only for a verified address, and ${session.email} is not verified on this server. Sign in with your organisation's sign-in, or ask IT for an enrol link.`,
      },
    ]);
    return true;
  };

  const enrolPage = (reply: FastifyReply, enrolment: Enrolment): FastifyReply =>
    sendPage(reply, 200, "Enrol this Mac in Guard", [
      { kind: "text", text: `Guard enrols this Mac in ${enrolment.orgName} for ${enrolment.email}.` },
      { kind: "text", text: "Open this page on the Mac you are enrolling, after Guard is installed." },
      { kind: "post", label: "Make my enrol link" },
    ]);

  const mintedPage = (reply: FastifyReply, enrolment: Enrolment, minted: { url: string; command: string }): FastifyReply =>
    sendPage(reply, 200, "Your enrol link is ready", [
      { kind: "text", text: `It enrols a Mac in ${enrolment.orgName} for ${enrolment.email}. This works only on a Mac.` },
      ...installFirst(options.downloadUrl),
      { kind: "text", text: "Then open Guard with this link. It works once, on one Mac, for 24 hours." },
      { kind: "link", href: minted.url, label: "Open Guard and enrol" },
      { kind: "text", text: "Or run this in Terminal:" },
      { kind: "code", text: minted.command },
    ]);

  const holding = async (purpose: "download" | "enrol", req: TokenRequest, reply: FastifyReply): Promise<OnboardingLinkHolder | undefined> => {
    const read = options.links.read(purpose, req.params.token);
    if (await limited(req, reply, read.kind === "signed" ? `${read.subject.kind}:${read.subject.id}` : "unsigned")) return undefined;
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

  app.get(GUARD_OWN_INVITATIONS_PATH, async (req, reply) => {
    void reply.header("cache-control", "no-store");
    const account = await timed(req.log, "account", () => options.account(toWebHeaders(req.headers)));
    if (account === undefined) return reply.code(401).send({ code: "not_signed_in", message: "Sign in to see your invitations" });
    if (await limited(req, reply, `invitations:${account.userId}`, "json")) return reply;
    const invitations = account.emailVerified ? await timed(req.log, "own_invitations", () => options.invitationsFor(account.email)) : [];
    return reply.send({ email: account.email, verified: account.emailVerified, invitations });
  });

  app.post<{ Params: { invitationId: string } }>(GUARD_ACCEPT_INVITATION_ROUTE, async (req, reply) => {
    void reply.header("cache-control", "no-store");
    if (!postedFrom(req, baseOrigin)) {
      return reply.code(403).send({ code: "foreign_origin", message: "This request did not come from Guard. Open the invitation link from your email again." });
    }
    if (await limited(req, reply, "accept-invitation", "json")) return reply;
    const { invitationId } = req.params;
    if (!INVITATION_ID.test(invitationId)) {
      return reply.code(REFUSAL_STATUS.INVITATION_NOT_FOUND).send({ code: "INVITATION_NOT_FOUND", message: INVITATION_REFUSALS.INVITATION_NOT_FOUND });
    }
    const claim = await timed(req.log, "invitation.accept", () => options.acceptInvitation(toWebHeaders(req.headers), invitationId));
    if (claim.kind === "signed_out") return reply.code(401).send({ code: "not_signed_in", message: "Sign in to accept your invitation" });
    if (claim.kind === "refused") {
      req.log.info({ step: "accept_invitation", code: claim.code }, "invitation not accepted");
      return reply.code(REFUSAL_STATUS[claim.code]).send({ code: claim.code, message: claim.message });
    }
    req.log.info({ step: "accept_invitation", org_id: claim.orgId, joined: claim.joined }, "invitation accepted");
    return reply.send({ orgId: claim.orgId, role: claim.role });
  });

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.download}/:token`, async (req, reply) => {
    if ((await holding("download", req, reply)) === undefined) return reply;
    if (options.downloadUrl !== undefined) return reply.code(303).header("cache-control", "no-store").header("referrer-policy", "no-referrer").redirect(options.downloadUrl);
    return sendPage(reply, 200, "Your IT team sends Guard", [
      { kind: "text", text: "This organisation installs Guard for you, or sends you its own signed copy. Ask IT for it, then come back to the enrol link in your email." },
    ]);
  });

  const enrolling = async (req: TokenRequest, reply: FastifyReply, posted: boolean): Promise<(Ready & { holder: OnboardingLinkHolder }) | undefined> => {
    if (posted && foreignPost(req, reply, "Open the enrol link from your email again and press the button there.")) return undefined;
    const holder = await holding("enrol", req, reply);
    if (holder === undefined) return undefined;
    const minter = minterOf(reply);
    if (minter === undefined) return undefined;
    const next = `${ONBOARDING_LINK_PATHS.enrol}/${req.params.token}`;
    if (holder.pendingInvitationId !== undefined) {
      void sendPage(reply, posted ? 403 : 200, "Accept your invitation first", [
        { kind: "text", text: `Sign in as ${holder.email} to join your organisation. Guard brings you back here to enrol this Mac.` },
        { kind: "link", href: guardSignInPath({ invitationId: holder.pendingInvitationId, next }, options.baseUrl), label: "Accept the invitation" },
      ]);
      return undefined;
    }
    if (elsewhere(req, reply, "email")) return undefined;
    const read = sessionOr503(req, reply);
    if (read === undefined) return undefined;
    const { session } = read;
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
    if (await unverified(req, reply, session, holder.orgId, posted)) return undefined;
    return { minter, holder, session };
  };

  app.get<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const ready = await enrolling(req, reply, false);
    return ready === undefined ? reply : enrolPage(reply, await enrolmentIn(req, ready.holder.orgId, ready.holder.email));
  });

  app.post<{ Params: { token: string } }>(`${ONBOARDING_LINK_PATHS.enrol}/:token`, async (req, reply) => {
    const ready = await enrolling(req, reply, true);
    if (ready === undefined) return reply;
    const { minter, holder, session } = ready;
    const enrolment = await enrolmentIn(req, holder.orgId, holder.email);
    const minted = await timed(req.log, "guard.enrol_link", () => minter.mint({ orgId: holder.orgId, personEmail: holder.email, actorEmail: session.email, via: "email" }));
    return mintedPage(reply, enrolment, minted);
  });

  const enrollingSelf = async (req: FastifyRequest, reply: FastifyReply, posted: boolean): Promise<Ready | undefined> => {
    if (posted && foreignPost(req, reply, "Open this page again and press the button there.")) return undefined;
    const read = sessionOr503(req, reply);
    if (read === undefined) return undefined;
    const { session } = read;
    if (await limited(req, reply, `self:${session?.userId ?? "anonymous"}`)) return undefined;
    const minter = minterOf(reply);
    if (minter === undefined) return undefined;
    if (elsewhere(req, reply, "page")) return undefined;
    if (session === undefined) {
      const looked = await accountOr503(req, reply);
      if (looked === undefined) return undefined;
      const { account } = looked;
      const next = ONBOARDING_LINK_PATHS.enrol;
      void sendPage(
        reply,
        posted ? (account === undefined ? 401 : 403) : 200,
        account === undefined ? "Sign in to enrol this Mac" : "Join your organisation first",
        account === undefined
          ? [
              { kind: "text", text: "Sign in with your work account. Guard brings you back here to make an enrol link for this Mac." },
              { kind: "link", href: guardSignInPath({ next }, options.baseUrl), label: "Sign in" },
            ]
          : [
              { kind: "text", text: `${account.email} is signed in, but is not in an organisation on Guard yet. Join yours, and Guard brings you back here.` },
              { kind: "link", href: guardStartPath({ next }, options.baseUrl), label: "See your invitations" },
            ],
      );
      return undefined;
    }
    if (await unverified(req, reply, session, session.orgId, posted)) return undefined;
    return { minter, session };
  };

  app.get(ONBOARDING_LINK_PATHS.enrol, async (req, reply) => {
    const ready = await enrollingSelf(req, reply, false);
    return ready === undefined ? reply : enrolPage(reply, await enrolmentIn(req, ready.session.orgId, ready.session.email));
  });

  app.post(ONBOARDING_LINK_PATHS.enrol, async (req, reply) => {
    const ready = await enrollingSelf(req, reply, true);
    if (ready === undefined) return reply;
    const { minter, session } = ready;
    const enrolment = await enrolmentIn(req, session.orgId, session.email);
    const minted = await timed(req.log, "guard.enrol_link", () => minter.mint({ orgId: session.orgId, personEmail: session.email, actorEmail: session.email, via: "enrol_page" }));
    return mintedPage(reply, enrolment, minted);
  });
};
