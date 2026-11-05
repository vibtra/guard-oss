import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { GlobeIcon, PencilIcon, PlusIcon, PowerIcon, ScanTextIcon, SparklesIcon, Trash2Icon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import { GUARD_ACTIVATABLE_SURFACES, GUARD_SURFACE_IDS, type GuardFlowAction, type GuardOverviewService, type GuardRulesPage, type GuardSurfaceId } from "@vibtra/guard-contract";
import { guard } from "../api/guard";
import { ConsoleApiError, refusalWords } from "../api/client";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import {
  ActionButton,
  CellTitle,
  ConfirmModal,
  DataTable,
  EMPTY,
  EmptyState,
  ListToolbar,
  PageHeader,
  Pill,
  SegmentedTabs,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  cn,
  useHeld,
  useSheetParam,
  type DataColumn,
} from "@/components/kit";
import { absoluteWords, audienceWords, categoryWord, detectorWords } from "../guard/words";
import {
  baseRuleOf,
  draftOf,
  ruledServices,
  serviceSheetOf,
  startersFor,
  statusOf,
  updateOf,
  withServiceRules,
  type Draft,
  type DraftContentRule,
  type DraftServiceRule,
} from "../rules/draft";
import { CONTENT_STATUS, ContentRuleSheet, DefaultActionSheet, ServiceRuleSheet, ServiceTile, StatusPill } from "../rules/editors";
import { TestBox } from "../rules/TestBox";

type Tab = "services" | "content";
const NEW = "__new__";
const DEFAULT_ROW = "__default__";
const SAVED_WORDS = "Saved. Laptops pick the rules up at their next check-in (about a minute).";

const SURFACE: Record<GuardSurfaceId, { noun: string; description: string }> = {
  "claude-web": { noun: "the Claude website", description: "claude.ai in Google Chrome." },
  "claude-macos": { noun: "the Claude macOS app", description: "Chat in the Claude app for Mac." },
  "chatgpt-web": { noun: "the ChatGPT website", description: "chatgpt.com in Google Chrome." },
  "chatgpt-macos": { noun: "the ChatGPT macOS app (ChatGPT and Codex)", description: "Both modes share one connection, so they are blocked together." },
};
const surfaceTitle = (id: GuardSurfaceId): string => `Block ${SURFACE[id].noun}`;
const capital = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

const FIELD_STEP: Record<string, string> = {
  note: "Shorten the reason to 200 characters or fewer.",
  name: "Give it a name of 80 characters or fewer.",
  audience: "Check who it applies to.",
  services: "Check the services it names.",
  detector: "Check what it detects.",
  serviceId: "Pick the service again.",
  action: "Pick its status again.",
};

export function Rules() {
  const door = useDoor(() => guard.rules(), []);
  if (door.state.status === "loading") return <DoorSkeleton rows={6} />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  return <RulesEditor key={door.state.data.document.version} page={door.state.data} onReload={door.reload} />;
}

function Notice({ tone, children, ...props }: React.ComponentProps<"div"> & { tone: "info" | "warn" | "bad" }) {
  return (
    <div
      role={tone === "info" ? undefined : "alert"}
      className={cn(
        "mb-4 rounded-g-card border px-4 py-3 text-14",
        tone === "info" ? "border-g-line bg-g-header text-g-ink" : tone === "warn" ? "border-g-pill-warn-line bg-g-pill-warn-bg text-g-pill-warn-ink" : "border-g-pill-bad-line bg-g-pill-bad-bg text-g-pill-bad-ink",
      )}
      {...props}
    >
      {children}
    </div>
  );
}

export function RulesEditor({ page: loaded, onReload }: { page: GuardRulesPage; onReload: () => void }) {
  const [page, setPage] = React.useState(loaded);
  const draft = React.useMemo(() => draftOf(page.document), [page]);
  const [busy, setBusy] = React.useState(false);
  const [stale, setStale] = React.useState(false);
  const [problem, setProblem] = React.useState<string | undefined>(undefined);
  const [sheetError, setSheetError] = React.useState<string | undefined>(undefined);
  const [surfaceProblem, setSurfaceProblem] = React.useState<{ id: GuardSurfaceId; words: string } | undefined>(undefined);
  const [deleting, setDeleting] = React.useState<{ kind: "service"; serviceId: string; name: string } | { kind: "content"; key: string; name: string } | undefined>(undefined);
  const [q, setQ] = React.useState("");
  const [params] = useSearchParams();
  const tab: Tab = params.get("tab") === "content" ? "content" : "services";
  const serviceSheet = useSheetParam("service");
  const ruleSheet = useSheetParam("rule");
  const groups = React.useMemo(() => new Map(page.groups.map((g) => [g.id, g.name] as const)), [page.groups]);
  const serviceName = (id: string) => (id === "*" ? "Every AI service" : (page.services.find((s) => s.serviceId === id)?.name ?? id));

  const [usage, setUsage] = React.useState<{ services: ReadonlyMap<string, GuardOverviewService>; monitor: boolean } | undefined>(undefined);
  React.useEffect(() => {
    let live = true;
    guard.overview(7).then(
      (o) => live && setUsage({ services: new Map(o.services.map((s) => [s.serviceId, s] as const)), monitor: o.clientMode === "monitor" }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  const issueWords = (next: Draft, path: readonly PropertyKey[]): string => {
    const [top, index, field] = path[0] === "document" ? path.slice(1) : path;
    const step = FIELD_STEP[String(field ?? "")] ?? "Check it and save again.";
    if (top === "contentRules" && typeof index === "number") return `The content rule “${next.contentRules[index]?.name ?? index + 1}” was not saved. ${step}`;
    if (top === "serviceRules" && typeof index === "number") return `The rule for ${serviceName(next.serviceRules[index]?.serviceId ?? "")} was not saved. ${step}`;
    if (top === "surfaceBlocks") return "The app and website switches were not saved. Reload the page and try again.";
    return "The rules were not saved. Reload the page and try again.";
  };

  const commit = async (next: Draft, said = SAVED_WORDS, surface?: { id: GuardSurfaceId; on: boolean }): Promise<boolean> => {
    const parsed = updateOf(page.document.version, next);
    if (!parsed.success) {
      const words = [...new Set(parsed.error.issues.map((i) => issueWords(next, i.path)))].join(" ");
      setProblem(words);
      setSheetError(words);
      return false;
    }
    setBusy(true);
    setProblem(undefined);
    setSheetError(undefined);
    setSurfaceProblem(undefined);
    try {
      const answer = await guard.putRules(parsed.data);
      setPage(answer);
      toast.success(said);
      return true;
    } catch (error) {
      if (error instanceof ConsoleApiError && ["GUARD_UPGRADE_REQUIRED", "GUARD_SURFACE_COVERAGE_UNAVAILABLE"].includes(error.code)) {
        const words = refusalWords(error, "");
        if (surface === undefined) {
          setProblem(words);
          setSheetError(words);
        } else {
          setSurfaceProblem({ id: surface.id, words });
          toastError(`${capital(SURFACE[surface.id].noun)} ${surface.on ? "was not blocked" : "is still blocked"}`, words);
        }
      } else if (error instanceof ConsoleApiError && (error.code === "STALE_BASE" || error.status === 409)) {
        setStale(true);
        setSheetError("The rules changed since you opened this page. Close this and reload to see them; nothing was saved.");
      } else {
        const words = refusalWords(error);
        toastError("The rules were not saved", words);
        setSheetError(`The rules were not saved. ${words}`);
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  const closeSheets = () => {
    setSheetError(undefined);
    if (serviceSheet.value !== null) serviceSheet.close();
    if (ruleSheet.value !== null) ruleSheet.close();
  };
  const commitAndClose = async (next: Draft, said?: string) => {
    if (await commit(next, said)) closeSheets();
  };

  const ruled = ruledServices(draft);
  const choices = [...page.services.map((s) => s.serviceId).filter((id) => !ruled.includes(id)), ...(ruled.includes("*") ? [] : ["*"])];
  type ServiceRow = { kind: "service"; serviceId: string } | { kind: "default" };
  const needle = q.trim().toLowerCase();
  const serviceRows: ServiceRow[] = [
    ...ruled.filter((id) => needle === "" || serviceName(id).toLowerCase().includes(needle)).map((serviceId) => ({ kind: "service" as const, serviceId })),
    ...(needle === "" || "any other ai service".includes(needle) ? [{ kind: "default" as const }] : []),
  ];
  const exceptionsOf = (id: string) => draft.serviceRules.filter((r) => r.serviceId === id && r !== baseRuleOf(draft, id)).length;
  const subOf = (id: string): string => {
    const note = baseRuleOf(draft, id)?.note;
    if (note !== undefined) return note;
    if (id === "*") return "A rule for every AI service";
    const category = page.services.find((s) => s.serviceId === id)?.category;
    return category === undefined ? "Not in the enabled catalogue" : categoryWord(category);
  };
  const serviceColumns: DataColumn<ServiceRow>[] = [
    {
      id: "status",
      header: "Status",
      width: "128px",
      cell: (row) => {
        if (row.kind === "default") return <StatusPill status={draft.defaultAction} />;
        const base = baseRuleOf(draft, row.serviceId);
        return base === undefined ? <StatusPill status="default" label="No rule" /> : <StatusPill status={statusOf(base)} />;
      },
    },
    {
      id: "service",
      header: "Service",
      cell: (row) =>
        row.kind === "default" ? (
          <CellTitle icon={<ServiceTile serviceId="*" />} title="Any other AI service" sub="When no rule names the service" />
        ) : (
          <CellTitle icon={<ServiceTile serviceId={row.serviceId} />} title={serviceName(row.serviceId)} sub={subOf(row.serviceId)} />
        ),
    },
    {
      id: "exceptions",
      header: "Exceptions",
      width: "112px",
      align: "end",
      cell: (row) => (row.kind === "default" ? <span className="text-g-muted">{EMPTY}</span> : <span className="tabular-nums">{exceptionsOf(row.serviceId)}</span>),
    },
    ...(usage === undefined
      ? []
      : [
          {
            id: "requests",
            header: "Requests, 7 days",
            width: "160px",
            align: "end" as const,
            cell: (row: ServiceRow) => {
              if (row.kind === "default" || row.serviceId === "*") return <span className="text-g-muted">{EMPTY}</span>;
              const seen = usage.services.get(row.serviceId);
              const events = seen?.events ?? 0;
              const share = events === 0 ? 0 : Math.round(((seen?.blocked ?? 0) / events) * 100);
              return (
                <span className="flex flex-col items-end" data-testid="service-usage">
                  <span className="tabular-nums">{events.toLocaleString("en-US")}</span>
                  <span className="text-13 tabular-nums text-g-muted">{share}% {usage.monitor ? "would be blocked" : "blocked"}</span>
                </span>
              );
            },
          },
        ]),
  ];

  const editingServiceId = serviceSheet.value === null || serviceSheet.value === NEW || serviceSheet.value === DEFAULT_ROW ? undefined : serviceSheet.value;
  const serviceKnown = editingServiceId !== undefined && ruled.includes(editingServiceId);

  const toggleSurface = (id: GuardSurfaceId, on: boolean) => {
    const surfaceBlocks = { ...draft.surfaceBlocks };
    if (on) surfaceBlocks[id] = true;
    else delete surfaceBlocks[id];
    void commit({ ...draft, surfaceBlocks }, on ? `${capital(SURFACE[id].noun)} is blocked from the next check-in.` : `${capital(SURFACE[id].noun)} is no longer blocked.`, { id, on });
  };

  const contentRows = draft.contentRules.filter((r) => needle === "" || r.name.toLowerCase().includes(needle) || detectorWords(r.detector).toLowerCase().includes(needle));
  const putContent = (rule: DraftContentRule): Draft => ({
    ...draft,
    contentRules: draft.contentRules.some((r) => r.key === rule.key) ? draft.contentRules.map((r) => (r.key === rule.key ? rule : r)) : [...draft.contentRules, rule],
  });
  const starters = startersFor(draft);
  const contentColumns: DataColumn<DraftContentRule>[] = [
    {
      id: "status",
      header: "Status",
      width: "128px",
      cell: (r) => {
        const word = CONTENT_STATUS[r.enabled ? r.action : "off"];
        return (
          <Pill tone={word.tone} data-testid="content-action" data-status={r.enabled ? r.action : "off"}>
            {word.label}
          </Pill>
        );
      },
    },
    { id: "rule", header: "Rule", cell: (r) => <CellTitle title={r.name} sub={detectorWords(r.detector)} /> },
    { id: "services", header: "Services", width: "22%", cell: (r) => <span className="line-clamp-2 text-14">{r.services === "*" ? "Every AI service" : r.services.map(serviceName).join(", ")}</span> },
    { id: "who", header: "Who", width: "20%", cell: (r) => <span className="line-clamp-2 text-14">{audienceWords(r.audience, groups)}</span> },
  ];
  const editingRule = ruleSheet.value === null || ruleSheet.value === NEW ? undefined : draft.contentRules.find((r) => r.key === ruleSheet.value);

  const heldDefault = useHeld(serviceSheet.value === DEFAULT_ROW ? DEFAULT_ROW : undefined);
  const heldService = useHeld(serviceSheet.value === NEW || serviceKnown ? serviceSheet.value : undefined);
  const heldServiceId = heldService.value === undefined || heldService.value === NEW ? undefined : heldService.value;
  const lastServiceSheet = React.useRef<ReturnType<typeof serviceSheetOf> | undefined>(undefined);
  const liveServiceSheet = heldServiceId !== undefined && ruled.includes(heldServiceId) ? serviceSheetOf(draft, heldServiceId) : undefined;
  if (liveServiceSheet !== undefined) lastServiceSheet.current = liveServiceSheet;
  const heldServiceSheet = heldServiceId === undefined ? undefined : (liveServiceSheet ?? (lastServiceSheet.current?.serviceId === heldServiceId ? lastServiceSheet.current : undefined));
  const heldServiceKnown = heldServiceSheet !== undefined;
  const heldRuleKey = useHeld(ruleSheet.value === NEW || editingRule !== undefined ? ruleSheet.value : undefined);
  const lastRule = React.useRef<DraftContentRule | undefined>(undefined);
  if (editingRule !== undefined) lastRule.current = editingRule;
  const heldRule = heldRuleKey.value === undefined || heldRuleKey.value === NEW ? undefined : (draft.contentRules.find((r) => r.key === heldRuleKey.value) ?? lastRule.current);
  const heldDeleting = useHeld(deleting);
  const deletingWords = heldDeleting.value?.name ?? "";

  return (
    <div data-testid="rules-page" className="flex flex-col">
      <PageHeader
        tabs={
          <SegmentedTabs
            label="Rule views"
            value={tab}
            items={[
              { value: "services", label: "Services", icon: GlobeIcon, to: "/rules" },
              { value: "content", label: "Content", icon: ScanTextIcon, to: "/rules?tab=content" },
            ]}
          />
        }
        actions={
          <ActionButton variant="primary" icon={PlusIcon} onClick={() => (tab === "content" ? ruleSheet.open(NEW) : serviceSheet.open(NEW))} data-testid={tab === "content" ? "add-content-rule" : "add-service-rule"}>
            Add rule
          </ActionButton>
        }
      />

      {page.clientMode === "monitor" ? (
        <Notice tone="info" data-testid="rules-monitor">
          Monitoring only: rules are not enforced. Connections Guard cannot inspect are still blocked unless you allow them under Uninspectable TLS in Settings.{" "}
          <Link to="/settings" className="font-medium underline underline-offset-2">
            Switch to enforce in Settings
          </Link>{" "}
          once the staff notice has gone out.
        </Notice>
      ) : null}
      {stale ? (
        <Notice tone="warn" data-testid="rules-stale">
          The rules changed since you opened this page; reload to see them. Nothing you just changed was sent.{" "}
          <button type="button" className="font-medium underline underline-offset-2" onClick={onReload}>
            Reload
          </button>
        </Notice>
      ) : null}
      {problem === undefined ? null : (
        <Notice tone="bad" data-testid="rules-problem">
          {problem}
        </Notice>
      )}

      <ListToolbar
        search={{ value: q, onChange: setQ, placeholder: tab === "content" ? "Search content rules…" : "Search services…" }}
        action={
          <>
            {page.updatedAt === undefined ? null : (
              <span data-testid="rules-saved" className="text-12 text-g-muted max-md:hidden">
                v{page.document.version} · Saved {absoluteWords(page.updatedAt)}
                {page.updatedBy === undefined ? "" : ` by ${page.updatedBy}`}
              </span>
            )}
            {tab === "content" && starters.length > 0 ? (
              <ActionButton icon={SparklesIcon} loading={busy} onClick={() => void commit({ ...draft, contentRules: [...draft.contentRules, ...starters] }, "Added the starter rules.")} data-testid="add-starters">
                Add starters ({starters.length})
              </ActionButton>
            ) : null}
          </>
        }
      />

      {tab === "services" ? (
        <>
          <div data-testid="service-rules">
            <DataTable<ServiceRow>
              label="Service rules"
              rows={serviceRows}
              rowKey={(r) => (r.kind === "default" ? DEFAULT_ROW : r.serviceId)}
              columns={serviceColumns}
              onRowClick={(r) => serviceSheet.open(r.kind === "default" ? DEFAULT_ROW : r.serviceId)}
              rowLabel={(r) => (r.kind === "default" ? "Any other AI service, edit" : `${serviceName(r.serviceId)}, edit`)}
              minWidth={640}
              empty={
                <EmptyState
                  title={`No service matches “${q.trim()}”`}
                  description="Try a different search, or clear it to see every service rule."
                  action={
                    <ActionButton static onClick={() => setQ("")}>
                      Clear search
                    </ActionButton>
                  }
                />
              }
            />
            {ruled.length === 0 ? (
              <p data-testid="service-rules-empty" className="mt-3 max-w-[72ch] text-13 text-pretty text-g-muted">
                No service rules yet. Every AI service follows the default. Add a rule to block one for a team, or to allow one the default blocks.
              </p>
            ) : null}
          </div>

          <SettingsSection
            className="mt-10"
            title="Apps and websites"
            description="Block a chat app or website for everyone, on top of the rules above. Guard stops only the chat requests it has tested. Other browsers, uploads, voice and connectors are not covered, and every active laptop must first run a Guard version that supports the switch."
          >
            <SettingsCard data-testid="surface-blocks">
              {GUARD_SURFACE_IDS.map((id) => {
                const on = draft.surfaceBlocks?.[id] === true;
                const available = GUARD_ACTIVATABLE_SURFACES.includes(id);
                return (
                  <SettingsRow
                    key={id}
                    title={surfaceTitle(id)}
                    description={available ? SURFACE[id].description : "Not available yet."}
                    problem={surfaceProblem?.id === id ? surfaceProblem.words : undefined}
                    control={{ kind: "toggle", checked: on, disabled: busy || (!available && !on), onCheckedChange: (next) => toggleSurface(id, next) }}
                  />
                );
              })}
            </SettingsCard>
          </SettingsSection>
        </>
      ) : (
        <div data-testid="content-rules">
          <DataTable<DraftContentRule>
            label="Content rules"
            rows={contentRows}
            rowKey={(r) => r.key}
            columns={contentColumns}
            onRowClick={(r) => ruleSheet.open(r.key)}
            rowLabel={(r) => `${r.name}, edit`}
            rowMenu={(r) => [
              { label: "Edit", icon: PencilIcon, onSelect: () => ruleSheet.open(r.key) },
              { label: r.enabled ? "Turn off" : "Turn on", icon: PowerIcon, onSelect: () => void commit(putContent({ ...r, enabled: !r.enabled }), r.enabled ? `“${r.name}” is off.` : `“${r.name}” is on.`) },
              { label: "Delete…", icon: Trash2Icon, destructive: true, separatorBefore: true, onSelect: () => setDeleting({ kind: "content", key: r.key, name: r.name }) },
            ]}
            menuLabel={(r) => `Actions for ${r.name}`}
            minWidth={720}
            empty={
              draft.contentRules.length === 0 ? (
                <div data-testid="content-rules-empty">
                  <EmptyState
                    icon={ScanTextIcon}
                    title="No content rules yet"
                    description="Start from the starters: tax file, Medicare and card numbers and secrets blocked, ABNs recorded, bulk emails and spreadsheets sent to IT."
                    action={
                      <ActionButton icon={SparklesIcon} loading={busy} onClick={() => void commit({ ...draft, contentRules: [...draft.contentRules, ...starters] }, "Added the starter rules.")}>
                        Add the starters
                      </ActionButton>
                    }
                  />
                </div>
              ) : (
                <EmptyState
                  title={`No content rule matches “${q.trim()}”`}
                  description="Try a different search, or clear it to see every content rule."
                  action={
                    <ActionButton static onClick={() => setQ("")}>
                      Clear search
                    </ActionButton>
                  }
                />
              )
            }
          />
        </div>
      )}

      {heldDefault.value === undefined ? null : (
        <DefaultActionSheet
          open={heldDefault.open}
          value={draft.defaultAction}
          busy={busy}
          {...(sheetError === undefined ? {} : { error: sheetError })}
          onClose={closeSheets}
          onSave={(defaultAction: GuardFlowAction) => void commitAndClose({ ...draft, defaultAction })}
        />
      )}
      {heldService.value === undefined ? null : (
        <ServiceRuleSheet
          key={heldService.value}
          open={heldService.open}
          sheet={heldServiceSheet}
          services={page.services}
          choices={choices}
          groups={page.groups}
          defaultAction={draft.defaultAction}
          busy={busy}
          {...(sheetError === undefined ? {} : { error: sheetError })}
          onClose={closeSheets}
          onSave={(serviceId: string, rules: DraftServiceRule[]) => void commitAndClose(withServiceRules(draft, serviceId, rules))}
        >
          {heldServiceKnown && heldServiceId !== undefined ? (
            <>
              <ActionButton variant="danger" icon={Trash2Icon} className="self-start" onClick={() => setDeleting({ kind: "service", serviceId: heldServiceId, name: serviceName(heldServiceId) })}>
                Remove every rule for this service…
              </ActionButton>
              {heldServiceId === "*" ? null : <TestBox services={page.services} initialServiceId={heldServiceId} note="Changes in this sheet count once saved." />}
            </>
          ) : null}
        </ServiceRuleSheet>
      )}
      {heldRuleKey.value === undefined ? null : (
        <ContentRuleSheet
          key={heldRuleKey.value}
          open={heldRuleKey.open}
          rule={heldRule}
          services={page.services}
          groups={page.groups}
          busy={busy}
          {...(sheetError === undefined ? {} : { error: sheetError })}
          onClose={closeSheets}
          onSave={(rule) => void commitAndClose(putContent(rule))}
        >
          <TestBox services={page.services} note="Changes in this sheet count once saved." />
        </ContentRuleSheet>
      )}

      {heldDeleting.value === undefined ? null : (
        <ConfirmModal
          open={heldDeleting.open}
          onClose={() => setDeleting(undefined)}
          title={heldDeleting.value.kind === "service" ? `Remove every rule for ${deletingWords}?` : `Delete “${deletingWords}”?`}
          confirmLabel={heldDeleting.value.kind === "service" ? "Remove rules" : "Delete rule"}
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={() => {
            if (deleting === undefined) return;
            const next: Draft =
              deleting.kind === "service" ? withServiceRules(draft, deleting.serviceId, []) : { ...draft, contentRules: draft.contentRules.filter((r) => r.key !== deleting.key) };
            void commit(next, deleting.kind === "service" ? `${deletingWords} follows the default again.` : `Deleted “${deletingWords}”.`).then((ok) => {
              setDeleting(undefined);
              if (ok) closeSheets();
            });
          }}
        >
          {heldDeleting.value.kind === "service" ? "The service follows the default again from the laptops’ next check-in." : "Laptops stop checking for it from their next check-in."}
        </ConfirmModal>
      )}
    </div>
  );
}
