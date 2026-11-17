import { guardInvitationPath } from "../guard/entry-pages.js";
import type { Mailer } from "../mail/mailer.js";
import { invitationMail } from "../mail/templates.js";
import type { OnboardingLinks } from "./links.js";

interface InvitationToDeliver {
  orgId: string;
  invitationId: string;
  email: string;
  invitedBy: string;
  expiresAt: string | undefined;
}

interface InvitationDelivery {
  emailed: boolean;
  inviteUrl: string;
}

export interface InvitationDeliveryOptions {
  mailer: Mailer;
  links: OnboardingLinks;
  baseUrl: string;
  orgs: { getOrg(orgId: string): Promise<{ name: string; handle?: string } | undefined> };
  staffNotice: (orgId: string) => Promise<string>;
}

export interface InvitationDeliverer {
  readonly mailEnabled: boolean;
  deliver(invitation: InvitationToDeliver): Promise<InvitationDelivery>;
}

export const createInvitationDeliverer = (options: InvitationDeliveryOptions): InvitationDeliverer => ({
  mailEnabled: options.mailer.enabled,
  async deliver(invitation) {
    const inviteUrl = guardInvitationPath(invitation.invitationId, options.baseUrl);
    const { mailer } = options;
    if (!mailer.enabled) return { emailed: false, inviteUrl };
    const [org, staffNotice] = await Promise.all([options.orgs.getOrg(invitation.orgId), options.staffNotice(invitation.orgId)]);
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
        downloadUrl: options.links.urlFor("download", invitation.invitationId),
        enrolUrl: options.links.urlFor("enrol", invitation.invitationId),
      }),
    );
    return { emailed, inviteUrl };
  },
});
