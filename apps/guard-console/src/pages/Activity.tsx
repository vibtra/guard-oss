import * as React from "react";
import { Link, useSearchParams } from "react-router";
import { ActivityIcon, CopyIcon, LaptopIcon, ShieldCheckIcon, UserIcon } from "lucide-react";
import { GUARD_EVENT_ACTIONS, type GuardActivityPage, type GuardDeviceRow, type GuardEventAction, type GuardEventRow } from "@vibtra/guard-contract";
import type { ConsolePeoplePage, ConsolePersonRow } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { relativeTo } from "../govern/format";
import {
  ActionButton,
  actionButtonClass,
  CellTitle,
  DataTable,
  DetailSheet,
  EmptyState,
  EMPTY,
  FilterPopover,
  ListToolbar,
  Pill,
  SegmentedTabs,
  SheetDefinitions,
  SheetList,
  SheetListRow,
  SheetSection,
  useHeld,
  useSheetParam,
  type FilterFacet,
} from "@/components/kit";
import { copyToClipboard } from "@/lib/copy";
import { ACTION_WORD, DETECTOR_WORD, When, absoluteWords, appWords, bytesWords, dayTimeWords, matchWords, plural } from "../guard/words";
import { AppCell, DecisionPill, PersonLine, ServiceTile, TableFoot } from "../guard/parts";
import { DevicePill, dateWords } from "../people/fleet";

const PAGE_SIZE = 50;
type View = "all" | "blocked" | "asked" | "allowed";
type SheetTab = "decision" | "person" | "device";

const settle = <T,>(load: () => Promise<T>): Promise<T | undefined> => {
  try {
    return load().catch(() => undefined);
  } catch {
    return Promise.resolve(undefined);
  }
};

function useSettled(value: string, ms = 300): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

const isAction = (value: string | null): value is GuardEventAction => value !== null && (GUARD_EVENT_ACTIONS as readonly string[]).includes(value);

const single =
  (current: string | null, set: (next: string | null) => void) =>
  (next: string[]): void =>
    set(next.length === 0 ? null : (next.find((v) => v !== current) ?? next[0] ?? null));

function Copyable({ value, what, children }: { value: string; what: string; children?: React.ReactNode }) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="min-w-0 break-all">{children ?? value}</span>
      <button
        type="button"
        aria-label={`Copy the ${what.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())}`}
        onClick={() => copyToClipboard(value, what)}
        className="focus-knox inline-flex size-6 shrink-0 items-center justify-center rounded-md text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur-fast) hover:bg-g-tint hover:text-g-ink"
      >
        <CopyIcon aria-hidden className="size-3.5" />
      </button>
    </span>
  );
}

const decidedBy = (e: GuardEventRow): string => {
  const by = e.ruleKind === undefined ? undefined : e.ruleKind === "default" ? "the default" : e.ruleKind === "exception" ? "a grant" : `a ${e.ruleKind} rule`;
  switch (e.action) {
    case "observed":
      return "Observed";
    case "requested":
      return `Access requested from the block page${e.ruleKind === undefined ? "" : ` (${by})`}`;
    case "asked":
      return `Held for approval${by === undefined ? "" : ` by ${by}`}`;
    default:
      return `${ACTION_WORD[e.action].label}${by === undefined ? "" : ` by ${by}`}`;
  }
};

