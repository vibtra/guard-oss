import { consolePathFor } from "@vibtra/console-api";
import { guardInvitationPath } from "../guard/entry-pages.js";
import type { MailMessage } from "./mailer.js";

const consoleUrl = (baseUrl: string, handle: string | undefined, route: string): string =>
  `${baseUrl.replace(/\/+$/, "")}${handle === undefined || handle === "" ? route : consolePathFor(handle, route)}`;

const orgWord = (orgName: string, handle: string | undefined): string =>
  orgName.trim() === "" ? (handle ?? "your organisation") : orgName.trim();

export interface InvitationMailArgs {
  baseUrl: string;
  handle: string | undefined;
  orgName: string;
  to: string;
  invitedBy: string;
  invitationId: string;
  expiresAt?: string | undefined;
}

export const invitationMail = (args: InvitationMailArgs): MailMessage => {
  const org = orgWord(args.orgName, args.handle);
  const link = guardInvitationPath(args.invitationId, args.baseUrl);
  const expiry =
    args.expiresAt === undefined
      ? "The link expires; open it soon."
      : `The link stops working on ${args.expiresAt}.`;
  return {
    to: args.to,
    subject: `${args.invitedBy} invited you to ${org} on Vibtra`,
    text:
      `${args.invitedBy} invited you to join ${org} on Vibtra.\n\n` +
      `Open this link to accept:\n${link}\n\n` +
      `${expiry} It only works for ${args.to}, and you will be asked to sign in first.\n\n` +
      "If you were not expecting this, ignore it — nothing happens until somebody accepts.\n",
  };
};

export interface PolicyRequestArrivalMailArgs {
  baseUrl: string;
  handle: string | undefined;
  orgName: string;
  to: string;
  requesterEmail: string;
  words: string;
  requestId: string;
  kind: string;
}

export const policyRequestArrivalMail = (args: PolicyRequestArrivalMailArgs): MailMessage => {
  const org = orgWord(args.orgName, args.handle);
  const link = consoleUrl(args.baseUrl, args.handle, `/requests/policy/${args.requestId}`);
  const change = args.kind === "policy-change";
  return {
    to: args.to,
    subject: change ? `${args.requesterEmail} proposed a workspace policy change` : `${args.requesterEmail} asked IT for ${args.words}`,
    text:
      (change
        ? `${args.requesterEmail} proposed a change to ${org}'s workspace policy. It takes effect only when an admin approves it.\n\n`
        : `${args.requesterEmail} asked for ${args.words} in their ${org} workspace. The page shows the facts about it.\n\n`) +
      `Approve or decline it here:\n${link}\n\n` +
      "It closes itself in 14 days if nobody decides.\n",
  };
};

export interface UsageNoticeMailArgs {
  baseUrl: string;
  handle?: string | undefined;
  orgName: string;
  to: string;
  kind: "cap80" | "cap100" | "hours80" | "hours100";
  sentence: string;
}

export const usageNoticeMail = (args: UsageNoticeMailArgs): MailMessage => {
  const org = orgWord(args.orgName, args.handle);
  const link = consoleUrl(args.baseUrl, args.handle, "/billing");
  const subjects: Record<UsageNoticeMailArgs["kind"], string> = {
    cap80: `${org} is at 80% of its monthly spending cap`,
    cap100: `${org} reached its monthly spending cap`,
    hours80: `${org} has used 80% of its Free session-hours`,
    hours100: `${org} has used all of its Free session-hours`,
  };
  const after: Record<UsageNoticeMailArgs["kind"], string> = {
    cap80: "Nothing has stopped. At 100% new sessions are refused and running ones stop after a 10-minute notice.",
    cap100: "New sessions are refused and running ones stop after a 10-minute notice, until the cap is raised or the month rolls over.",
    hours80: "Nothing has stopped. At 100% new sessions are refused and running ones stop after a 10-minute notice.",
    hours100: "New sessions are refused and running ones stop after a 10-minute notice, until the month rolls over or the plan is upgraded.",
  };
  return {
    to: args.to,
    subject: subjects[args.kind],
    text: `${args.sentence.replace(/\s+/g, " ").slice(0, 300)}\n\n${after[args.kind]}\n\nUsage and the cap are here:\n${link}\n`,
  };
};
