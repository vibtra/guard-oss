import { createHmac, timingSafeEqual } from "node:crypto";

const ONBOARDING_LINK_DAYS = 14;

const DAY_MS = 86_400_000;

const ONBOARDING_LINK_PURPOSES = ["download", "enrol"] as const;
type OnboardingLinkPurpose = (typeof ONBOARDING_LINK_PURPOSES)[number];

const ONBOARDING_LINK_SUBJECTS = ["invitation", "member"] as const;
type OnboardingLinkSubjectKind = (typeof ONBOARDING_LINK_SUBJECTS)[number];

export interface OnboardingLinkSubject {
  kind: OnboardingLinkSubjectKind;
  id: string;
}

interface OnboardingLinkIssue {
  generation: string;
  notAfter?: string;
}

type OnboardingLinkRead =
  | { kind: "invalid" }
  | { kind: "signed"; subject: OnboardingLinkSubject; expiresAt: Date; signedFor(generation: string | undefined): boolean };

export interface OnboardingLinks {
  urlFor(purpose: OnboardingLinkPurpose, subject: OnboardingLinkSubject, issue: OnboardingLinkIssue): string;
  read(purpose: OnboardingLinkPurpose, token: string): OnboardingLinkRead;
}

export const ONBOARDING_LINK_PATHS: Record<OnboardingLinkPurpose, string> = {
  download: "/guard/download",
  enrol: "/guard/enrol",
};

const PURPOSE_MARK: Record<OnboardingLinkPurpose, string> = { download: "d", enrol: "e" };

const SUBJECT_MARK: Record<OnboardingLinkSubjectKind, string> = { invitation: "i", member: "m" };

const SUBJECT_OF_MARK: Readonly<Record<string, OnboardingLinkSubjectKind>> = { i: "invitation", m: "member" };

const TOKEN = /^([A-Za-z0-9_-]{1,64})\.([de])([im])([0-9a-z]{1,9})\.([A-Za-z0-9_-]{22})$/;

const SIGNATURE_BYTES = 16;

export interface OnboardingLinksOptions {
  secret: string;
  baseUrl: string;
  now: () => Date;
}

export const createOnboardingLinks = (options: OnboardingLinksOptions): OnboardingLinks => {
  const key = createHmac("sha256", options.secret).update("vibtra onboarding links").digest();
  const signatureOf = (purpose: OnboardingLinkPurpose, subject: OnboardingLinkSubject, generation: string, expiresAt: string): string =>
    createHmac("sha256", key)
      .update(`${purpose}\n${subject.kind}\n${subject.id}\n${generation}\n${expiresAt}`)
      .digest()
      .subarray(0, SIGNATURE_BYTES)
      .toString("base64url");
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    urlFor(purpose, subject, issue) {
      const fortnight = options.now().getTime() + ONBOARDING_LINK_DAYS * DAY_MS;
      const until = issue.notAfter === undefined ? fortnight : Math.min(fortnight, Date.parse(issue.notAfter));
      const expiresAt = Math.floor(until / 1000).toString(36);
      const signature = signatureOf(purpose, subject, issue.generation, expiresAt);
      return `${base}${ONBOARDING_LINK_PATHS[purpose]}/${subject.id}.${PURPOSE_MARK[purpose]}${SUBJECT_MARK[subject.kind]}${expiresAt}.${signature}`;
    },
    read(purpose, token) {
      const match = TOKEN.exec(token);
      if (match === null) return { kind: "invalid" };
      const [, id = "", mark = "", subjectMark = "", expiresAt = "", signature = ""] = match;
      const kind = SUBJECT_OF_MARK[subjectMark];
      if (mark !== PURPOSE_MARK[purpose] || kind === undefined) return { kind: "invalid" };
      const subject: OnboardingLinkSubject = { kind, id };
      const presented = Buffer.from(signature, "utf8");
      return {
        kind: "signed",
        subject,
        expiresAt: new Date(parseInt(expiresAt, 36) * 1000),
        signedFor(generation) {
          if (generation === undefined) return false;
          const expected = Buffer.from(signatureOf(purpose, subject, generation, expiresAt), "utf8");
          return presented.length === expected.length && timingSafeEqual(presented, expected);
        },
      };
    },
  };
};
