import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const ONBOARDING_LINK_DAYS = 14;

const DAY_MS = 86_400_000;

export const ONBOARDING_LINK_PURPOSES = ["download", "enrol"] as const;
export type OnboardingLinkPurpose = (typeof ONBOARDING_LINK_PURPOSES)[number];

const OnboardingLinkClaims = z
  .object({
    purpose: z.enum(ONBOARDING_LINK_PURPOSES),
    orgId: z.string().min(1).max(200),
    invitationId: z.string().min(1).max(200),
    email: z.string().min(3).max(320),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type OnboardingLinkClaims = z.infer<typeof OnboardingLinkClaims>;

export type OnboardingLinkCheck =
  | { kind: "valid"; claims: OnboardingLinkClaims }
  | { kind: "expired"; claims: OnboardingLinkClaims }
  | { kind: "invalid" };

export interface OnboardingLinkSubject {
  orgId: string;
  invitationId: string;
  email: string;
}

export interface OnboardingLinks {
  mint(purpose: OnboardingLinkPurpose, subject: OnboardingLinkSubject): string;
  urlFor(purpose: OnboardingLinkPurpose, subject: OnboardingLinkSubject): string;
  check(purpose: OnboardingLinkPurpose, token: string): OnboardingLinkCheck;
}

export const ONBOARDING_LINK_PATHS: Record<OnboardingLinkPurpose, string> = {
  download: "/guard/download",
  enrol: "/guard/enrol",
};

const TOKEN = /^[A-Za-z0-9_-]{1,2000}\.[A-Za-z0-9_-]{43}$/;

const parseClaims = (encoded: string): OnboardingLinkClaims | undefined => {
  try {
    const parsed = OnboardingLinkClaims.safeParse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export interface OnboardingLinksOptions {
  secret: string;
  baseUrl: string;
  now: () => Date;
}

export const createOnboardingLinks = (options: OnboardingLinksOptions): OnboardingLinks => {
  const key = createHmac("sha256", options.secret).update("vibtra onboarding links").digest();
  const signatureOf = (encoded: string): Buffer => createHmac("sha256", key).update(encoded).digest();
  const base = options.baseUrl.replace(/\/+$/, "");
  const mint = (purpose: OnboardingLinkPurpose, subject: OnboardingLinkSubject): string => {
    const claims: OnboardingLinkClaims = {
      purpose,
      orgId: subject.orgId,
      invitationId: subject.invitationId,
      email: subject.email.trim().toLowerCase(),
      expiresAt: Math.floor((options.now().getTime() + ONBOARDING_LINK_DAYS * DAY_MS) / 1000),
    };
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return `${encoded}.${signatureOf(encoded).toString("base64url")}`;
  };
  return {
    mint,
    urlFor: (purpose, subject) => `${base}${ONBOARDING_LINK_PATHS[purpose]}/${mint(purpose, subject)}`,
    check(purpose, token) {
      if (!TOKEN.test(token)) return { kind: "invalid" };
      const [encoded = "", signature = ""] = token.split(".");
      const presented = Buffer.from(signature, "base64url");
      const expected = signatureOf(encoded);
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { kind: "invalid" };
      const claims = parseClaims(encoded);
      if (claims === undefined || claims.purpose !== purpose) return { kind: "invalid" };
      if (claims.expiresAt * 1000 <= options.now().getTime()) return { kind: "expired", claims };
      return { kind: "valid", claims };
    },
  };
};
