import * as React from "react";
import { useSearchParams } from "react-router";
import { BanIcon, CheckIcon, CopyIcon, EyeIcon, PauseIcon, ScaleIcon, ShieldCheckIcon, SlidersHorizontalIcon, UserCheckIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import { GUARD_STAFF_NOTICE_TEMPLATE, renderStaffNotice, type GuardClientMode, type GuardSettingsPage, type GuardSettingsUpdate } from "@vibtra/guard-contract";
import { consolePathFor } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { ConsoleApiError, refusalWords } from "../api/client";
import { useAccount } from "../api/session";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import {
  ActionButton,
  ConfirmModal,
  Field,
  FieldStack,
  FormSheet,
  PageHeader,
  RadioCards,
  SegmentedTabs,
  SelectInput,
  SettingsCard,
  SettingsColumn,
  SettingsRow,
  SettingsSection,
  TextInput,
  actionButtonClass,
  useHeld,
  useSheetParam,
  type SelectOption,
} from "@/components/kit";
import { TextArea } from "../rules/editors";
import { absoluteWords, minutesWords, plural } from "../guard/words";
import { registrationDoor } from "../people/doors";
import { SignUps } from "../settings/SignUps";

const QUIET_PRESETS = [
  { minutes: 60, label: "1 hour" },
  { minutes: 8 * 60, label: "8 hours" },
  { minutes: 24 * 60, label: "24 hours" },
  { minutes: 3 * 24 * 60, label: "3 days" },
] as const;

const SECTION_WORD: Record<string, string> = {
  mode: "The mode",
  quiet: "The quiet-laptop time",
  tls: "The uninspectable TLS setting",
  snippets: "The redacted-examples setting",
  requests: "Request access",
  workspace: "The company workspace",
  notice: "The staff notice",
};

const SNIPPET_OPTIONS: SelectOption<"redacted" | "none">[] = [
  { value: "redacted", label: "Redacted fragment" },
  { value: "none", label: "Counts only" },
];

const MODE_WORD: Record<GuardClientMode, { label: string; icon: typeof EyeIcon }> = {
  monitor: { label: "Monitor", icon: EyeIcon },
  enforce: { label: "Enforce", icon: ShieldCheckIcon },
};

type SettingsTab = "general" | "signups";

export function Settings() {
  const [params] = useSearchParams();
  const door = useDoor(() => guard.settings(), []);
  const signups = useDoor(
    () =>
      registrationDoor.read().catch((error: unknown) => {
        if (error instanceof ConsoleApiError && (error.status === 404 || error.status === 403)) return undefined;
        throw error;
      }),
    [],
  );
  const operator = signups.state.status === "error" || (signups.state.status === "ready" && signups.state.data !== undefined);
  const tab: SettingsTab = operator && params.get("tab") === "signups" ? "signups" : "general";
  const header = operator ? (
    <PageHeader
      tabs={
        <SegmentedTabs<SettingsTab>
          label="Settings"
          value={tab}
          items={[
            { value: "general", label: "General", icon: SlidersHorizontalIcon, to: "/settings" },
            { value: "signups", label: "Sign-ups", icon: UserCheckIcon, to: "/settings?tab=signups" },
          ]}
        />
      }
    />
  ) : null;
  if (tab === "signups") {
    return (
      <div data-testid="settings-signups">
        {header}
        {signups.state.status === "error" ? (
          <DoorError error={signups.state.error} onRetry={signups.reload} />
        ) : signups.state.status === "ready" && signups.state.data !== undefined ? (
          <SignUps page={signups.state.data} />
        ) : (
          <DoorSkeleton rows={4} />
        )}
      </div>
    );
  }
  return (
    <>
      {header}
      {door.state.status === "loading" ? (
        <DoorSkeleton rows={6} />
      ) : door.state.status === "error" ? (
        <DoorError error={door.state.error} onRetry={door.reload} />
      ) : (
        <SettingsForm page={door.state.data} />
      )}
    </>
  );
}

function Value({ children, mono = false, testId }: { children: React.ReactNode; mono?: boolean; testId?: string }) {
  return (
    <span data-testid={testId} className={mono ? "block truncate text-end font-mono text-13 text-g-muted max-md:text-start" : "block truncate text-end text-14 text-g-muted max-md:text-start"}>
      {children}
    </span>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
};

const urlProblemOf = (url: string, tried: boolean): string | undefined =>
  (url.trim() !== "" || tried) && !/^https?:\/\/[^\s]+$/.test(url.trim()) ? "Enter a full address that starts with https://" : undefined;

export function SettingsForm({ page: loaded }: { page: GuardSettingsPage }) {
  const account = useAccount();
  const [page, setPage] = React.useState(loaded);
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const sheet = useSheetParam("sheet");
  const [confirm, setConfirm] = React.useState<"enforce" | "pause" | undefined>(undefined);
  const s = page.settings;

  const put = async (section: string, body: GuardSettingsUpdate, said: string) => {
    setBusy(section);
    try {
      const next = await guard.putSettings(body);
      setPage(next);
      toast.success(said);
      return true;
    } catch (error) {
      toastError(`${SECTION_WORD[section] ?? "That setting"} was not saved`, refusalWords(error));
      return false;
    } finally {
      setBusy(undefined);
    }
  };
  const toMonitor = () => put("mode", { clientMode: "monitor" }, "Monitoring only. The laptops stop enforcing rules at their next check-in.");
  const mode = MODE_WORD[s.clientMode];
  const ModeIcon = mode.icon;
  const quietKnown = QUIET_PRESETS.some((p) => p.minutes === s.quietAfterMinutes);
  const quietOptions: SelectOption<string>[] = [
    ...(quietKnown ? [] : [{ value: String(s.quietAfterMinutes), label: `${minutesWords(s.quietAfterMinutes)} (set elsewhere)` }]),
    ...QUIET_PRESETS.map((p) => ({ value: String(p.minutes), label: p.label })),
  ];
  const heldSheet = useHeld(sheet.value === "mode" || sheet.value === "workspace" || sheet.value === "notice" ? sheet.value : undefined);
  const laptops = page.devices;
  const oneLaptop = new Intl.PluralRules(undefined).select(laptops) === "one";

  return (
    <div data-testid="settings-page" className="flex flex-col">
      <SettingsColumn className="pb-6">
        <SettingsSection title="Protection">
          <SettingsCard>
            <SettingsRow
              title="Mode"
              description={s.clientMode === "monitor" && s.unreproducibleTls === "tunnel"
                ? "Monitor records rule decisions. Uninspectable TLS is currently allowed without inspection."
                : "Monitor records rule decisions. Uninspectable TLS is currently blocked. Enforce always blocks it."}
              control={{
                kind: "value",
                value: (
                  <span className="inline-flex items-center gap-1.5" data-testid="settings-mode" data-mode={s.clientMode}>
                    <ModeIcon aria-hidden className="size-3.5" />
                    {mode.label}
                  </span>
                ),
                onClick: () => sheet.open("mode"),
              }}
            />
            <SettingsRow
              title={<span id="tls-title">Uninspectable TLS</span>}
              description={<span id="tls-desc">When Guard cannot inspect a secure connection, block it by default. Monitor mode can allow it without inspection. Enforce mode always blocks it.</span>}
              control={{
                kind: "control",
                children: (
                  <SelectInput<"block" | "tunnel">
                    aria-labelledby="tls-title"
                    aria-describedby="tls-desc"
                    disabled={busy === "tls" || s.clientMode === "enforce"}
                    value={s.clientMode === "enforce" ? "block" : s.unreproducibleTls}
                    options={[
                      { value: "block", label: "Block" },
                      { value: "tunnel", label: "Allow without inspection" },
                    ]}
                    onValueChange={(v) => void put("tls", { unreproducibleTls: v }, v === "block" ? "Uninspectable connections will be blocked at the next check-in." : "Monitor mode will allow uninspectable connections at the next check-in.")}
                  />
                ),
              }}
            />
            <SettingsRow
              title={<span id="quiet-title">Quiet laptops</span>}
              description={<span id="quiet-desc">A laptop silent for this long is marked quiet on Devices and counted on the Overview.</span>}
              control={{
                kind: "control",
                children: (
                  <SelectInput<string>
                    aria-labelledby="quiet-title"
                    aria-describedby="quiet-desc"
                    disabled={busy === "quiet"}
                    value={String(s.quietAfterMinutes)}
                    options={quietOptions}
                    onValueChange={(v) => void put("quiet", { quietAfterMinutes: Number(v) }, `Quiet after ${minutesWords(Number(v))}.`)}
                  />
                ),
              }}
            />
            <SettingsRow
              title={<span id="snippets-title">Redacted examples</span>}
              description={<span id="snippets-desc">Keep a redacted fragment (123***782) with a match, or only the rule and a count.</span>}
              control={{
                kind: "control",
                children: (
                  <SelectInput<"redacted" | "none">
                    aria-labelledby="snippets-title"
                    aria-describedby="snippets-desc"
                    disabled={busy === "snippets"}
                    value={s.snippetPolicy}
                    options={SNIPPET_OPTIONS}
                    onValueChange={(v) => void put("snippets", { snippetPolicy: v }, v === "none" ? "Counts only: no fragment leaves the laptops." : "Redacted fragments are kept.")}
                  />
                ),
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Block page">
          <SettingsCard>
            <SettingsRow
              title="Request access"
              description="Offer “Request access” on the block page. Asks land on Requests, and an approval is a time-boxed grant for that person."
              control={{
                kind: "toggle",
                checked: s.requestsEnabled,
                disabled: busy === "requests",
                onCheckedChange: (on) => void put("requests", { requestsEnabled: on }, on ? "The block page offers Request access." : "The block page no longer offers Request access."),
              }}
            />
            <SettingsRow
              title="Company workspace"
              description={
                s.workspaceRedirect.url === undefined
                  ? "Offer “Use the company Vibtra workspace” on the block page. Set the address first."
                  : "Offer “Use the company Vibtra workspace” on the block page, instead of the blocked service."
              }
              control={{
                kind: "toggle",
                checked: s.workspaceRedirect.enabled,
                disabled: busy === "workspace" || (!s.workspaceRedirect.enabled && s.workspaceRedirect.url === undefined),
                onCheckedChange: (on) =>
                  void put(
                    "workspace",
                    { workspaceRedirect: { enabled: on, ...(s.workspaceRedirect.url === undefined ? {} : { url: s.workspaceRedirect.url }) } },
                    on ? "The block page offers the company workspace." : "The block page no longer offers the company workspace.",
                  ),
              }}
            />
            <SettingsRow
              title="Workspace address"
              description="Where “Use the company Vibtra workspace” sends people."
              control={{
                kind: "value",
                value: (
                  <span className="block max-w-40 truncate max-md:max-w-28" data-testid="workspace-url">
                    {s.workspaceRedirect.url === undefined ? "Not set" : hostOf(s.workspaceRedirect.url)}
                  </span>
                ),
                onClick: () => sheet.open("workspace"),
              }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Staff notice">
          <SettingsCard>
            <SettingsRow
              title="Staff notice"
              description={
                s.staffNotice.updatedAt === undefined
                  ? "Give this to staff before Guard starts recording. The shipped template."
                  : `Give this to staff before Guard starts recording. Last changed ${absoluteWords(s.staffNotice.updatedAt)}${s.staffNotice.updatedBy === undefined ? "" : ` by ${s.staffNotice.updatedBy}`}.`
              }
              control={{ kind: "value", value: s.staffNotice.template === GUARD_STAFF_NOTICE_TEMPLATE ? "Template" : "Edited", onClick: () => sheet.open("notice") }}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="Organisation">
          <SettingsCard>
            <SettingsRow title="Name" description="Read from the organisation this console is signed in to." control={{ kind: "control", children: <Value>{page.org.name}</Value> }} />
            <SettingsRow title="Address" control={{ kind: "control", children: <Value mono>/{page.org.handle}</Value> }} />
            {page.org.domain === undefined ? null : <SettingsRow title="Domain" control={{ kind: "control", children: <Value>{page.org.domain}</Value> }} />}
            <SettingsRow
              title="Sign-in"
              description="People sign in to Guard with the organisation’s own sign-in, set in the Vibtra console."
              control={{
                kind: "control",
                children: (
                  <a className={actionButtonClass("secondary", "w-full")} href={consolePathFor(page.org.handle, "/settings")}>
                    Open sign-in settings
                  </a>
                ),
              }}
            />
            <SettingsRow title="Enrolled laptops" description="Laptops that check in with Guard." control={{ kind: "value", value: <span className="tabular-nums">{page.devices}</span>, to: "/devices" }} />
            <SettingsRow
              title="Signing key"
              description="The laptops pinned this key when they enrolled and refuse rules signed by any other."
              control={{ kind: "control", children: <Value mono testId="signing-key">{page.signingKeyId ?? "Not made yet (made at the first enrolment)"}</Value> }}
            />
          </SettingsCard>
        </SettingsSection>

        {s.clientMode === "enforce" ? (
          <SettingsSection title="Danger zone">
            <SettingsCard>
              <SettingsRow
                title="Pause enforcement on all laptops"
                description="Every laptop goes back to monitor at its next check-in. Use it in an emergency."
                control={{ kind: "danger", label: "Pause enforcement", icon: PauseIcon, disabled: busy === "mode", onClick: () => setConfirm("pause") }}
              />
            </SettingsCard>
          </SettingsSection>
        ) : null}
      </SettingsColumn>

      {heldSheet.value === "mode" ? (
        <ModeSheet
          open={heldSheet.open}
          value={s.clientMode}
          busy={busy === "mode"}
          onClose={() => sheet.close()}
          onSave={(next) => {
            if (next === s.clientMode) return sheet.close();
            if (next === "enforce") {
              sheet.close();
              setConfirm("enforce");
              return;
            }
            void toMonitor().then((ok) => ok && sheet.close());
          }}
        />
      ) : null}
      {heldSheet.value === "workspace" ? (
        <WorkspaceSheet
          open={heldSheet.open}
          page={page}
          busy={busy === "workspace"}
          onClose={() => sheet.close()}
          onSave={(url) =>
            void put("workspace", { workspaceRedirect: { enabled: s.workspaceRedirect.enabled, url } }, "Saved the workspace address.").then((ok) => ok && sheet.close())
          }
        />
      ) : null}
      {heldSheet.value === "notice" ? (
        <NoticeSheet
          open={heldSheet.open}
          page={page}
          contact={account.email}
          busy={busy === "notice"}
          onClose={() => sheet.close()}
          onSave={(template) => void put("notice", { staffNotice: { template } }, "Saved the staff notice.").then((ok) => ok && sheet.close())}
        />
      ) : null}

      <ConfirmModal
        open={confirm === "enforce"}
        onClose={() => setConfirm(undefined)}
        title="Switch to enforce?"
        confirmLabel="Switch to enforce"
        cancelLabel="Cancel"
        destructive={false}
        busy={busy === "mode"}
        onConfirm={() => void put("mode", { clientMode: "enforce" }, "Enforcing. The laptops start blocking at their next check-in.").finally(() => setConfirm(undefined))}
      >
        {laptops === 0
          ? "No laptop is enrolled yet. Each one enforces the rules from its first check-in."
          : `${plural(laptops, "enrolled laptop starts", "enrolled laptops start")} blocking what the rules block at ${oneLaptop ? "its" : "their"} next check-in (about a minute). Make sure staff have had the notice.`}
      </ConfirmModal>
      <ConfirmModal
        open={confirm === "pause"}
        onClose={() => setConfirm(undefined)}
        title="Pause enforcement on all laptops?"
        confirmLabel="Pause enforcement"
        cancelLabel="Cancel"
        busy={busy === "mode"}
        onConfirm={() => void toMonitor().finally(() => setConfirm(undefined))}
      >
        Every laptop stops enforcing rules at its next check-in. Connections Guard cannot inspect still follow the Uninspectable TLS setting. Switch back under Mode.
      </ConfirmModal>
    </div>
  );
}

function ModeSheet({ open, value, busy, onClose, onSave }: { open: boolean; value: GuardClientMode; busy: boolean; onClose: () => void; onSave: (mode: GuardClientMode) => void }) {
  const [choice, setChoice] = React.useState(value);
  return (
    <FormSheet open={open} size="sm" title="Monitor or enforce?" description="What the laptops do when a rule says block or ask." primaryLabel="Save" onPrimary={() => onSave(choice)} busy={busy} onClose={onClose}>
      <RadioCards
        name="client-mode"
        label="Mode"
        value={choice}
        onValueChange={setChoice}
        options={[
          { value: "monitor", title: "Monitor", description: "Record what the rules would block. Connections Guard can’t inspect are still blocked unless you allow them under Uninspectable TLS.", icon: EyeIcon },
          { value: "enforce", title: "Enforce", description: "Block or ask as the rules say. Give staff the notice first.", icon: BanIcon },
        ]}
      />
    </FormSheet>
  );
}

function WorkspaceSheet({ open, page, busy, onClose, onSave }: { open: boolean; page: GuardSettingsPage; busy: boolean; onClose: () => void; onSave: (url: string) => void }) {
  const [url, setUrl] = React.useState(page.settings.workspaceRedirect.url ?? "");
  const [tried, setTried] = React.useState(false);
  const problem = urlProblemOf(url, tried);
  const save = () => {
    if (problem !== undefined || url.trim() === "") {
      setTried(true);
      document.getElementById("redirect-url")?.focus();
      return;
    }
    if (url.trim() === (page.settings.workspaceRedirect.url ?? "")) return onClose();
    onSave(url.trim());
  };
  return (
    <FormSheet open={open} title="Workspace address" description="The block page’s second door sends people here instead of the blocked service." primaryLabel="Save" onPrimary={save} busy={busy} onClose={onClose}>
      <FieldStack>
        <Field label="Where it goes" htmlFor="redirect-url" error={problem} hint={problem === undefined && !page.settings.workspaceRedirect.enabled ? "Then switch it on under Block page." : undefined}>
          <TextInput
            id="redirect-url"
            type="text"
            inputMode="url"
            autoComplete="url"
            placeholder={`https://vibtra.app/${page.org.handle}/workspace`}
            value={url}
            aria-invalid={problem === undefined ? undefined : true}
            aria-describedby={problem !== undefined ? "redirect-url-error" : !page.settings.workspaceRedirect.enabled ? "redirect-url-hint" : undefined}
            onChange={(event) => setUrl(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FormSheet>
  );
}

function NoticeSheet({
  open,
  page,
  contact,
  busy,
  onClose,
  onSave,
}: {
  open: boolean;
  page: GuardSettingsPage;
  contact: string;
  busy: boolean;
  onClose: () => void;
  onSave: (template: string) => void;
}) {
  const [notice, setNotice] = React.useState(page.settings.staffNotice.template);
  const [copied, setCopied] = React.useState(false);
  const preview = renderStaffNotice(notice, { orgName: page.org.name, contact });
  const dirty = notice !== page.settings.staffNotice.template;
  return (
    <FormSheet
      open={open}
      title="Staff notice"
      description="Give this to staff before Guard starts recording. Your organisation’s name and your email address are filled in. Replace {{startDate}} with the day recording starts."
      primaryLabel="Save"
      onPrimary={() => (dirty ? onSave(notice) : onClose())}
      busy={busy}
      onClose={onClose}
    >
      <FieldStack className="gap-6">
        <p data-testid="notice-not-advice" className="flex gap-2.5 rounded-g-control border border-g-pill-warn-line bg-g-pill-warn-bg px-3 py-2.5 text-13 text-g-pill-warn-ink">
          <ScaleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
          This is a template, not legal advice. In NSW the Workplace Surveillance Act 2005 asks for 14 days’ written notice. Check what applies to you.
        </p>
        <Field label="Template" htmlFor="notice-template">
          <TextArea id="notice-template" rows={12} mono maxLength={10_000} value={notice} onChange={(event) => setNotice(event.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <ActionButton disabled={notice === GUARD_STAFF_NOTICE_TEMPLATE} onClick={() => setNotice(GUARD_STAFF_NOTICE_TEMPLATE)}>
            Start from the template
          </ActionButton>
          <ActionButton
            icon={copied ? CheckIcon : CopyIcon}
            onClick={() => {
              void navigator.clipboard
                ?.writeText(preview)
                .then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                })
                .catch(() => undefined);
            }}
          >
            {copied ? "Copied" : "Copy the notice"}
          </ActionButton>
        </div>
        <Field label="Preview">
          <pre data-testid="notice-preview" className="max-h-96 overflow-auto rounded-g-control border border-g-line bg-g-header px-4 py-3 font-sans text-14 whitespace-pre-wrap text-pretty text-g-ink">
            {preview}
          </pre>
        </Field>
      </FieldStack>
    </FormSheet>
  );
}
