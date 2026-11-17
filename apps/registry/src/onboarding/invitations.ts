import type { InviteDelivery } from "@vibtra/console-api";
import { guardInvitationPath } from "../guard/entry-pages.js";
import type { Mailer } from "../mail/mailer.js";
import { enrolReminderMail, invitationMail } from "../mail/templates.js";
import type { OnboardingLinks } from "./links.js";

interface InvitationToDeliver {
  orgId: string;
  invitationId: string;
  email: string;
  invitedBy: string;
  expiresAt: string | undefined;
}

interface ReminderToDeliver {
  orgId: string;
  memberId: string;
  email: string;
  remindedBy: string;
  linkGeneration: string;
}

type EmailedOutcome = { delivery: Extract<InviteDelivery, "emailed"> };

type NotEmailed = Exclude<InviteDelivery, "emailed">;

export type InviteOutcome = EmailedOutcome | { delivery: NotEmailed; inviteUrl: string };

type ReminderOutcome = EmailedOutcome | { delivery: NotEmailed; enrolUrl: string };

export interface Sent<Outcome> {
  outcome: Outcome;
  sentAt: string;
}

export const recordsSend = (outcome: { delivery: InviteDelivery }): boolean => outcome.delivery !== "send_failed";

export interface InvitationDeliveryOptions {
  mailer: Mailer;
  links: OnboardingLinks;
  baseUrl: string;
  orgs: { getOrg(orgId: string): Promise<{ name: string; handle?: string } | undefined> };
  staffNotice: (orgId: string) => Promise<string>;
  now: () => Date;
}

export interface InvitationDeliverer {
  readonly mailEnabled: boolean;
  deliver(invitation: InvitationToDeliver): Promise<Sent<InviteOutcome>>;
  remind(reminder: ReminderToDeliver): Promise<Sent<ReminderOutcome>>;
}

export const createInvitationDeliverer = (options: InvitationDeliveryOptions): InvitationDeliverer => {
  const { mailer, links } = options;
  const orgAndNotice = (orgId: string) => Promise.all([options.orgs.getOrg(orgId), options.staffNotice(orgId)]);
  return {
    mailEnabled: mailer.enabled,
    async deliver(invitation) {
      const sentAt = options.now().toISOString();
      const inviteUrl = guardInvitationPath(invitation.invitationId, options.baseUrl);
      if (!mailer.enabled) return { outcome: { delivery: "mail_off", inviteUrl }, sentAt };
      const subject = { kind: "invitation", id: invitation.invitationId } as const;
      const issue = { generation: sentAt, ...(invitation.expiresAt === undefined ? {} : { notAfter: invitation.expiresAt }) };
      const [org, staffNotice] = await orgAndNotice(invitation.orgId);
      const emailed = await mailer.send(
        invitationMail({
          baseUrl: options.baseUrl,
          handle: org?.handle,
          orgName: org?.name ?? invitation.orgId,
          to: invitation.email,
          invitedBy: invitation.invitedBy,
          invitationId: invitation.invitationId,
          expiresAt: invitation.expiresAt,
          staffNotice,
          downloadUrl: links.urlFor("download", subject, issue),
          enrolUrl: links.urlFor("enrol", subject, issue),
        }),
      );
      return { outcome: emailed ? { delivery: "emailed" } : { delivery: "send_failed", inviteUrl }, sentAt };
    },
    async remind(reminder) {
      const sentAt = options.now().toISOString();
      const subject = { kind: "member", id: reminder.memberId } as const;
      const issue = { generation: sentAt };
      const enrolUrl = links.urlFor("enrol", subject, issue);
      if (!mailer.enabled) return { outcome: { delivery: "mail_off", enrolUrl }, sentAt };
      const [org, staffNotice] = await orgAndNotice(reminder.orgId);
      const emailed = await mailer.send(
        enrolReminderMail({
          handle: org?.handle,
          orgName: org?.name ?? reminder.orgId,
          to: reminder.email,
          remindedBy: reminder.remindedBy,
          staffNotice,
          downloadUrl: links.urlFor("download", subject, issue),
          enrolUrl,
        }),
      );
      if (emailed) return { outcome: { delivery: "emailed" }, sentAt };
      return { outcome: { delivery: "send_failed", enrolUrl: links.urlFor("enrol", subject, { generation: reminder.linkGeneration }) }, sentAt };
    },
  };
};
