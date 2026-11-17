import * as React from "react";
import { Link } from "react-router";
import { BellIcon, MailIcon, PartyPopperIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleInvitationCreated, InviteDelivery, OnboardingInviteRow, OnboardingPersonRow, OnboardingRow } from "@vibtra/console-api";
import { ActionButton, DataTable, EMPTY, EmptyState, FieldStack, Modal, ModalFooter, type DataColumn } from "@/components/kit";
import { refusalSentence } from "../api/client";
import { useSession } from "../api/session";
import { When, plural } from "../guard/words";
import { SentLink, deliveryWords, type Sent } from "./delivery";
import { onboardingDoor } from "./doors";
import { PersonTitle } from "./fleet";
import { StageChip } from "./onboarding";

const keyOf = (row: OnboardingRow): string => (row.kind === "person" ? row.userId : `invite:${row.invitationId}`);

interface Shown {
  title: string;
  description: string;
  label: string;
  link: string;
  expiresAt?: string | undefined;
}

export interface Chase {
  busy: string | undefined;
  resend: (row: OnboardingInviteRow) => Promise<void>;
  remind: (row: OnboardingPersonRow) => Promise<void>;
  linkModal: React.ReactNode;
}

export function useChase(onSent: (made?: ConsoleInvitationCreated) => void): Chase {
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const [shown, setShown] = React.useState<Shown | undefined>(undefined);
  const { orgName } = useSession();

  const settle = (delivery: InviteDelivery, sent: Sent, link: { label: string; url: string | undefined; expiresAt?: string | undefined }) => {
    const said = deliveryWords(delivery, sent);
    if (link.url === undefined) toast.success(said.title, { description: said.description });
    else setShown({ ...said, label: link.label, link: link.url, expiresAt: link.expiresAt });
  };

  const resend = async (row: OnboardingInviteRow) => {
    setBusy(row.invitationId);
    try {
      const made = await onboardingDoor.resend(row.invitationId);
      settle(made.delivery, { kind: "invitation", email: made.email, role: made.role, orgName, again: true }, { label: "Invitation link", url: made.inviteUrl, expiresAt: made.expiresAt });
      onSent(made);
    } catch (error) {
      toastError(`The invitation to ${row.email} was not sent again`, refusalSentence(error));
    } finally {
      setBusy(undefined);
    }
  };

  const remind = async (row: OnboardingPersonRow) => {
    setBusy(row.userId);
    try {
      const sent = await onboardingDoor.remind(row.userId);
      settle(sent.delivery, { kind: "reminder", email: sent.email }, { label: "Enrol link", url: sent.enrolUrl });
      onSent();
    } catch (error) {
      toastError(`No reminder was sent to ${row.email}`, refusalSentence(error));
    } finally {
      setBusy(undefined);
    }
  };

  const linkModal = (
    <Modal
      open={shown !== undefined}
      onClose={() => setShown(undefined)}
      role="dialog"
      title={shown?.title ?? ""}
      description={shown?.description}
      footer={
        <ModalFooter>
          <ActionButton variant="primary" onClick={() => setShown(undefined)}>
            Done
          </ActionButton>
        </ModalFooter>
      }
    >
      {shown === undefined ? null : (
        <FieldStack data-testid="sent-link" className="gap-6">
          <SentLink label={shown.label} link={shown.link} expiresAt={shown.expiresAt} />
        </FieldStack>
      )}
    </Modal>
  );
  return { busy, resend, remind, linkModal };
}

export function ChaseList({
  rows,
  chaseAfterDays,
  mailEnabled,
  mayChase,
  chase,
}: {
  rows: readonly OnboardingRow[];
  chaseAfterDays: number;
  mailEnabled: boolean;
  mayChase: boolean;
  chase: Pick<Chase, "busy" | "resend" | "remind">;
}) {
  const { busy, resend, remind } = chase;
  const stuck = rows.filter((row) => row.chase).sort((a, b) => Date.parse(a.stageSince) - Date.parse(b.stageSince));
  const days = plural(chaseAfterDays, "day", "days");

  const action = (row: OnboardingRow): React.ReactNode => {
    if (row.kind === "invite")
      return (
        <ActionButton static icon={MailIcon} disabled={busy !== undefined} onClick={() => void resend(row)} aria-label={`Re-send the invitation to ${row.email}`} data-testid="chase-resend">
          {busy === row.invitationId ? "Sending…" : "Re-send invitation"}
        </ActionButton>
      );
    if (row.stage !== "signed_in") return null;
    return (
      <ActionButton static icon={BellIcon} disabled={busy !== undefined} onClick={() => void remind(row)} aria-label={`Send a reminder to ${row.email}`} data-testid="chase-remind">
        {busy === row.userId ? "Sending…" : "Send reminder"}
      </ActionButton>
    );
  };

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
      cell: (row) => (row.lastSentAt !== undefined ? <When iso={row.lastSentAt} /> : EMPTY),
    },
    ...(mayChase ? [{ id: "chase", header: <span className="sr-only">Chase</span>, width: "200px", align: "end" as const, cell: action }] : []),
  ];

  return (
    <div data-testid="chase-list">
      <p className="mb-4 max-w-[72ch] text-14 text-pretty text-g-muted">
        People invited or signed in who have not enrolled a Mac after {days}.{" "}
        {mailEnabled
          ? "Re-sending or reminding emails them the links again. It cannot install Guard for them."
          : "Email is not set up on this server, so re-sending or reminding gives you a link to send them yourself."}{" "}
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
        empty={<EmptyState icon={PartyPopperIcon} title="Nobody is stuck" description={`Everyone invited more than ${days} ago has enrolled a Mac.`} />}
      />
    </div>
  );
}
