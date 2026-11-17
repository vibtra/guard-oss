import * as React from "react";
import { Link } from "react-router";
import { MailIcon, PartyPopperIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleInvitationCreated, OnboardingInviteRow, OnboardingRow } from "@vibtra/console-api";
import { ActionButton, DataTable, EMPTY, EmptyState, FieldStack, Modal, ModalFooter, type DataColumn } from "@/components/kit";
import { refusalSentence } from "../api/client";
import { When, plural } from "../guard/words";
import { onboardingDoor } from "./doors";
import { PersonTitle } from "./fleet";
import { InvitationLink, invitationOutcome } from "./InviteSheet";
import { useSession } from "../api/session";
import { StageChip } from "./onboarding";

const keyOf = (row: OnboardingRow): string => (row.kind === "person" ? row.userId : `invite:${row.invitationId}`);

export function useResend(onSent: () => void): { busy: string | undefined; resend: (row: OnboardingInviteRow) => Promise<void>; unsentModal: React.ReactNode } {
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const [unsent, setUnsent] = React.useState<ConsoleInvitationCreated | undefined>(undefined);
  const { orgName } = useSession();
  const said = unsent === undefined ? undefined : invitationOutcome(unsent, orgName);
  const resend = async (row: OnboardingInviteRow) => {
    setBusy(row.invitationId);
    try {
      const made = await onboardingDoor.resend(row.invitationId);
      if (made.emailed === true) toast.success(`Invitation sent again to ${made.email}.`);
      else setUnsent(made);
      onSent();
    } catch (error) {
      toastError(`The invitation to ${row.email} was not sent again`, refusalSentence(error));
    } finally {
      setBusy(undefined);
    }
  };
  const unsentModal = (
    <Modal
      open={unsent !== undefined}
      onClose={() => setUnsent(undefined)}
      role="dialog"
      title={said?.title ?? ""}
      description={said?.description}
      footer={
        <ModalFooter>
          <ActionButton variant="primary" onClick={() => setUnsent(undefined)}>
            Done
          </ActionButton>
        </ModalFooter>
      }
    >
      {unsent === undefined ? null : (
        <FieldStack data-testid="resend-link" className="gap-6">
          <InvitationLink invitationId={unsent.invitationId} expiresAt={unsent.expiresAt} emailed={false} />
        </FieldStack>
      )}
    </Modal>
  );
  return { busy, resend, unsentModal };
}

export function ChaseList({
  rows,
  chaseAfterDays,
  mayResend,
  onSent,
}: {
  rows: readonly OnboardingRow[];
  chaseAfterDays: number;
  mayResend: boolean;
  onSent: () => void;
}) {
  const { busy, resend, unsentModal } = useResend(onSent);
  const stuck = rows.filter((row) => row.chase).sort((a, b) => Date.parse(a.stageSince) - Date.parse(b.stageSince));

  const columns: DataColumn<OnboardingRow>[] = [
    {
      id: "name",
      header: "Name",
      cell: (row) => <PersonTitle email={row.email} name={row.kind === "person" ? row.name : undefined} sub={row.kind === "invite" ? "Has not accepted the invitation" : undefined} />,
    },
    { id: "stage", header: "Stuck at", width: "230px", cell: (row) => <StageChip stage={row.stage} since={row.stageSince} /> },
    {
      id: "sent",
      header: "Last sent",
      width: "150px",
      cell: (row) => (row.kind === "invite" && row.lastSentAt !== undefined ? <When iso={row.lastSentAt} /> : EMPTY),
    },
    ...(mayResend
      ? [
          {
            id: "resend",
            header: <span className="sr-only">Re-send</span>,
            width: "190px",
            align: "end" as const,
            cell: (row: OnboardingRow) =>
              row.kind === "invite" ? (
                <ActionButton
                  static
                  icon={MailIcon}
                  disabled={busy !== undefined}
                  onClick={() => void resend(row)}
                  aria-label={`Re-send the invitation to ${row.email}`}
                  data-testid="chase-resend"
                >
                  {busy === row.invitationId ? "Sending…" : "Re-send invitation"}
                </ActionButton>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div data-testid="chase-list">
      <p className="mb-4 max-w-[72ch] text-14 text-pretty text-g-muted">
        People invited or signed in who have not enrolled a Mac after {plural(chaseAfterDays, "day", "days")}. An email reminds them; it cannot install Guard.{" "}
        <Link to="/settings" className="focus-knox rounded-sm text-g-ink underline underline-offset-2 outline-hidden">
          Change the number of days
        </Link>
      </p>
      <DataTable<OnboardingRow>
        label="Chase list"
        rows={stuck}
        rowKey={keyOf}
        columns={columns}
        minWidth={720}
        empty={<EmptyState icon={PartyPopperIcon} title="Nobody is stuck" description={`Everyone invited more than ${plural(chaseAfterDays, "day", "days")} ago has enrolled a Mac.`} />}
      />
      {unsentModal}
    </div>
  );
}
