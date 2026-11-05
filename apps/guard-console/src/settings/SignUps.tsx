import * as React from "react";
import { AtSignIcon, GlobeIcon, PlusIcon, Trash2Icon, UsersIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleAllowlistRow, ConsoleRegistrationPage } from "@vibtra/console-api";
import {
  ActionButton,
  CellTitle,
  ConfirmModal,
  DataTable,
  EmptyState,
  Field,
  FieldStack,
  FormSheet,
  IconTile,
  Pill,
  Problem,
  SettingsCard,
  SettingsColumn,
  SettingsRow,
  SettingsSection,
  TextInput,
  type DataColumn,
} from "@/components/kit";
import { refusalSentence } from "../api/client";
import { dateWords } from "../people/fleet";
import { registrationDoor } from "../people/doors";

const readingOf = (raw: string): { kind: "email" | "domain"; subject: string } | undefined => {
  const subject = raw.trim().toLowerCase();
  if (subject === "") return undefined;
  if (subject.includes("@")) {
    const parts = subject.split("@");
    return parts.length === 2 && parts[0] !== "" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(parts[1] ?? "") ? { kind: "email", subject } : undefined;
  }
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(subject) ? { kind: "domain", subject } : undefined;
};

function Value({ children, mono = false, testId }: { children: React.ReactNode; mono?: boolean; testId?: string }) {
  return (
    <span data-testid={testId} className={mono ? "block truncate text-end font-mono text-13 text-g-muted max-md:text-start" : "block truncate text-end text-14 text-g-muted max-md:text-start"}>
      {children}
    </span>
  );
}

export function SignUps({ page: loaded }: { page: ConsoleRegistrationPage }) {
  const [page, setPage] = React.useState(loaded);
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<ConsoleAllowlistRow | undefined>(undefined);
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  React.useEffect(() => setPage(loaded), [loaded]);
  const may = page.mayManage;
  const inviteOnly = page.mode === "allowlist";

  const remove = async (row: ConsoleAllowlistRow) => {
    setBusy(row.id);
    try {
      setPage(await registrationDoor.remove(row.id));
      toast.success(`${row.subject} was removed from the list.`);
    } catch (error) {
      toastError(`${row.subject} was not removed`, refusalSentence(error));
    } finally {
      setBusy(undefined);
      setRemoving(undefined);
    }
  };
  const admit = async (org: { orgId: string; name: string }) => {
    setBusy(org.orgId);
    try {
      setPage(await registrationDoor.admit(org.orgId));
      toast.success(`${org.name} was admitted.`);
    } catch (error) {
      toastError(`${org.name} was not admitted`, refusalSentence(error));
    } finally {
      setBusy(undefined);
    }
  };

  const columns: DataColumn<ConsoleAllowlistRow>[] = [
    {
      id: "subject",
      header: "Address or domain",
      cell: (r) => <CellTitle icon={<IconTile icon={r.kind === "email" ? AtSignIcon : GlobeIcon} />} title={r.subject} sub={r.note} />,
    },
    { id: "kind", header: "Type", width: "120px", cell: (r) => <Pill tone="muted">{r.kind === "email" ? "Address" : "Domain"}</Pill> },
    { id: "by", header: "Added by", width: "26%", cell: (r) => <span className="block truncate">{r.addedBy}</span> },
    { id: "at", header: "Added", width: "130px", cell: (r) => <span className="whitespace-nowrap">{dateWords(r.addedAt)}</span> },
  ];

  return (
    <div data-testid="signups-page" className="flex flex-col">
      <SettingsColumn className="pb-6">
        <SettingsSection title="Sign-ups" description={may ? undefined : "Only an owner can change who may sign up."}>
          <SettingsCard>
            <SettingsRow
              title="Who can sign up"
              description={
                inviteOnly
                  ? "Only the addresses and domains on the list below can start an organisation. People can still join an organisation that has their domain, or accept an invitation. Set on the server."
                  : "Anyone can sign up and start an organisation. Set on the server."
              }
              control={{
                kind: "control",
                children: (
                  <span className="flex justify-end max-md:justify-start">
                    <Pill tone={inviteOnly ? "neutral" : "muted"} data-testid="signups-mode">
                      {inviteOnly ? "Invite only" : "Open"}
                    </Pill>
                  </span>
                ),
              }}
            />
            {page.operatorDomain === undefined ? null : (
              <SettingsRow
                title="Always allowed"
                description="Addresses on your own domain can always sign up, whatever the list says."
                control={{ kind: "control", children: <Value mono testId="signups-operator">{page.operatorDomain}</Value> }}
              />
            )}
            {page.contactEmail === undefined ? null : (
              <SettingsRow title="Contact" description="Shown to people who cannot sign up." control={{ kind: "control", children: <Value>{page.contactEmail}</Value> }} />
            )}
          </SettingsCard>
        </SettingsSection>

        <SettingsSection
          title="Allowed to sign up"
          description={inviteOnly ? "Each address, or anyone at each domain, can start an organisation." : "The list applies when sign-ups are invite only."}
          action={
            may ? (
              <ActionButton icon={PlusIcon} onClick={() => setAdding(true)} data-testid="allowlist-add-open">
                Add
              </ActionButton>
            ) : undefined
          }
        >
          <DataTable<ConsoleAllowlistRow>
            label="Allowed to sign up"
            rows={page.rows}
            rowKey={(r) => r.id}
            columns={columns}
            minWidth={640}
            {...(may
              ? {
                  rowMenu: (r: ConsoleAllowlistRow) => [{ label: "Remove from the list", icon: Trash2Icon, destructive: true, disabled: busy === r.id, onSelect: () => setRemoving(r) }],
                  menuLabel: (r: ConsoleAllowlistRow) => `Actions for ${r.subject}`,
                }
              : {})}
            empty={<EmptyState icon={AtSignIcon} title="Nobody is on the list" description={may ? "Add an address or a domain to let them start an organisation." : "An owner can add addresses and domains."} />}
          />
        </SettingsSection>

        {page.waitlist === undefined ? null : (
          <SettingsSection title="Waitlist" description="Free organisations waiting for the shared free hours. Admit one to let it in now.">
            <DataTable<{ orgId: string; name: string; createdAt: string }>
              label="Waitlist"
              rows={page.waitlist}
              rowKey={(o) => o.orgId}
              minWidth={560}
              columns={[
                { id: "name", header: "Organisation", cell: (o) => <CellTitle icon={<IconTile icon={UsersIcon} />} title={o.name} /> },
                { id: "since", header: "Signed up", width: "150px", cell: (o) => <span className="whitespace-nowrap">{dateWords(o.createdAt)}</span> },
                {
                  id: "admit",
                  header: <span className="sr-only">Admit</span>,
                  width: "120px",
                  align: "end",
                  cell: (o) =>
                    may ? (
                      <ActionButton static loading={busy === o.orgId} aria-label={`Admit ${o.name}`} onClick={() => void admit(o)}>
                        Admit
                      </ActionButton>
                    ) : null,
                },
              ]}
              empty={<EmptyState icon={UsersIcon} title="Nobody is waiting" description="Organisations that run out of free hours wait here." />}
            />
          </SettingsSection>
        )}
      </SettingsColumn>

      <AddSheet open={adding} onClose={() => setAdding(false)} onAdded={(next) => setPage(next)} />
      <ConfirmModal
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={removing === undefined ? "" : `Remove ${removing.subject} from the list?`}
        confirmLabel="Remove"
        busy={removing !== undefined && busy === removing.id}
        onConfirm={() => removing !== undefined && void remove(removing)}
      >
        {removing?.kind === "domain"
          ? "New sign-ups from this domain are refused. Anyone who already signed up keeps their organisation."
          : "New sign-ups from this address are refused. If they already signed up, they keep their organisation."}
      </ConfirmModal>
    </div>
  );
}

