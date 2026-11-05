import * as React from "react";
import { BanIcon, CheckCircle2Icon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsolePolicyRequestRow } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { refusalWords } from "../api/client";
import { DETECTOR_WORD, absoluteWords } from "../guard/words";
import { ServiceMark } from "../brand/BrandMark";
import { Field, FieldStack, FormSheet, Pill, RadioCards, SelectInput, SheetDefinitions, TextInput, type SelectOption } from "@/components/kit";
import type { PersonFacts } from "@/components/patterns/PersonCell";
import { PersonTitle } from "../people/fleet";
import { GUARD_TIMEBOXES, ageOf, statusOf, subjectOf } from "./words";

type Decision = "approve" | "decline";
type BoxValue = (typeof GUARD_TIMEBOXES)[number]["value"];

const BOX_OPTIONS: SelectOption<BoxValue>[] = GUARD_TIMEBOXES.map((t) => ({ value: t.value, label: t.label }));
const SCOPE_OPTIONS: SelectOption<"user" | "org">[] = [
  { value: "user", label: "This person" },
  { value: "org", label: "Everyone" },
];

export function DecideSheet({
  open,
  request,
  person,
  onClose,
  onDone,
}: {
  open: boolean;
  request: ConsolePolicyRequestRow;
  person: PersonFacts | undefined;
  onClose: () => void;
  onDone: (status: "approved" | "declined") => void;
}) {
  const [decision, setDecision] = React.useState<Decision>("approve");
  const [boxValue, setBoxValue] = React.useState<BoxValue>("7");
  const [scope, setScope] = React.useState<"user" | "org">("user");
  const [note, setNote] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [needReason, setNeedReason] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const reasonRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    if (needReason) reasonRef.current?.closest("[data-slot=field]")?.scrollIntoView?.({ block: "nearest" });
  }, [needReason]);
  const box = GUARD_TIMEBOXES.find((t) => t.value === boxValue) ?? GUARD_TIMEBOXES[2];
  const pending = request.status === "pending";
  const s = subjectOf(request.subject);
  const status = statusOf(request.status);

  const submit = async () => {
    if (busy) return;
    if (decision === "decline" && reason.trim() === "") {
      setNeedReason(true);
      reasonRef.current?.focus({ preventScroll: true });
      return;
    }
    setBusy(true);
    try {
      if (decision === "approve") {
        const trimmed = note.trim();
        const grant = { ...("hours" in box ? { hours: box.hours } : { days: box.days }), ...(scope === "org" ? { scope } : {}) };
        await guard.approve(request.id, { grant, ...(trimmed ? { note: trimmed } : {}) });
        toast.success("Approved");
        onDone("approved");
      } else {
        await guard.decline(request.id, reason.trim());
        toast.success("Declined");
        onDone("declined");
      }
    } catch (error) {
      const who = person?.name ?? person?.email ?? "This person";
      toastError(decision === "approve" ? `${who}’s request was not approved` : `${who}’s request was not declined`, refusalWords(error));
    } finally {
      setBusy(false);
    }
  };

  const facts: { label: string; value: React.ReactNode }[] = [
    { label: "Person", value: <PersonTitle email={person?.email ?? request.requesterUserId} name={person?.name} image={person?.image} /> },
    ...(pending ? [] : [{ label: "Status", value: <Pill tone={status.tone}>{status.label}</Pill> }]),
    { label: "Asked for", value: request.words },
    ...(s === undefined
      ? []
      : [
          {
            label: "AI service",
            value: (
              <span className="flex items-center gap-2">
                <ServiceMark serviceId={s.serviceId} size="xs" />
                {s.serviceName ?? s.serviceId}
              </span>
            ),
          },
          ...(s.ruleName === undefined && s.ruleId === undefined ? [] : [{ label: "Rule", value: s.ruleName ?? s.ruleId }]),
          ...(s.matchType === undefined ? [] : [{ label: "Matched", value: DETECTOR_WORD[s.matchType] }]),
          { label: "Device", value: s.app === undefined ? (s.hostname ?? s.deviceId) : `${s.hostname ?? s.deviceId} · ${s.app}` },
        ]),
    { label: "Asked", value: `${ageOf(request, Date.now())} · ${absoluteWords(request.createdAt)}` },
    ...(request.decidedAt === undefined ? [] : [{ label: "Decided", value: absoluteWords(request.decidedAt) }]),
    ...(request.decisionNote === undefined ? [] : [{ label: "Note", value: request.decisionNote }]),
  ];

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={pending ? "Review request" : "Request"}
      description={pending ? "Approve it for a while, or decline it with a reason." : undefined}
      {...(pending
        ? {
            primaryLabel: decision === "approve" ? `Approve for ${box.label}` : "Decline request",
            primaryVariant: decision === "approve" ? ("primary" as const) : ("danger" as const),
            onPrimary: () => void submit(),
          }
        : {})}
      busy={busy}
    >
      <div data-testid="decide-sheet" className="flex flex-col gap-6">
        <SheetDefinitions rows={facts} />
        {pending ? (
          <FieldStack className="gap-6">
            <RadioCards<Decision>
              name="decision"
              label="Decision"
              value={decision}
              onValueChange={setDecision}
              options={[
                { value: "approve", title: "Approve", description: "Lets them past this rule on their laptops for a set time. Their laptop picks it up within a minute.", icon: CheckCircle2Icon },
                { value: "decline", title: "Decline", description: "The rule stays. They see your reason on the block page.", icon: BanIcon },
              ]}
            />
            {decision === "approve" ? (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="For" htmlFor="approve-duration">
                    <SelectInput<BoxValue> id="approve-duration" value={boxValue} onValueChange={setBoxValue} options={BOX_OPTIONS} />
                  </Field>
                  <Field label="Who" htmlFor="approve-scope">
                    <SelectInput<"user" | "org"> id="approve-scope" value={scope} onValueChange={setScope} options={SCOPE_OPTIONS} />
                  </Field>
                </div>
                <Field label="Note" htmlFor="approve-note" hint="Optional. It travels with the answer.">
                  <TextInput id="approve-note" aria-describedby="approve-note-hint" maxLength={280} value={note} onChange={(event) => setNote(event.target.value)} />
                </Field>
                <p className="text-12 text-g-muted">To allow it for everyone for good, change the rule instead. Revoke an approval from Grants.</p>
              </>
            ) : (
              <Field
                label="Reason"
                htmlFor="decline-note"
                hint={needReason ? undefined : "Required. Up to 280 characters."}
                error={needReason ? "Say why you are declining. They read it on the block page." : undefined}
              >
                <TextInput
                  id="decline-note"
                  ref={reasonRef}
                  aria-invalid={needReason ? true : undefined}
                  aria-describedby={needReason ? "decline-note-error" : "decline-note-hint"}
                  placeholder="Use the company workspace for client work"
                  maxLength={280}
                  value={reason}
                  onChange={(event) => {
                    setReason(event.target.value);
                    setNeedReason(false);
                  }}
                />
              </Field>
            )}
          </FieldStack>
        ) : null}
      </div>
    </FormSheet>
  );
}
