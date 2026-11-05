import { ServiceMark } from "../brand/BrandMark";
import * as React from "react";
import { BanIcon, CircleCheckIcon, CircleDashedIcon, CircleOffIcon, EyeIcon, MessageCircleQuestionIcon, PlusIcon, Trash2Icon, type LucideIcon } from "lucide-react";
import {
  GUARD_DETECTOR_KINDS,
  GUARD_SECRET_RULE_IDS,
  type GuardAudience,
  type GuardContentAction,
  type GuardDetector,
  type GuardDetectorKind,
  type GuardFlowAction,
  type GuardRulesPage,
  type GuardSecretRuleId,
} from "@vibtra/guard-contract";
import {
  ActionButton,
  Checkbox,
  Field,
  FieldStack,
  FormSheet,
  Pill,
  Problem,
  RadioCards,
  SelectInput,
  SheetSection,
  TextAreaInput,
  TextInput,
  Toggle,
  cn,
  type PillTone,
  type SelectOption,
} from "@/components/kit";
import { DETECTOR_WORD } from "../guard/words";
import {
  emailLooksRight,
  emailsOf,
  newKey,
  rulesOfServiceSheet,
  statusOf,
  type DraftContentRule,
  type DraftServiceRule,
  type ExceptionDraft,
  type ServiceSheetDraft,
  type ServiceStatus,
} from "./draft";

type Groups = GuardRulesPage["groups"];
type Services = GuardRulesPage["services"];

export const STATUS: Record<ServiceStatus, { label: string; icon: LucideIcon; iconClass: string; tone: PillTone }> = {
  block: { label: "Block", icon: BanIcon, iconClass: "text-g-danger", tone: "bad" },
  ask: { label: "Ask IT", icon: MessageCircleQuestionIcon, iconClass: "text-g-muted", tone: "neutral" },
  allow: { label: "Allow", icon: CircleCheckIcon, iconClass: "text-g-dot-ok", tone: "ok" },
  off: { label: "Off", icon: CircleOffIcon, iconClass: "text-g-muted", tone: "muted" },
};

export const CONTENT_STATUS: Record<GuardContentAction | "off", { label: string; icon: LucideIcon; iconClass: string; tone: PillTone }> = {
  block: STATUS.block,
  ask: STATUS.ask,
  allow: { label: "Record only", icon: EyeIcon, iconClass: "text-g-muted", tone: "neutral" },
  off: STATUS.off,
};

export function StatusPill({ status, label, className }: { status: ServiceStatus | "default"; label?: string; className?: string }) {
  if (status === "default")
    return (
      <Pill tone="muted" data-testid="rule-status" data-status="default" className={className}>
        {label ?? "Default"}
      </Pill>
    );
  return (
    <Pill tone={STATUS[status].tone} data-testid="rule-status" data-status={status} className={className}>
      {label ?? STATUS[status].label}
    </Pill>
  );
}

export function ServiceTile({ serviceId, size = 32 }: { serviceId: string; size?: 32 | 40 }) {
  return (
    <ServiceMark
      serviceId={serviceId === "*" ? undefined : serviceId}
      size={size === 40 ? "lg" : "md"}
      className="rounded-g-control border border-g-line bg-g-surface"
    />
  );
}

export function TextArea({ className, mono = false, ...props }: React.ComponentProps<"textarea"> & { mono?: boolean }) {
  return <TextAreaInput className={cn(mono && "font-mono text-13 max-md:text-16", className)} {...props} />;
}

function ToggleLine({ label, checked, onCheckedChange, children, testId }: { label: string; checked: boolean; onCheckedChange: (on: boolean) => void; children?: React.ReactNode; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-14 text-g-ink" data-testid={testId}>
      <Toggle aria-label={label} checked={checked} onCheckedChange={onCheckedChange} />
      {children ?? label}
    </label>
  );
}

function FieldError({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} role="alert" data-slot="field-error" className="g-rise text-12 text-g-danger">
      {children}
    </p>
  );
}