export function eventDetails(e: GuardEventRow): { label: string; value: React.ReactNode }[] {
  const rows: { label: string; value: React.ReactNode }[] = [{ label: "Decision", value: decidedBy(e) }];
  if (e.ruleName !== undefined || e.ruleId !== undefined) rows.push({ label: "Rule", value: e.ruleId === undefined ? e.ruleName : <Copyable value={e.ruleId} what="Rule ID">{e.ruleName ?? e.ruleId}</Copyable> });
  if (e.matchType !== undefined) rows.push({ label: "Matched", value: `${DETECTOR_WORD[e.matchType]}${e.matchCount === undefined ? "" : `, ${plural(e.matchCount, "time", "times")}`}` });
  if (e.snippet !== undefined) rows.push({ label: "Redacted example", value: <span className="font-mono text-13">{e.snippet}</span> });
  rows.push({
    label: "App",
    value: <span>{[appWords(e.app), e.app?.bundleId, e.app?.cli === undefined ? undefined : `CLI ${e.app.cli}`].filter((v) => v !== undefined).join(" · ")}</span>,
  });
  rows.push({ label: "Service", value: e.serviceName ?? e.serviceId ?? "None (an agent event)" });
  if (e.host !== undefined) rows.push({ label: "Host", value: `${e.host}${e.port === undefined || e.port === 443 ? "" : `:${e.port}`}${e.method === undefined ? "" : ` · ${e.method}`}${e.pathHint === undefined ? "" : ` ${e.pathHint}`}` });
  rows.push({ label: "Device", value: <Copyable value={e.deviceId} what="Device ID">{e.hostname ?? e.deviceId}</Copyable> });
  if (e.bytes !== undefined) rows.push({ label: e.method === "WEBSOCKET" ? "Message size" : "Request size", value: bytesWords(e.bytes) });
  if (e.requestId !== undefined) rows.push({ label: "Request", value: <Copyable value={e.requestId} what="Request ID" /> });
  if (e.reason !== undefined) rows.push({ label: "Reason", value: e.reason });
  if (e.bundleVersion !== undefined) rows.push({ label: "Rules version", value: String(e.bundleVersion) });
  rows.push({ label: "When", value: `${absoluteWords(e.occurredAt)} (received ${absoluteWords(e.receivedAt)})` });
  rows.push({ label: "Decision ID", value: <Copyable value={e.eventId} what="Decision ID"><span className="font-mono text-13">{e.eventId}</span></Copyable> });
  return rows;
}

const ROLE_WORD = { owner: "Owner", admin: "Admin", member: "Member" } as const;

function PersonTab({ event, person, rows, onFilter }: { event: GuardEventRow; person: ConsolePersonRow | undefined; rows: readonly GuardEventRow[]; onFilter: () => void }) {
  const theirs = rows.filter((r) => r.person.userId === event.person.userId).slice(0, 5);
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <PersonLine email={person?.email ?? event.person.email} name={person?.name ?? event.person.name} image={person?.image} />
          <ActionButton onClick={onFilter}>Show their activity</ActionButton>
        </div>
        <SheetDefinitions
          rows={[
            { label: "Name", value: person?.name ?? event.person.name ?? EMPTY },
            { label: "Email", value: person?.email ?? event.person.email },
            { label: "Role", value: person === undefined ? EMPTY : ROLE_WORD[person.orgRole ?? person.role] },
            { label: "Joined", value: person === undefined ? EMPTY : dateWords(person.createdAt) },
          ]}
        />
      </section>
      <SheetSection title="Recent decisions">
        <SheetList
          label="Recent decisions for this person"
          items={theirs}
          itemKey={(r) => r.eventId}
          render={(r) => (
            <SheetListRow
              icon={<ServiceTile serviceId={r.serviceId} />}
              title={r.serviceName ?? r.serviceId ?? r.host ?? "The agent"}
              sub={
                <>
                  {appWords(r.app)} · <When iso={r.occurredAt} />
                </>
              }
              trailing={<DecisionPill action={r.action} />}
            />
          )}
        />
      </SheetSection>
    </div>
  );
}

function DeviceTab({ event, device, onFilter }: { event: GuardEventRow; device: GuardDeviceRow | undefined; onFilter: () => void }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ActionButton onClick={onFilter}>Show this device’s activity</ActionButton>
        {device === undefined ? null : (
          <Link to={`/devices?device=${encodeURIComponent(device.deviceId)}`} className={actionButtonClass("secondary")}>
            Open device
          </Link>
        )}
      </div>
      <SheetDefinitions
        rows={
          device === undefined
            ? [
                { label: "Name", value: event.hostname ?? EMPTY },
                { label: "Device ID", value: <Copyable value={event.deviceId} what="Device ID" /> },
              ]
            : [
                { label: "Name", value: device.hostname },
                { label: "Status", value: <DevicePill row={device} /> },
                { label: "Person", value: device.person.name === undefined ? device.person.email : `${device.person.name} (${device.person.email})` },
                { label: "Mode", value: device.clientMode === "monitor" ? "Monitor" : "Enforce" },
                { label: "Last seen", value: device.lastSeenAt === undefined ? "Never" : <When iso={device.lastSeenAt} /> },
                { label: "macOS", value: device.osVersion },
                { label: "Guard version", value: device.agentVersion },
                { label: "Model", value: device.modelIdentifier ?? EMPTY },
                { label: "Serial number", value: device.serialNumber === undefined ? EMPTY : <Copyable value={device.serialNumber} what="Serial number" /> },
              ]
        }
      />
    </section>
  );
}

