import { ServiceMark } from "../brand/BrandMark";
import * as React from "react";
import { ActionButton, Field, Pill, SelectInput, SheetSection, TextAreaInput, TextInput, cn, type PillTone, type SelectOption } from "@/components/kit";
import type { GuardRuleTestInput, GuardRuleTestResult, GuardRulesPage } from "@vibtra/guard-contract";
import { guard } from "../api/guard";
import { ConsoleApiError } from "../api/client";
import { RefusalDetail } from "../shell/Refusal";
import { DETECTOR_WORD, FLOW_WORD } from "../guard/words";

const VERDICT: Record<GuardRuleTestResult["verdict"], { label: string; tone: PillTone }> = {
  allowed: { label: "Allowed", tone: "ok" },
  blocked: { label: "Blocked", tone: "bad" },
  asked: { label: "Asked", tone: "warn" },
  "not-intercepted": { label: "Not an AI service", tone: "neutral" },
};

const HOST_CHOICE = "__host__";

export function VerdictCard({ result }: { result: GuardRuleTestResult }) {
  const verdict = VERDICT[result.verdict];
  return (
    <div data-testid="test-verdict" data-verdict={result.verdict} className="flex flex-col gap-3 rounded-g-card border border-g-line bg-g-surface p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={verdict.tone} size="header">
          {verdict.label}
        </Pill>
        {result.serviceName === undefined ? null : (
          <span className="flex items-center gap-2 text-14 font-medium text-g-ink">
            <ServiceMark serviceId={result.serviceId} />
            {result.serviceName}
          </span>
        )}
      </div>
      <p className="text-14 text-g-ink">{result.explanation}</p>
      {result.flow === undefined ? null : (
        <p className="text-13 text-g-muted" data-testid="test-flow">
          Reaching the service: <span className="text-g-ink">{FLOW_WORD[result.flow.action].label}</span>
          {result.flow.source === "default" ? " (the default)" : result.flow.source === "exception" ? " (a live grant)" : " (a service rule)"}
        </p>
      )}
      {result.content.length === 0 ? null : (
        <ul className="flex flex-col divide-y divide-g-divider rounded-g-control border border-g-line" data-testid="test-matches">
          {result.content.map((m) => (
            <li key={m.ruleId} data-testid="test-match" className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-14">
              <span className="font-medium text-g-ink">{m.ruleName}</span>
              <span className="text-g-muted">
                {DETECTOR_WORD[m.matchType]} × {m.count}
              </span>
              {m.example === undefined ? null : <span className="font-mono text-12 text-g-muted">{m.example}</span>}
              <span className="ms-auto flex items-center gap-2">
                {m.excepted ? (
                  <Pill tone="neutral" data-testid="test-excepted">
                    A grant lets them past
                  </Pill>
                ) : null}
                <Pill tone={m.action === "block" ? "bad" : "neutral"}>{m.action === "allow" ? "Record only" : m.action === "ask" ? "Ask IT" : "Block"}</Pill>
              </span>
            </li>
          ))}
        </ul>
      )}
      {result.enforced ? null : (
        <p data-testid="test-monitor" className="text-12 text-g-muted">
          In monitor mode this would be recorded, not blocked.
        </p>
      )}
    </div>
  );
}