export interface AudienceState {
  kind: GuardAudience["kind"];
  groupIds: string[];
  emails: string;
}

export const audienceStateOf = (audience: GuardAudience): AudienceState => ({
  kind: audience.kind,
  groupIds: audience.kind === "groups" ? [...audience.groupIds] : [],
  emails: audience.kind === "people" ? audience.emails.join("\n") : "",
});

export const audienceOf = (state: AudienceState): GuardAudience | string => {
  if (state.kind === "org") return { kind: "org" };
  if (state.kind === "groups") return state.groupIds.length === 0 ? "Pick at least one group." : { kind: "groups", groupIds: state.groupIds };
  const emails = emailsOf(state.emails);
  if (emails.length === 0) return "Name at least one person by email address.";
  const wrong = emails.filter((e) => !emailLooksRight(e));
  return wrong.length > 0 ? `Not an email address: ${wrong.join(", ")}` : { kind: "people", emails };
};

export const focusAudience = (id: string, state: AudienceState) => {
  const target =
    state.kind === "groups"
      ? document.querySelector<HTMLElement>(`#${id}-groups [role="checkbox"], #${id}-groups button`)
      : state.kind === "people"
        ? document.getElementById(`${id}-emails`)
        : null;
  (target ?? document.getElementById(`${id}-kind`))?.focus();
};

const NO_GROUPS = "This organisation has no groups yet. Make them on the People page.";

const AUDIENCE_OPTIONS: SelectOption<AudienceState["kind"]>[] = [
  { value: "org", label: "Everyone in the organisation" },
  { value: "groups", label: "Groups" },
  { value: "people", label: "People" },
];

export function AudiencePicker({
  id,
  state,
  onChange,
  groups,
  error,
}: {
  id: string;
  state: AudienceState;
  onChange: (next: AudienceState) => void;
  groups: Groups;
  error?: string;
}) {
  const invalid = error === undefined ? {} : { "aria-invalid": true as const, "aria-describedby": `${id}-kind-error` };
  return (
    <Field label="Who" htmlFor={`${id}-kind`} error={error}>
      <div className="flex flex-col gap-2" data-testid="audience-picker">
        <SelectInput<AudienceState["kind"]>
          id={`${id}-kind`}
          {...(state.kind === "org" ? invalid : {})}
          value={state.kind}
          onValueChange={(kind) => onChange({ ...state, kind })}
          options={AUDIENCE_OPTIONS}
        />
        {state.kind === "groups" ? (
          groups.length === 0 ? (
            <p className="text-12 text-g-muted">{NO_GROUPS}</p>
          ) : (
            <ul id={`${id}-groups`} className="flex max-h-40 flex-col overflow-y-auto overscroll-contain rounded-g-control border border-g-line p-1" aria-label="Groups">
              {groups.map((g) => {
                const on = state.groupIds.includes(g.id);
                return (
                  <li key={g.id}>
                    <label className="flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-2 text-14 text-g-ink transition-[background-color] duration-(--g-dur-fast) hover:bg-g-hover">
                      <Checkbox
                        {...invalid}
                        checked={on}
                        onCheckedChange={(next) => onChange({ ...state, groupIds: next ? [...state.groupIds, g.id] : state.groupIds.filter((x) => x !== g.id) })}
                      />
                      {g.name}
                    </label>
                  </li>
                );
              })}
            </ul>
          )
        ) : null}
        {state.kind === "people" ? (
          <TextArea
            id={`${id}-emails`}
            aria-label="People’s email addresses"
            {...invalid}
            mono
            rows={3}
            placeholder={"ada@example.com\ngrace@example.com"}
            value={state.emails}
            onChange={(event) => onChange({ ...state, emails: event.target.value })}
          />
        ) : null}
      </div>
    </Field>
  );
}

const EVERY_SERVICE = "Every AI service";
const serviceNameOf = (services: Services, id: string): string => (id === "*" ? EVERY_SERVICE : (services.find((s) => s.serviceId === id)?.name ?? id));

