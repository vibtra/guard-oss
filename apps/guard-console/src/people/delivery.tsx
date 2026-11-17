import * as React from "react";
import { CheckIcon, CopyIcon, MailCheckIcon } from "lucide-react";
import type { InviteDelivery, OnboardingInviteRow } from "@vibtra/console-api";
import { ActionButton, Field, TextInput } from "@/components/kit";
import { absoluteWords } from "../guard/words";

export type Sent =
  | { kind: "invitation"; email: string; role: OnboardingInviteRow["role"]; orgName: string; again: boolean }
  | { kind: "reminder"; email: string };

const roleWords = (role: OnboardingInviteRow["role"]): string => (role === "member" ? "a member" : role === "owner" ? "an owner" : "an admin");

const joinWords = (sent: Sent): string =>
  sent.kind === "invitation" ? ` They join ${sent.orgName} as ${roleWords(sent.role)} when they sign in with that address.` : "";

export const deliveryWords = (delivery: InviteDelivery, sent: Sent): { title: string; description: string } => {
  const what = sent.kind === "invitation" ? (sent.again ? "the invitation again" : "an invitation") : "the download and enrol links again";
  switch (delivery) {
    case "emailed":
      return { title: sent.kind === "invitation" ? (sent.again ? "Invitation sent again" : "Invitation sent") : "Reminder sent", description: `We emailed ${sent.email} ${what}.${joinWords(sent)}` };
    case "mail_off":
      return { title: "Send this link yourself", description: `Email is not set up on this server, so nothing was sent. Send ${sent.email} this link.${joinWords(sent)}` };
    case "send_failed":
      return { title: "The email was not sent", description: `The email could not be sent. Send ${sent.email} this link instead.${joinWords(sent)}` };
    default: {
      const unreachable: never = delivery;
      return unreachable;
    }
  }
};

export function SentLink({ label, link, expiresAt }: { label: string; link: string; expiresAt?: string | undefined }) {
  const [copied, setCopied] = React.useState(false);
  const id = `sent-link-${React.useId().replace(/:/g, "")}`;
  return (
    <>
      <Field label={label} htmlFor={id} hint={expiresAt === undefined ? "Anyone with this link can use it. Send it only to them." : `Anyone with this link can use it until ${absoluteWords(expiresAt)}. Send it only to them.`}>
        <div className="flex gap-2 max-md:flex-col">
          <TextInput id={id} readOnly value={link} aria-describedby={`${id}-hint`} className="font-mono text-13" onFocus={(event) => event.currentTarget.select()} />
          <ActionButton
            static
            icon={copied ? CheckIcon : CopyIcon}
            className="shrink-0"
            onClick={() => {
              void navigator.clipboard
                ?.writeText(link)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => document.getElementById(id)?.focus());
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </ActionButton>
        </div>
      </Field>
      <span className="sr-only" role="status">
        {copied ? "Link copied" : ""}
      </span>
    </>
  );
}

export function SentResult({ delivery, email, label, link, expiresAt }: { delivery: InviteDelivery; email: string; label: string; link: string | undefined; expiresAt?: string | undefined }) {
  if (link !== undefined) return <SentLink label={label} link={link} expiresAt={expiresAt} />;
  return (
    <p className="flex gap-2 text-14 text-g-ink">
      <MailCheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-g-muted" />
      {delivery === "emailed" ? `It is on its way to ${email}.` : `Nothing was emailed to ${email}.`}
    </p>
  );
}
