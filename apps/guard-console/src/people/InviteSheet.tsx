import * as React from "react";
import { MailIcon, ShieldIcon, UserIcon } from "lucide-react";
import type { ConsoleInvitationCreated, ConsoleInviteRole } from "@vibtra/console-api";
import { Field, FieldStack, FormSheet, Problem, RadioCards, TextInput } from "@/components/kit";
import { refusalSentence } from "../api/client";
import { peopleDoor } from "./doors";
import { SentResult, deliveryWords } from "./delivery";

const emailProblem = (value: string): string | undefined => {
  const v = value.trim();
  if (v === "") return "Enter the email address to invite.";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? undefined : "Enter one email address, like lee@example.com.";
};

export function InviteSheet({ open, mailEnabled, orgName, onClose, onInvited }: { open: boolean; mailEnabled: boolean; orgName: string; onClose: () => void; onInvited: () => void }) {
  const [email, setEmail] = React.useState("");
  const [role, setRole] = React.useState<ConsoleInviteRole>("member");
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [refusal, setRefusal] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const [made, setMade] = React.useState<ConsoleInvitationCreated | undefined>(undefined);
  const reset = React.useCallback(() => {
    setEmail("");
    setRole("member");
    setProblem(undefined);
    setRefusal(undefined);
    setMade(undefined);
  }, []);
  React.useEffect(() => {
    if (!open) reset();
  }, [open, reset]);

  const submit = async () => {
    if (busy) return;
    const wrong = emailProblem(email);
    if (wrong !== undefined) {
      setProblem(wrong);
      document.getElementById("invite-email")?.focus();
      return;
    }
    setBusy(true);
    setRefusal(undefined);
    try {
      setMade(await peopleDoor.invite(email.trim(), role));
      onInvited();
    } catch (error) {
      setRefusal(`${email.trim()} was not invited. ${refusalSentence(error)}`);
    } finally {
      setBusy(false);
    }
  };

  if (made !== undefined) {
    const said = deliveryWords(made.delivery, { kind: "invitation", email: made.email, role: made.role, orgName, again: false });
    return (
      <FormSheet open={open} onClose={onClose} title={said.title} description={said.description} primaryLabel="Done" onPrimary={onClose} back={{ label: "Invite someone else", onClick: reset }}>
        <FieldStack data-testid="invite-made" data-delivery={made.delivery} className="gap-6">
          <SentResult delivery={made.delivery} email={made.email} label="Invitation link" link={made.inviteUrl} expiresAt={made.expiresAt} />
        </FieldStack>
      </FormSheet>
    );
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Invite people"
      description={mailEnabled ? "We email them a link. They join when they sign in with that address." : "You get a link to send them. They join when they sign in with that address."}
      primaryLabel={mailEnabled ? "Send invitation" : "Create invitation"}
      onPrimary={() => void submit()}
      busy={busy}
    >
      <FieldStack data-testid="invite-form" className="gap-6">
        <Field label="Email" htmlFor="invite-email" error={problem}>
          <TextInput
            id="invite-email"
            type="email"
            inputMode="email"
            autoComplete="off"
            spellCheck={false}
            maxLength={254}
            placeholder="lee@example.com"
            value={email}
            aria-invalid={problem === undefined ? undefined : true}
            {...(problem === undefined ? {} : { "aria-describedby": "invite-email-error" })}
            onChange={(event) => {
              setEmail(event.target.value);
              setProblem(undefined);
              setRefusal(undefined);
            }}
          />
        </Field>
        <RadioCards<ConsoleInviteRole>
          name="invite-role"
          label="Role"
          value={role}
          onValueChange={setRole}
          options={[
            { value: "member", title: "Member", description: "Cannot change rules, laptops, people or settings.", icon: UserIcon },
            { value: "admin", title: "Admin", description: "Manages rules, laptops, people and settings.", icon: ShieldIcon },
          ]}
        />
        <p className="flex gap-2 text-13 text-g-muted">
          <MailIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          To make someone an owner, invite them first, then change their role.
        </p>
        {refusal === undefined ? null : <Problem>{refusal}</Problem>}
      </FieldStack>
    </FormSheet>
  );
}