const statusOption = (status: ServiceStatus, label?: string): SelectOption<ServiceStatus> => ({
  value: status,
  label: label ?? STATUS[status].label,
  icon: STATUS[status].icon,
  iconClassName: STATUS[status].iconClass,
});

const statusOptions = (withOff: boolean): SelectOption<ServiceStatus>[] => [
  statusOption("block"),
  statusOption("ask"),
  statusOption("allow"),
  ...(withOff ? [{ ...statusOption("off", "Off (kept, not applied)"), separatorBefore: true }] : []),
];

const setStatus = <T extends { action: GuardFlowAction; enabled: boolean }>(row: T, status: ServiceStatus): T =>
  status === "off" ? { ...row, enabled: false } : { ...row, action: status, enabled: true };

export function ServiceRuleSheet({
  open,
  sheet: loaded,
  services,
  choices,
  groups,
  defaultAction,
  onSave,
  onClose,
  busy = false,
  error,
  children,
}: {
  open: boolean;
  sheet: ServiceSheetDraft | undefined;
  services: Services;
  choices: string[];
  groups: Groups;
  defaultAction: GuardFlowAction;
  onSave: (serviceId: string, rules: DraftServiceRule[]) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  children?: React.ReactNode;
}) {
  const fresh = (): ServiceSheetDraft =>
    loaded ?? { serviceId: choices[0] ?? "*", base: { key: newKey("gsr"), action: "block", enabled: true }, exceptions: [], note: "" };
  const [sheet, setSheet] = React.useState<ServiceSheetDraft>(fresh);
  const [initial] = React.useState(() => JSON.stringify(fresh()));
  const [initialNote] = React.useState(() => fresh().note);
  const [problem, setProblem] = React.useState<{ text: string; index: number } | undefined>(undefined);
  const isNew = loaded === undefined;
  const baseStatus: ServiceStatus | "default" = sheet.base === undefined ? "default" : statusOf(sheet.base);
  const update = (next: ServiceSheetDraft) => {
    setSheet(next);
    setProblem(undefined);
  };
  const patchException = (index: number, patch: Partial<ExceptionDraft>) => update({ ...sheet, exceptions: sheet.exceptions.map((x, i) => (i === index ? { ...x, ...patch } : x)) });

  const save = () => {
    if (!isNew && JSON.stringify(sheet) === initial) return onClose();
    const result = rulesOfServiceSheet(sheet, sheet.note !== initialNote);
    if ("problem" in result) {
      setProblem({ text: result.problem, index: result.index });
      const x = sheet.exceptions[result.index];
      document.getElementById(x?.who === "people" ? `exception-${result.index}-emails` : `exception-${result.index}-who`)?.focus();
      return;
    }
    if (result.rules.length === 0 && isNew) {
      setProblem({ text: "Set a status for everyone or add an exception.", index: -1 });
      document.getElementById("srule-status")?.focus();
      return;
    }
    onSave(sheet.serviceId, result.rules);
  };

  const title = isNew ? "Add a service rule" : serviceNameOf(services, sheet.serviceId);
  const invalidAt = (index: number) => (problem !== undefined && problem.index === index ? { "aria-invalid": true as const, "aria-describedby": `exception-${index}-error` } : {});
  const baseOptions: SelectOption<ServiceStatus | "default">[] = [
    { value: "default", label: `No rule (the default: ${STATUS[defaultAction].label})`, icon: CircleDashedIcon, iconClassName: "text-g-subtle" },
    { ...statusOption("block"), separatorBefore: true },
    statusOption("ask"),
    statusOption("allow"),
    ...(sheet.base === undefined ? [] : [{ ...statusOption("off", "Off (kept, not applied)"), separatorBefore: true }]),
  ];
  const serviceOptions: SelectOption<string>[] = choices.map((id) => ({ value: id, label: serviceNameOf(services, id) }));
  const whoOptions = (who: string): SelectOption<string>[] => [
    ...(who === "org" ? [{ value: "org", label: "Everyone" }] : []),
    ...groups.map((g) => ({ value: `group:${g.id}`, label: g.name })),
    ...(who.startsWith("group:") && !groups.some((g) => `group:${g.id}` === who) ? [{ value: who, label: who.slice(6) }] : []),
    { value: "people", label: "Named people", separatorBefore: groups.length > 0 || who === "org" },
  ];
  const baseProblem = problem !== undefined && problem.index === -1 ? problem.text : undefined;

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={title}
      description={sheet.serviceId === "*" ? "A rule for every AI service. A rule that names a service beats it." : "What the laptop does when someone reaches this service."}
      primaryLabel={isNew ? "Add rule" : "Save"}
      onPrimary={save}
      busy={busy}
    >
      <FieldStack className="gap-8" data-testid="service-rule-sheet">
        {isNew ? (
          <Field label="Service" htmlFor="srule-service">
            <span className="flex items-center gap-2">
              <ServiceTile serviceId={sheet.serviceId} />
              <SelectInput<string> id="srule-service" wrapperClassName="min-w-0 flex-1" value={sheet.serviceId} onValueChange={(serviceId) => update({ ...sheet, serviceId })} options={serviceOptions} />
            </span>
          </Field>
        ) : null}

        <SheetSection title="Status" description="For everyone, unless an exception below names them.">
          <SelectInput<ServiceStatus | "default">
            id="srule-status"
            aria-label="Status for everyone"
            {...(baseProblem === undefined ? {} : { "aria-invalid": true, "aria-describedby": "srule-status-error" })}
            value={baseStatus}
            options={baseOptions}
            onValueChange={(value) => {
              if (value === "default") {
                const { base: _drop, ...rest } = sheet;
                update(rest);
              } else update({ ...sheet, base: setStatus(sheet.base ?? { key: newKey("gsr"), action: "block", enabled: true }, value) });
            }}
          />
          {baseProblem === undefined ? null : <FieldError id="srule-status-error">{baseProblem}</FieldError>}
        </SheetSection>

        <SheetSection title="Exceptions" description="A different status for a group or for named people. A person named directly beats their groups." testId="service-exceptions">
          {groups.length === 0 ? <p className="text-12 text-g-muted">{NO_GROUPS}</p> : null}
          {sheet.exceptions.length === 0 ? null : (
            <ul className="flex flex-col gap-2" aria-label="Exceptions">
              {sheet.exceptions.map((x, index) => {
                const status = statusOf(x);
                const n = index + 1;
                return (
                  <li key={x.key} data-testid="exception-row" className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                      <SelectInput<string>
                        id={`exception-${index}-who`}
                        aria-label={`Exception ${n}: who`}
                        {...(x.who === "people" ? {} : invalidAt(index))}
                        wrapperClassName="min-w-0 flex-1"
                        placeholder="Pick a group"
                        value={x.who}
                        options={whoOptions(x.who)}
                        onValueChange={(who) => patchException(index, { who })}
                      />
                      <SelectInput<ServiceStatus>
                        aria-label={`Exception ${n}: status`}
                        wrapperClassName="w-40 shrink-0 max-md:w-32"
                        value={status}
                        options={statusOptions(true)}
                        onValueChange={(next) => patchException(index, setStatus(x, next))}
                      />
                      <button
                        type="button"
                        aria-label={`Remove exception ${n}`}
                        onClick={() => update({ ...sheet, exceptions: sheet.exceptions.filter((_, i) => i !== index) })}
                        className="focus-knox inline-flex size-8 shrink-0 items-center justify-center rounded-g-control text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur-fast) hover:bg-g-tint hover:text-g-ink"
                      >
                        <Trash2Icon aria-hidden className="size-4" />
                      </button>
                    </div>
                    {x.who === "people" ? (
                      <TextArea
                        id={`exception-${index}-emails`}
                        aria-label={`Exception ${n}: email addresses`}
                        {...invalidAt(index)}
                        mono
                        rows={2}
                        placeholder={"ada@example.com\ngrace@example.com"}
                        value={x.emails}
                        onChange={(event) => patchException(index, { emails: event.target.value })}
                      />
                    ) : null}
                    {problem !== undefined && problem.index === index ? <FieldError id={`exception-${index}-error`}>{problem.text}</FieldError> : null}
                  </li>
                );
              })}
            </ul>
          )}
          <ActionButton
            icon={PlusIcon}
            className="self-start"
            onClick={() => update({ ...sheet, exceptions: [...sheet.exceptions, { key: newKey("gsr"), who: groups.length === 0 ? "people" : "", emails: "", action: "allow", enabled: true }] })}
          >
            Add
          </ActionButton>
        </SheetSection>

        <Field label="Why (shown on the block page)" htmlFor="srule-note" hint="Optional.">
          <TextInput
            id="srule-note"
            aria-describedby="srule-note-hint"
            maxLength={200}
            placeholder="Use the company workspace for client work"
            value={sheet.note}
            onChange={(event) => update({ ...sheet, note: event.target.value })}
          />
        </Field>

        {error === undefined ? null : <Problem id="srule-error">{error}</Problem>}
        {children}
      </FieldStack>
    </FormSheet>
  );
}