function AddSheet({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: (page: ConsoleRegistrationPage) => void }) {
  const [subject, setSubject] = React.useState("");
  const [note, setNote] = React.useState("");
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [refusal, setRefusal] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) return;
    setSubject("");
    setNote("");
    setProblem(undefined);
    setRefusal(undefined);
  }, [open]);
  const reading = readingOf(subject);
  const hint =
    reading === undefined
      ? "An email address lets that one person sign up. A domain, like partner.example, lets anyone with an address there sign up."
      : reading.kind === "email"
        ? `Only ${reading.subject} can sign up.`
        : `Anyone with an address at ${reading.subject} can sign up. Subdomains are not included.`;
  const submit = async () => {
    if (busy) return;
    if (subject.trim() === "") {
      setProblem("Enter an email address or a domain.");
      document.getElementById("allow-subject")?.focus();
      return;
    }
    setBusy(true);
    setRefusal(undefined);
    try {
      const next = await registrationDoor.add(subject.trim(), note.trim());
      onAdded(next);
      toast.success(`${subject.trim().toLowerCase()} can sign up now.`);
      onClose();
    } catch (error) {
      setRefusal(refusalSentence(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <FormSheet open={open} onClose={onClose} title="Allow sign-ups" description="Let an address, or everyone at a domain, start an organisation." primaryLabel="Add to the list" onPrimary={() => void submit()} busy={busy}>
      <FieldStack data-testid="allowlist-add" className="gap-6">
        <Field label="Email address or domain" htmlFor="allow-subject" hint={problem === undefined ? hint : undefined} error={problem}>
          <TextInput
            id="allow-subject"
            autoComplete="off"
            spellCheck={false}
            maxLength={254}
            placeholder="lee@partner.example or partner.example"
            value={subject}
            aria-invalid={problem === undefined ? undefined : true}
            aria-describedby={problem === undefined ? "allow-subject-hint" : "allow-subject-error"}
            onChange={(event) => {
              setSubject(event.target.value);
              setProblem(undefined);
              setRefusal(undefined);
            }}
          />
        </Field>
        <Field label="Note (optional)" htmlFor="allow-note" hint="Why they are on the list. Only owners and admins see it.">
          <TextInput id="allow-note" maxLength={200} value={note} aria-describedby="allow-note-hint" onChange={(event) => setNote(event.target.value)} />
        </Field>
        {refusal === undefined ? null : <Problem>{refusal}</Problem>}
      </FieldStack>
    </FormSheet>
  );
}