type FilterKey = "serviceId" | "action" | "personUserId" | "deviceId" | "q";
const FILTER_KEYS: readonly FilterKey[] = ["serviceId", "action", "personUserId", "deviceId", "q"];

export function Activity() {
  const [params, setParams] = useSearchParams();
  const serviceId = params.get("serviceId");
  const rawAction = params.get("action");
  const action = isAction(rawAction) ? rawAction : null;
  const personUserId = params.get("personUserId");
  const deviceId = params.get("deviceId");
  const q = (params.get("q") ?? "").trim();
  const sheet = useSheetParam("event");

  const writeFilters = React.useCallback(
    (patch: Partial<Record<FilterKey, string | null>>, dropEvent = false) =>
      setParams(
        (was) => {
          const next = new URLSearchParams(was);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null || value === undefined || value === "") next.delete(key);
            else next.set(key, value);
          }
          if (dropEvent) next.delete("event");
          return next;
        },
        { replace: true },
      ),
    [setParams],
  );
  const setServiceId = (v: string | null) => writeFilters({ serviceId: v });
  const setAction = (v: string | null) => writeFilters({ action: v });
  const setPerson = (v: string | null) => writeFilters({ personUserId: v });
  const setDevice = (v: string | null) => writeFilters({ deviceId: v });

  const [typed, setTyped] = React.useState(q);
  const settled = useSettled(typed.trim());
  const wrote = React.useRef(q);
  const writer = React.useRef(writeFilters);
  writer.current = writeFilters;
  React.useEffect(() => {
    if (settled === wrote.current) return;
    wrote.current = settled;
    writer.current({ q: settled });
  }, [settled]);
  React.useEffect(() => {
    if (q === wrote.current) return;
    wrote.current = q;
    setTyped(q);
  }, [q]);
  const [tab, setTab] = React.useState<SheetTab>("decision");

  const filtersOf = () => ({
    ...(serviceId === null ? {} : { serviceId }),
    ...(isAction(action) ? { action } : {}),
    ...(personUserId === null ? {} : { personUserId }),
    ...(deviceId === null ? {} : { deviceId }),
    ...(q === "" ? {} : { q }),
  });
  const door = useDoor(() => guard.activity({ limit: PAGE_SIZE, ...filtersOf() }), [serviceId, action, personUserId, deviceId, q]);
  const options = useDoor(() => Promise.all([settle(() => guard.services()), settle(() => guard.people()), settle(() => guard.devices())]), []);
  const [services, peoplePage, devices] = options.state.status === "ready" ? options.state.data : [undefined, undefined, undefined];
  const peopleRows = (peoplePage as ConsolePeoplePage | undefined)?.rows ?? [];

  const [older, setOlder] = React.useState<GuardActivityPage[]>([]);
  const [loadingOlder, setLoadingOlder] = React.useState(false);
  React.useEffect(() => setOlder([]), [serviceId, action, personUserId, deviceId, q]);
  React.useEffect(() => {
    if (sheet.value !== null) setTab("decision");
  }, [sheet.value]);

  const first = door.state.status === "ready" ? door.state.data : undefined;
  const rows = first === undefined ? [] : [first, ...older].flatMap((p) => p.rows);
  const cursor = (older.at(-1) ?? first)?.nextCursor;
  const open = sheet.value === null ? undefined : rows.find((r) => r.eventId === sheet.value);
  const held = useHeld(open);
  const event = held.value;
  const filtered = serviceId !== null || action !== null || personUserId !== null || deviceId !== null || typed !== "";

  const loadMore = () => {
    if (cursor === undefined) return;
    setLoadingOlder(true);
    guard
      .activity({ limit: PAGE_SIZE, cursor, ...filtersOf() })
      .then((next) => setOlder((was) => [...was, next]))
      .catch(() => undefined)
      .finally(() => setLoadingOlder(false));
  };
  const reset = () => {
    wrote.current = "";
    setTyped("");
    writeFilters(Object.fromEntries(FILTER_KEYS.map((k) => [k, null])));
  };

  const facets: FilterFacet[] = [
    { id: "service", label: "Service", options: (services?.rows ?? []).map((s) => ({ value: s.serviceId, label: s.name })), selected: serviceId === null ? [] : [serviceId], onChange: single(serviceId, setServiceId) },
    { id: "action", label: "Decision", options: GUARD_EVENT_ACTIONS.map((a) => ({ value: a, label: ACTION_WORD[a].label })), selected: action === null ? [] : [action], onChange: single(action, setAction) },
    { id: "person", label: "Person", options: peopleRows.map((p) => ({ value: p.subject, label: p.name ?? p.email })), selected: personUserId === null ? [] : [personUserId], onChange: single(personUserId, setPerson) },
    { id: "device", label: "Device", options: (devices?.rows ?? []).map((d) => ({ value: d.deviceId, label: d.hostname })), selected: deviceId === null ? [] : [deviceId], onChange: single(deviceId, setDevice) },
  ];
  const view = (action ?? "all") as View;
  const count =
    first === undefined
      ? undefined
      : `${first.total === undefined ? plural(rows.length, "event", "events") : `${rows.length.toLocaleString()} of ${plural(first.total, "event", "events")}`}${cursor === undefined ? "" : " · more to load"}`;
  const personOf = (id: string) => peopleRows.find((p) => p.subject === id);
  const showOnly = (patch: Partial<Record<FilterKey, string>>) => () => writeFilters(patch, true);
  const missing = sheet.value !== null && door.state.status === "ready" && open === undefined;

  return (
    <div data-testid="activity-page" className="flex flex-col">
      <ListToolbar
        views={
          <SegmentedTabs<View>
            size="list"
            label="Decisions"
            idPrefix="act"
            value={view}
            onValueChange={(next) => setAction(next === "all" ? null : next)}
            items={[
              { value: "all", label: "All" },
              { value: "blocked", label: "Blocked" },
              { value: "asked", label: "Asked" },
              { value: "allowed", label: "Allowed" },
            ]}
          />
        }
        search={{ value: typed, onChange: setTyped, placeholder: "Search host, app, service, rule or person", label: "Search activity" }}
        filter={<FilterPopover facets={facets} label="Filter activity" />}
        action={filtered ? <ActionButton variant="ghost" onClick={reset}>Reset</ActionButton> : undefined}
      />

      <div role="tabpanel" id={`act-panel-${view}`} aria-labelledby={`act-tab-${view}`}>
        {door.state.status === "loading" ? (
          <DoorSkeleton rows={6} />
        ) : door.state.status === "error" ? (
          <DoorError error={door.state.error} onRetry={door.reload} />
        ) : (
          <>
            {missing ? (
              <p data-testid="activity-missing" role="status" className="mb-3 text-13 text-g-muted">
                That decision is not in the newest events. Load more or narrow the filters.
              </p>
            ) : null}
            <DataTable<GuardEventRow>
              label="Activity"
              rows={rows}
              rowKey={(e) => e.eventId}
              minWidth={1000}
              onRowClick={(e) => sheet.open(e.eventId)}
              rowLabel={(e) => `${e.person.name ?? e.person.email}, ${e.serviceName ?? e.serviceId ?? "agent"}, details`}
              empty={
                filtered ? (
                  <EmptyState
                    data-testid="activity-empty"
                    title={typed.trim() === "" ? "No events match these filters" : `No events match “${typed.trim()}”`}
                    description="Try a different search, or clear the search and filters to see every event."
                    action={
                      <ActionButton static onClick={reset}>
                        {typed.trim() === "" ? "Clear filters" : "Clear search"}
                      </ActionButton>
                    }
                  />
                ) : (
                  <EmptyState data-testid="activity-empty" icon={ActivityIcon} title="No activity yet" description="When an enrolled laptop reaches an AI service, each decision lands here." />
                )
              }
              columns={[
                { id: "decision", header: "Decision", width: "120px", cell: (e) => <DecisionPill action={e.action} /> },
                {
                  id: "person",
                  header: "Person",
                  width: "20%",
                  cell: (e) => {
                    const p = personOf(e.person.userId);
                    return <PersonLine email={p?.email ?? e.person.email} name={p?.name ?? e.person.name} image={p?.image} />;
                  },
                },
                { id: "app", header: "App", width: "24%", cell: (e) => <AppCell app={e.app} /> },
                {
                  id: "service",
                  header: "Service",
                  cell: (e) =>
                    e.serviceId === undefined && e.serviceName === undefined ? (
                      <span className="text-g-muted">{EMPTY}</span>
                    ) : (
                      <CellTitle icon={<ServiceTile serviceId={e.serviceId} />} title={<span data-testid="event-service-name">{e.serviceName ?? e.serviceId}</span>} sub={e.host} />
                    ),
                },
                {
                  id: "rule",
                  header: "Rule",
                  cell: (e) => <CellTitle title={e.ruleName ?? (e.ruleKind === "default" ? "Default" : <span className="font-normal text-g-muted">{EMPTY}</span>)} sub={matchWords(e)} />,
                },
                {
                  id: "when",
                  header: "When",
                  width: "140px",
                  cell: (e) => (
                    <span className="flex flex-col whitespace-nowrap">
                      <When iso={e.occurredAt} className="text-14 text-g-ink" />
                      <span className="text-13 text-g-muted">{dayTimeWords(e.occurredAt)}</span>
                    </span>
                  ),
                },
              ]}
            />
            {rows.length === 0 ? null : (
              <div className="mt-4 flex flex-col items-center gap-3">
                {cursor === undefined ? null : (
                  <ActionButton loading={loadingOlder} onClick={loadMore} data-testid="activity-load-more">
                    Load more
                  </ActionButton>
                )}
                {count === undefined ? null : <TableFoot className="mt-0">{count}</TableFoot>}
              </div>
            )}
          </>
        )}
      </div>

      {event === undefined ? null : (
        <DetailSheet<SheetTab>
          open={held.open}
          onClose={sheet.close}
          icon={<ServiceTile serviceId={event.serviceId} size="header" />}
          title={event.serviceName ?? event.serviceId ?? event.host ?? "The agent"}
          pills={
            <>
              <DecisionPill action={event.action} size="header" />
              {event.ruleName === undefined ? null : (
                <Pill size="header" tone="neutral">
                  {event.ruleName}
                </Pill>
              )}
            </>
          }
          sub={`${relativeTo(event.occurredAt)} · ${absoluteWords(event.occurredAt)}`}
          menu={[
            { label: "Copy decision ID", icon: CopyIcon, onSelect: () => copyToClipboard(event.eventId, "Decision ID") },
            { label: "Show this person’s activity", icon: UserIcon, onSelect: showOnly({ personUserId: event.person.userId }) },
            { label: "Show this device’s activity", icon: LaptopIcon, onSelect: showOnly({ deviceId: event.deviceId }) },
          ]}
          menuLabel="Decision actions"
          tabsLabel="Decision sections"
          tabs={[
            { value: "decision", label: "Decision", icon: ShieldCheckIcon },
            { value: "person", label: "Person", icon: UserIcon },
            { value: "device", label: "Device", icon: LaptopIcon },
          ]}
          tab={tab}
          onTabChange={setTab}
        >
          <div data-testid="activity-details">
            {tab === "decision" ? (
              <div className="flex flex-col gap-3">
                <SheetDefinitions rows={eventDetails(event)} />
                <p className="text-13 text-g-muted">Guard keeps the rule, the kind of match and a count, and at most a redacted fragment. Never what was sent.</p>
              </div>
            ) : tab === "person" ? (
              <PersonTab event={event} person={personOf(event.person.userId)} rows={rows} onFilter={showOnly({ personUserId: event.person.userId })} />
            ) : (
              <DeviceTab event={event} device={devices?.rows.find((d) => d.deviceId === event.deviceId)} onFilter={showOnly({ deviceId: event.deviceId })} />
            )}
          </div>
        </DetailSheet>
      )}
    </div>
  );
}