export function DefaultActionSheet({
  open,
  value,
  onSave,
  onClose,
  busy = false,
  error,
}: {
  open: boolean;
  value: GuardFlowAction;
  onSave: (value: GuardFlowAction) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
}) {
  const [choice, setChoice] = React.useState(value);
  return (
    <FormSheet
      open={open}
      onClose={onClose}
      size="sm"
      title="When no rule names a service"
      description="Applies to every AI service without a rule here or a default of its own on the AI services page."
      primaryLabel="Save"
      onPrimary={() => (choice === value ? onClose() : onSave(choice))}
      busy={busy}
    >
      <div className="flex flex-col gap-4" data-testid="default-action-sheet">
        <RadioCards
          name="default-action"
          label="Default action"
          value={choice}
          onValueChange={setChoice}
          options={[
            { value: "allow", title: "Allow", description: "Let it through and record it.", icon: CircleCheckIcon },
            { value: "ask", title: "Ask IT", description: "Hold it until IT says yes.", icon: MessageCircleQuestionIcon },
            { value: "block", title: "Block", description: "Stop it. People can ask for access if requests are on.", icon: BanIcon },
          ]}
        />
        {error === undefined ? null : <Problem id="default-error">{error}</Problem>}
      </div>
    </FormSheet>
  );
}

