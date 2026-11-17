import { createHmac, timingSafeEqual } from "node:crypto";

const ONBOARDING_LINK_DAYS = 14;

const DAY_MS = 86_400_000;

const ONBOARDING_LINK_PURPOSES = ["download", "enrol"] as const;
export type OnboardingLinkPurpose = (typeof ONBOARDING_LINK_PURPOSES)[number];

const PURPOSE_MARK: Record<OnboardingLinkPurpose, string> = { download: "d", enrol: "e" };

export interface OnboardingLinkClaims {
  purpose: OnboardingLinkPurpose;
  invitationId: string;
  expiresAt: Date;
}

type OnboardingLinkCheck =
  | { kind: "valid"; claims: OnboardingLinkClaims }
  | { kind: "expired"; claims: OnboardingLinkClaims }
  | { kind: "invalid" };

export interface OnboardingLinks {
  urlFor(purpose: OnboardingLinkPurpose, invitationId: string): string;
  check(purpose: OnboardingLinkPurpose, token: string): OnboardingLinkCheck;
}

export const ONBOARDING_LINK_PATHS: Record<OnboardingLinkPurpose, string> = {
  download: "/guard/download",
  enrol: "/guard/enrol",
};

const TOKEN = /^([A-Za-z0-9_-]{1,64})\.([de])([0-9a-z]{1,9})\.([A-Za-z0-9_-]{22})$/;

const SIGNATURE_BYTES = 16;

export interface OnboardingLinksOptions {
  secret: string;
  baseUrl: string;
  now: () => Date;
}

export const createOnboardingLinks = (options: OnboardingLinksOptions): OnboardingLinks => {
  const key = createHmac("sha256", options.secret).update("vibtra onboarding links").digest();
  const signatureOf = (purpose: OnboardingLinkPurpose, invitationId: string, expiresAt: string): Buffer =>
    createHmac("sha256", key).update(`${purpose}\n${invitationId}\n${expiresAt}`).digest().subarray(0, SIGNATURE_BYTES);
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    urlFor(purpose, invitationId) {
      const expiresAt = Math.floor((options.now().getTime() + ONBOARDING_LINK_DAYS * DAY_MS) / 1000).toString(36);
      const signature = signatureOf(purpose, invitationId, expiresAt).toString("base64url");
      return `${base}${ONBOARDING_LINK_PATHS[purpose]}/${invitationId}.${PURPOSE_MARK[purpose]}${expiresAt}.${signature}`;
    },
    check(purpose, token) {
      const match = TOKEN.exec(token);
      if (match === null) return { kind: "invalid" };
      const [, invitationId = "", mark = "", expiresAt = "", signature = ""] = match;
      if (mark !== PURPOSE_MARK[purpose]) return { kind: "invalid" };
      const presented = Buffer.from(signature, "utf8");
      const expected = Buffer.from(signatureOf(purpose, invitationId, expiresAt).toString("base64url"), "utf8");
      if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { kind: "invalid" };
      const claims: OnboardingLinkClaims = { purpose, invitationId, expiresAt: new Date(parseInt(expiresAt, 36) * 1000) };
      return claims.expiresAt.getTime() <= options.now().getTime() ? { kind: "expired", claims } : { kind: "valid", claims };
    },
  };
};