export function TestBox({
  services,
  note,
  initialServiceId,
  className,
}: {
  services: GuardRulesPage["services"];
  note?: string;
  initialServiceId?: string;
  className?: string;
}) {
  const [serviceId, setServiceId] = React.useState(
    initialServiceId !== undefined && services.some((s) => s.serviceId === initialServiceId) ? initialServiceId : (services[0]?.serviceId ?? HOST_CHOICE),
  );
  const [host, setHost] = React.useState("");
  const [personEmail, setPersonEmail] = React.useState("");
  const [text, setText] = React.useState("");
  const [files, setFiles] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<GuardRuleTestResult | undefined>(undefined);
  const [error, setError] = React.useState<ConsoleApiError | undefined>(undefined);
  const [announce, setAnnounce] = React.useState("");
  const [hostProblem, setHostProblem] = React.useState<string | undefined>(undefined);
  const hostRef = React.useRef<HTMLInputElement>(null);
  const serviceOptions: SelectOption<string>[] = [
    ...services.map((s) => ({ value: s.serviceId, label: s.name })),
    { value: HOST_CHOICE, label: "Another host…", separatorBefore: services.length > 0 },
  ];

  const run = async () => {
    if (busy) return;
    if (serviceId === HOST_CHOICE && host.trim() === "") {
      setHostProblem("Type the host to check, for example chatgpt.com.");
      hostRef.current?.focus();
      return;
    }
    setHostProblem(undefined);
    const filenames = files
      .split(",")
      .map((f) => f.trim())
      .filter((f) => f !== "");
    const body: GuardRuleTestInput = {
      ...(serviceId === HOST_CHOICE ? { host: host.trim().toLowerCase() } : { serviceId }),
      ...(personEmail.trim() === "" ? {} : { personEmail: personEmail.trim().toLowerCase() }),
      ...(text === "" ? {} : { text }),
      ...(filenames.length === 0 ? {} : { filenames }),
    };
    setBusy(true);
    setError(undefined);
    try {
      const r = await guard.testRules(body);
      setResult(r);
      setAnnounce(`${VERDICT[r.verdict].label}: ${r.explanation}`);
    } catch (caught) {
      setResult(undefined);
      setAnnounce("");
      setError(caught instanceof ConsoleApiError ? caught : new ConsoleApiError({ status: 0, code: "INTERNAL", message: "The test did not run", detail: String(caught) }));
    } finally {
      setBusy(false);
    }
  };
  const enterRuns = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    void run();
  };

  return (
    <SheetSection
      testId="rules-test-box"
      title="Would this be blocked?"
      description={`Runs the saved service and content rules. App and website switches are not simulated here. What you type is checked and thrown away.${note === undefined ? "" : ` ${note}`}`}
      className={cn("gap-4 rounded-g-card border border-g-line bg-g-header p-5", className)}
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <Field label="Service" htmlFor="test-service">
            <div className="flex flex-col gap-2">
              <SelectInput<string> id="test-service" value={serviceId} onValueChange={setServiceId} options={serviceOptions} />
              {serviceId === HOST_CHOICE ? (
                <>
                  <TextInput
                    ref={hostRef}
                    aria-label="Host to test"
                    placeholder="chatgpt.com"
                    value={host}
                    aria-invalid={hostProblem === undefined ? undefined : true}
                    {...(hostProblem === undefined ? {} : { "aria-describedby": "test-host-problem" })}
                    onKeyDown={enterRuns}
                    onChange={(event) => setHost(event.target.value)}
                  />
                  {hostProblem === undefined ? null : (
                    <p id="test-host-problem" role="alert" className="g-rise text-12 text-g-danger">
                      {hostProblem}
                    </p>
                  )}
                </>
              ) : null}
            </div>
          </Field>
          <Field label="As" htmlFor="test-person" hint="Optional. Their groups and grants apply.">
            <TextInput
              id="test-person"
              type="text"
              inputMode="email"
              autoComplete="email"
              aria-describedby="test-person-hint"
              placeholder="someone@yourcompany.com"
              value={personEmail}
              onKeyDown={enterRuns}
              onChange={(event) => setPersonEmail(event.target.value)}
            />
          </Field>
        </div>
        <Field label="What they would send" htmlFor="test-text">
          <TextAreaInput id="test-text" rows={3} maxLength={200_000} placeholder="My TFN is 123 456 782" value={text} onChange={(event) => setText(event.target.value)} />
        </Field>
        <Field label="Files they would attach" htmlFor="test-files" hint="Optional. Separate names with commas.">
          <TextInput id="test-files" aria-describedby="test-files-hint" placeholder="payroll.xlsx, notes.pdf" value={files} onKeyDown={enterRuns} onChange={(event) => setFiles(event.target.value)} />
        </Field>
        <ActionButton className="self-start" aria-disabled={busy || undefined} loading={busy} disabled={false} onClick={() => void run()} data-testid="test-run">
          Check
        </ActionButton>
      </div>
      {error === undefined ? null : (
        <div role="alert" className="g-rise flex flex-col gap-1 rounded-g-control border border-g-pill-bad-line bg-g-surface p-3 text-14">
          <span className="font-medium text-g-danger">{error.message}</span>
          {error.detail === undefined ? null : <RefusalDetail detail={error.detail} />}
        </div>
      )}
      <div role="status" className="sr-only" data-testid="test-announce">
        {announce}
      </div>
      {result === undefined ? null : (
        <div className="g-rise">
          <VerdictCard result={result} />
        </div>
      )}
    </SheetSection>
  );
}