interface DetectorState {
  kind: GuardDetectorKind;
  secretRules: string[];
  threshold: string;
  keywords: string;
  wholeWord: boolean;
  extensions: string;
  requireContext: boolean;
}

const detectorStateOf = (detector: GuardDetector | undefined): DetectorState => ({
  kind: detector?.kind ?? "keyword",
  secretRules: detector?.kind === "secret" ? [...(detector.rules ?? [])] : [],
  threshold: detector?.kind === "email-bulk" || detector?.kind === "phone-bulk" ? String(detector.threshold) : "10",
  keywords: detector?.kind === "keyword" ? detector.keywords.join("\n") : "",
  wholeWord: detector?.kind === "keyword" ? detector.wholeWord : false,
  extensions: detector?.kind === "file-type" ? detector.extensions.join(", ") : "",
  requireContext: detector?.kind === "au-tfn" || detector?.kind === "au-acn" || detector?.kind === "au-medicare" ? (detector.requireContext ?? false) : true,
});

const detectorOf = (state: DetectorState): GuardDetector | string => {
  switch (state.kind) {
    case "secret":
      return state.secretRules.length === 0 ? { kind: "secret" } : { kind: "secret", rules: state.secretRules as GuardSecretRuleId[] };
    case "email-bulk":
    case "phone-bulk": {
      const threshold = Number(state.threshold);
      return Number.isInteger(threshold) && threshold >= 2 && threshold <= 10_000 ? { kind: state.kind, threshold } : "The threshold is a whole number from 2 to 10,000.";
    }
    case "keyword": {
      const keywords = [...new Set(state.keywords.split("\n").map((k) => k.trim()).filter((k) => k !== ""))];
      if (keywords.length === 0) return "Add at least one keyword, one per line.";
      if (keywords.some((k) => k.length > 100)) return "A keyword is at most 100 characters.";
      return { kind: "keyword", keywords, wholeWord: state.wholeWord };
    }
    case "file-type": {
      const extensions = [...new Set(state.extensions.split(/[\s,]+/).map((e) => e.trim().replace(/^\./, "").toLowerCase()).filter((e) => e !== ""))];
      if (extensions.length === 0) return "Add at least one file extension (xlsx, csv, pdf).";
      const wrong = extensions.filter((e) => !/^[a-z0-9]{1,12}$/.test(e));
      return wrong.length > 0 ? `Not a file extension: ${wrong.join(", ")}` : { kind: "file-type", extensions };
    }
    case "au-tfn":
    case "au-acn":
    case "au-medicare":
      return { kind: state.kind, ...(state.requireContext ? { requireContext: true } : {}) };
    default:
      return { kind: state.kind };
  }
};

