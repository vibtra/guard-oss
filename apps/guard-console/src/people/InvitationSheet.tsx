import { MailIcon } from "lucide-react";
import type { ConsoleInvitationCreated, OnboardingInviteRow } from "@vibtra/console-api";
import { ActionButton, DetailSheet, EMPTY, Pill, SheetDefinitions, SheetSection } from "@/components/kit";
import { When } from "../guard/words";
import { useResend } from "./ChaseList";
import { StageChip } from "./onboarding";
import { ROLES } from "./roles";

export function InvitationSheet({ open, invite, mayResend, onClose, onSent }: { open: boolean; invite: OnboardingInviteRow; mayResend: boolean; onClose: () => void; onSent: (made: ConsoleInvitationCreated) => void }) {
  const { busy, resend, unsentModal } = useResend(onSent);
  return (
    <>
      <DetailSheet open={open} onClose={onClose} title={invite.email} pills={<StageChip stage={invite.stage} since={invite.stageSince} />} sub="Has not accepted the invitation yet.">
        <div data-testid="invitation-sheet" className="flex flex-col gap-6">
          <SheetDefinitions
            rows={[
              { label: "Role", value: <Pill tone={ROLES[invite.role].tone}>{ROLES[invite.role].label}</Pill> },
              { label: "Invited", value: <When iso={invite.stageSince} /> },
              { label: "Last sent", value: invite.lastSentAt === undefined ? EMPTY : <When iso={invite.lastSentAt} /> },
              { label: "Link expires", value: <When iso={invite.expiresAt} /> },
            ]}
          />
          {mayResend ? (
            <SheetSection title="Invitation" description="Re-sending makes a new link. Links sent before stop working.">
              <div>
                <ActionButton icon={MailIcon} disabled={busy !== undefined} onClick={() => void resend(invite)} data-testid="invitation-resend">
                  {busy === undefined ? "Re-send invitation" : "Sending…"}
                </ActionButton>
              </div>
            </SheetSection>
          ) : null}
        </div>
      </DetailSheet>
      {unsentModal}
    </>
  );
}