const DETECTOR_OPTIONS: SelectOption<GuardDetectorKind>[] = GUARD_DETECTOR_KINDS.map((k) => ({ value: k, label: DETECTOR_WORD[k] }));

const ACTION_OPTIONS: SelectOption<GuardContentAction>[] = (["block", "ask", "allow"] as const).map((value) => ({
  value,
  label: CONTENT_STATUS[value].label,
  icon: CONTENT_STATUS[value].icon,
  iconClassName: CONTENT_STATUS[value].iconClass,
}));

export function ContentRuleSheet({
  open,
  rule,
  services,
  groups,
  onSave,
  onClose,
  busy = false,
  error,
  children,
}: {
  open: boolean;
  rule: DraftContentRule | undefined;
  services: Services;
  groups: Groups;
  onSave: (rule: DraftContentRule) => void;
  onClose: () => void;
  busy?: boolean;
  error?: string;
  children?: React.ReactNode;
}) {
  const [name, setName] = React.useState(rule?.name ?? "");
  const [detector, setDetector] = React.useState<DetectorState>(detectorStateOf(rule?.detector));
  const [allServices, setAllServices] = React.useState(rule === undefined || rule.services === "*");
  const [picked, setPicked] = React.useState<string[]>(rule === undefined || rule.services === "*" ? [] : [...rule.services]);
  const [audience, setAudience] = React.useState<AudienceState>(audienceStateOf(rule?.audience ?? { kind: "org" }));
  const [action, setAction] = React.useState<GuardContentAction>(rule?.action ?? "block");
  const [note, setNote] = React.useState(rule?.note ?? "");
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [problemField, setProblemField] = React.useState<"name" | "detector" | "services" | "audience" | undefined>(undefined);
  const fail = (field: "name" | "detector" | "services" | "audience", message: string, focus: () => void) => {
    setProblem(message);
    setProblemField(field);
    focus();
  };
  const byId = (id: string) => () => document.getElementById(id)?.focus();
  const detectorField = (): string => (detector.kind === "email-bulk" || detector.kind === "phone-bulk" ? "crule-threshold" : detector.kind === "keyword" ? "crule-keywords" : detector.kind === "file-type" ? "crule-extensions" : "crule-detector");
  const ERROR_ID = { name: "crule-name-error", detector: "crule-detector-error", services: "crule-services-error", audience: "crule-audience-kind-error" } as const;
  const invalidIf = (field: NonNullable<typeof problemField>) => (problemField === field && problem !== undefined ? { "aria-invalid": true as const, "aria-describedby": ERROR_ID[field] } : {});
  const errorOf = (field: NonNullable<typeof problemField>) => (problemField === field ? problem : undefined);
  const save = () => {
    if (name.trim() === "") return fail("name", "Give the rule a name people will recognise on the block page.", byId("crule-name"));
    const det = detectorOf(detector);
    if (typeof det === "string") return fail("detector", det, byId(detectorField()));
    if (!allServices && picked.length === 0)
      return fail("services", "Pick at least one service, or choose every AI service.", () => document.querySelector<HTMLElement>("#crule-services [role='checkbox'], #crule-services button")?.focus());
    const who = audienceOf(audience);
    if (typeof who === "string") return fail("audience", who, () => focusAudience("crule-audience", audience));
    onSave({
      key: rule?.key ?? newKey("gcr"),
      ...(rule?.ruleId === undefined ? {} : { ruleId: rule.ruleId }),
      name: name.trim().slice(0, 80),
      detector: det,
      services: allServices ? "*" : picked,
      audience: who,
      action,
      enabled: rule?.enabled ?? true,
      ...(note.trim() === "" ? {} : { note: note.trim() }),
    });
  };
  const set = (patch: Partial<DetectorState>) => {
    setDetector((d) => ({ ...d, ...patch }));
    setProblem(undefined);
  };
  const servicesError = errorOf("services");
  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title={rule === undefined ? "Add a content rule" : rule.name}
      description="What may not be sent to an AI service."
      primaryLabel={rule === undefined ? "Add rule" : "Save"}
      onPrimary={save}
      busy={busy}
    >
      <FieldStack data-testid="content-rule-sheet">
        <Field label="Name" htmlFor="crule-name" error={errorOf("name")}>
          <TextInput id="crule-name" {...invalidIf("name")} maxLength={80} placeholder="Client codenames" value={name} onChange={(event) => (setName(event.target.value), setProblem(undefined))} />
        </Field>
        <Field label="Detects" htmlFor="crule-detector" hint="Fixed patterns and lists only. No model reads anything, and nothing that matches is kept." error={errorOf("detector")}>
          <div className="flex flex-col gap-3">
            <SelectInput<GuardDetectorKind>
              id="crule-detector"
              aria-describedby={detectorField() === "crule-detector" && errorOf("detector") !== undefined ? "crule-detector-hint crule-detector-error" : "crule-detector-hint"}
              {...(detectorField() === "crule-detector" && errorOf("detector") !== undefined ? { "aria-invalid": true } : {})}
              value={detector.kind}
              options={DETECTOR_OPTIONS}
              onValueChange={(kind) => set({ kind })}
            />
            {detector.kind === "secret" ? (
              <fieldset className="flex flex-col gap-1" data-testid="detector-secret">
                <legend className="mb-1 text-12 text-g-muted">The patterns to look for. Leave them all unticked to look for every one. Ported from gitleaks (MIT).</legend>
                <div className="grid grid-cols-1 gap-1 rounded-g-control border border-g-line p-2 sm:grid-cols-2">
                  {GUARD_SECRET_RULE_IDS.map((id) => (
                    <label key={id} className="flex min-h-7 items-center gap-2 font-mono text-12 text-g-ink">
                      <Checkbox checked={detector.secretRules.includes(id)} onCheckedChange={(on) => set({ secretRules: on ? [...detector.secretRules, id] : detector.secretRules.filter((x) => x !== id) })} />
                      {id}
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : null}
            {detector.kind === "email-bulk" || detector.kind === "phone-bulk" ? (
              <div className="flex flex-wrap items-center gap-2" data-testid={`detector-${detector.kind}`}>
                <label htmlFor="crule-threshold" className="text-13 font-medium text-g-ink">
                  Fires at
                </label>
                <TextInput id="crule-threshold" {...invalidIf("detector")} inputMode="numeric" className="w-24" value={detector.threshold} onChange={(event) => set({ threshold: event.target.value })} />
                <span className="text-14 text-g-muted">or more distinct {detector.kind === "email-bulk" ? "addresses" : "phone numbers"} in one request</span>
              </div>
            ) : null}
            {detector.kind === "keyword" ? (
              <div className="flex flex-col gap-3" data-testid="detector-keyword">
                <TextArea id="crule-keywords" aria-label="Keywords" {...invalidIf("detector")} mono rows={4} placeholder={"Project Falcon\nmerger"} value={detector.keywords} onChange={(event) => set({ keywords: event.target.value })} />
                <ToggleLine label="Whole words only" checked={detector.wholeWord} onCheckedChange={(on) => set({ wholeWord: on })} />
              </div>
            ) : null}
            {detector.kind === "au-tfn" || detector.kind === "au-acn" || detector.kind === "au-medicare" ? (
              <ToggleLine label="Only with a context word nearby" testId="detector-context" checked={detector.requireContext} onCheckedChange={(on) => set({ requireContext: on })}>
                {detector.kind === "au-tfn"
                  ? "Only with a context word nearby (TFN, tax file), or written 123 456 782"
                  : detector.kind === "au-medicare"
                    ? "Only with a context word nearby (Medicare), or written 2123 45670 1"
                    : "Only with a context word nearby (ACN, company number), or written 000 000 019"}
              </ToggleLine>
            ) : null}
            {(detector.kind === "au-tfn" || detector.kind === "au-acn" || detector.kind === "au-medicare") && !detector.requireContext ? (
              <p className="text-13 text-g-muted" role="note" data-testid="detector-context-warning">
                Without a context word this rule also matches about 1 in 40 ordinary messages, and the IDs some AI services send
                in the background, because any {detector.kind === "au-medicare" ? "ten" : "nine"}-digit number has a 1 in {detector.kind === "au-tfn" ? "11" : "10"} chance of passing the check.
              </p>
            ) : null}
            {detector.kind === "file-type" ? (
              <TextInput id="crule-extensions" aria-label="File extensions" {...invalidIf("detector")} data-testid="detector-file-type" placeholder="xlsx, csv, pdf" value={detector.extensions} onChange={(event) => set({ extensions: event.target.value })} />
            ) : null}
          </div>
        </Field>
        <Field label="Services">
          <div className="flex flex-col gap-3">
            <ToggleLine label={EVERY_SERVICE} checked={allServices} onCheckedChange={setAllServices} />
            {allServices ? null : (
              <ul id="crule-services" className="grid max-h-48 grid-cols-1 gap-0.5 overflow-y-auto overscroll-contain rounded-g-control border border-g-line p-1 sm:grid-cols-2" aria-label="Services">
                {services.map((s) => (
                  <li key={s.serviceId}>
                    <label className="flex min-h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-14 text-g-ink transition-[background-color] duration-(--g-dur-fast) hover:bg-g-hover">
                      <Checkbox
                        {...invalidIf("services")}
                        checked={picked.includes(s.serviceId)}
                        onCheckedChange={(on) => (setPicked(on ? [...picked, s.serviceId] : picked.filter((x) => x !== s.serviceId)), setProblem(undefined))}
                      />
                      <ServiceMark serviceId={s.serviceId} size="xs" />
                      <span className="truncate">{s.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            {servicesError === undefined ? null : <FieldError id="crule-services-error">{servicesError}</FieldError>}
          </div>
        </Field>
        <AudiencePicker
          id="crule-audience"
          state={audience}
          onChange={(next) => (setAudience(next), setProblem(undefined))}
          groups={groups}
          {...(errorOf("audience") === undefined ? {} : { error: errorOf("audience") })}
        />
        <Field label="When it matches" htmlFor="crule-action">
          <SelectInput<GuardContentAction> id="crule-action" value={action} options={ACTION_OPTIONS} onValueChange={setAction} />
        </Field>
        <Field label="Why (shown on the block page)" htmlFor="crule-note" hint="Optional.">
          <TextInput
            id="crule-note"
            aria-describedby="crule-note-hint"
            maxLength={200}
            placeholder="Personal data leaves the company"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </Field>
        {error === undefined ? null : <Problem id="crule-error">{error}</Problem>}
        {children}
      </FieldStack>
    </FormSheet>
  );
}
