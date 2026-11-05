import * as React from "react";
import { Link, useNavigate } from "react-router";
import { ActivityIcon, EyeIcon, LaptopIcon, ListIcon } from "lucide-react";
import type { GuardEventRow, GuardOverviewPage, GuardOverviewService } from "@vibtra/guard-contract";
import { guard } from "../api/guard";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import {
  ActionButton,
  actionButtonClass,
  CellTitle,
  CountBadge,
  DataTable,
  EmptyState,
  EMPTY,
  ListToolbar,
  Modal,
  ModalFooter,
  PageHeader,
  SegmentedTabs,
  SheetList,
  SheetListRow,
  StatCard,
  StatRow,
  cn,
  useHeld,
} from "@/components/kit";
import { AppCell, BannerCard, DecisionPill, PageLoading, PersonLine, ServiceTile, TableFoot } from "../guard/parts";
import { When, bytesWords, categoryWord, plural } from "../guard/words";

type View = "services" | "apps" | "blocks" | "latest";
type Window = "7" | "30";

const fmt = (n: number): string => n.toLocaleString("en-US");
const BLOCK_KIND: Record<GuardOverviewPage["topBlocks"][number]["kind"], string> = { content: "Content rule", service: "Service rule", default: "Default" };

interface UserOfService {
  userId: string;
  email: string;
  name?: string;
  hosts: string[];
  lastAt: string;
  events: number;
}

const usersOf = (rows: readonly GuardEventRow[]): UserOfService[] => {
  const byId = new Map<string, UserOfService>();
  for (const e of rows) {
    const was = byId.get(e.person.userId);
    const host = e.hostname ?? e.deviceId;
    if (was === undefined) {
      byId.set(e.person.userId, { userId: e.person.userId, email: e.person.email, ...(e.person.name === undefined ? {} : { name: e.person.name }), hosts: [host], lastAt: e.occurredAt, events: 1 });
      continue;
    }
    was.events += 1;
    if (!was.hosts.includes(host)) was.hosts.push(host);
    if (e.occurredAt > was.lastAt) was.lastAt = e.occurredAt;
  }
  return [...byId.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt));
};

const windowStart = (page: GuardOverviewPage): string => {
  const day = page.trend[0]?.day;
  return day === undefined ? new Date(Date.now() - page.windowDays * 86_400_000).toISOString() : `${day}T00:00:00.000Z`;
};

export function ServicePeopleModal({
  open,
  service,
  windowDays,
  since,
  onClose,
}: {
  open: boolean;
  service: GuardOverviewService;
  windowDays: number;
  since: string;
  onClose: () => void;
}) {
  const door = useDoor(() => guard.activity({ serviceId: service.serviceId, limit: 200 }), [service.serviceId]);
  const people = door.state.status === "ready" ? usersOf(door.state.data.rows.filter((e) => e.occurredAt >= since)) : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="list"
      role="dialog"
      title={`People using ${service.name}`}
      description={`In the last ${windowDays} days`}
      footer={
        <ModalFooter start={<ActionButton onClick={onClose}>Close</ActionButton>}>
          <Link to={`/activity?serviceId=${encodeURIComponent(service.serviceId)}`} className={actionButtonClass("secondary")}>
            Open in Activity
          </Link>
        </ModalFooter>
      }
    >
      <div data-testid="service-people" className="flex flex-col gap-3">
        {door.state.status === "loading" ? (
          <DoorSkeleton rows={2} />
        ) : door.state.status === "error" ? (
          <DoorError error={door.state.error} onRetry={door.reload} />
        ) : people.length === 0 ? (
          <EmptyState icon={ActivityIcon} title="No one yet" description={`No event names ${service.name} in the last ${windowDays} days.`} className="py-6" />
        ) : (
          <>
            <SheetList
              label={`People using ${service.name}`}
              items={people}
              itemKey={(p) => p.userId}
              render={(p) => (
                <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
                  <span className="min-w-0 flex-1">
                    <PersonLine email={p.email} name={p.name} sub={`${p.name === undefined ? "" : `${p.email} · `}${p.hosts.join(", ")}`} />
                  </span>
                  <span className="shrink-0 text-13 text-g-muted">
                    Last used <When iso={p.lastAt} />
                  </span>
                </div>
              )}
            />
            {door.state.data.nextCursor === undefined ? null : <p className="text-12 text-g-muted">From the newest 200 events.</p>}
          </>
        )}
      </div>
    </Modal>
  );
}

export function Overview() {
  const navigate = useNavigate();
  const [days, setDays] = React.useState<Window>("7");
  const [view, setView] = React.useState<View>("services");
  const [query, setQuery] = React.useState("");
  const [peopleOf, setPeopleOf] = React.useState<GuardOverviewService | undefined>(undefined);
  const door = useDoor(() => guard.overview(days === "30" ? 30 : 7), [days]);
  const heldPeopleOf = useHeld(peopleOf);

  const period = (
    <SegmentedTabs<Window>
      size="list"
      label="Window"
      value={days}
      onValueChange={setDays}
      items={[
        { value: "7", label: "7 days" },
        { value: "30", label: "30 days" },
      ]}
    />
  );

  if (door.state.status === "loading") return <PageLoading />;
  if (door.state.status === "error")
    return (
      <div className="flex flex-col">
        <PageHeader actions={period} />
        <DoorError error={door.state.error} onRetry={door.reload} />
      </div>
    );
  const page = door.state.data;
  const t = page.totals;
  const q = query.trim().toLowerCase();
  const has = (...values: (string | undefined)[]) => q === "" || values.some((v) => v !== undefined && v.toLowerCase().includes(q));
  const services = page.services.filter((s) => has(s.name, s.serviceId, categoryWord(s.category)));
  const apps = page.topApps.filter((a) => has(a.app, a.bundleId));
  const blocks = page.topBlocks.filter((b) => has(b.ruleName, BLOCK_KIND[b.kind]));
  const latest = page.recent.filter((e) => has(e.person.name, e.person.email, e.serviceName, e.serviceId, e.app?.name, e.ruleName));
  const nothing = (what: string) =>
    q === "" ? undefined : (
      <EmptyState
        title={`No ${what} matches “${query.trim()}”`}
        description="Try a different search, or clear it to see the whole list."
        action={
          <ActionButton static onClick={() => setQuery("")}>
            Clear search
          </ActionButton>
        }
      />
    );

  return (
    <div data-testid="overview-page" className="flex flex-col">
      <PageHeader actions={period} className="mb-4" />

      {page.noDevicesYet ? (
        <BannerCard
          data-testid="overview-no-devices"
          icon={LaptopIcon}
          title="No laptop has checked in yet"
          description="Enrol a laptop and this page fills in: the AI services it reaches, from which apps, and what the rules stop."
          action={
            <Link to="/devices?enrol=1" className={actionButtonClass("primary")} data-testid="overview-enrol">
              Enrol the first laptop
            </Link>
          }
        />
      ) : null}

      {page.clientMode === "monitor" ? (
        <BannerCard
          data-testid="overview-monitor"
          icon={EyeIcon}
          title="Monitoring only: rules aren't enforced yet"
          description="Counts include rule decisions and connections blocked because inspection was unavailable."
          action={
            <Link to="/settings" className={actionButtonClass("primary")}>
              Switch to enforce
            </Link>
          }
        />
      ) : null}

      <StatRow label={`Totals for the last ${page.windowDays} days`}>
        <StatCard label="AI services seen" value={fmt(t.services)} />
        <StatCard label="People using AI" value={fmt(t.people)} />
        <StatCard label={page.clientMode === "monitor" ? "Would have blocked" : "Blocked"} value={fmt(t.blocked)} />
        <StatCard label="Devices" value={fmt(t.devices)} />
      </StatRow>

      <ListToolbar
        views={
          <SegmentedTabs<View>
            size="list"
            label="Overview lists"
            idPrefix="ov"
            value={view}
            onValueChange={(next) => {
              setView(next);
              setQuery("");
            }}
            items={[
              { value: "services", label: "Services" },
              { value: "apps", label: "Apps" },
              { value: "blocks", label: "Blocks" },
              { value: "latest", label: "Latest" },
            ]}
          />
        }
        search={{
          value: query,
          onChange: setQuery,
          placeholder: view === "services" ? "Search services" : view === "apps" ? "Search apps" : view === "blocks" ? "Search rules" : "Search people and services",
        }}
      />

      <div role="tabpanel" id={`ov-panel-${view}`} aria-labelledby={`ov-tab-${view}`}>
        {view === "services" ? (
          <DataTable<GuardOverviewService>
            label="AI services in use"
            rows={services}
            rowKey={(s) => s.serviceId}
            minWidth={760}
            onRowClick={setPeopleOf}
            rowLabel={(s) => `${s.name}, people using it`}
            rowMenu={(s) => [
              { label: "View details", icon: EyeIcon, onSelect: () => setPeopleOf(s) },
              { label: "View activity", icon: ListIcon, onSelect: () => navigate(`/activity?serviceId=${encodeURIComponent(s.serviceId)}`) },
            ]}
            menuLabel={(s) => `Actions for ${s.name}`}
            empty={
              nothing("service") ?? (
                <EmptyState
                  data-testid="overview-services-empty"
                  icon={ActivityIcon}
                  title="No AI service reached yet"
                  description={`When an enrolled laptop reaches a catalogued AI service in the last ${page.windowDays} days, it is listed here.`}
                />
              )
            }
            columns={[
              {
                id: "service",
                header: "Service",
                cell: (s) => (
                  <span data-testid="overview-service-row" className="block min-w-0">
                    <CellTitle icon={<ServiceTile serviceId={s.serviceId} />} title={s.name} sub={`${categoryWord(s.category)} · ${plural(s.events, "event", "events")}`} />
                  </span>
                ),
              },
              { id: "people", header: "People", width: "96px", cell: (s) => <CountBadge count={s.people} /> },
              { id: "devices", header: "Devices", width: "96px", cell: (s) => <CountBadge count={s.devices} /> },
              { id: "blocked", header: page.clientMode === "monitor" ? "Would block" : "Blocked", width: "96px", cell: (s) => <span className={cn("tabular-nums", s.blocked === 0 ? "text-g-muted" : page.clientMode === "monitor" ? undefined : "text-g-danger")}>{fmt(s.blocked)}</span> },
              { id: "sent", header: "Sent", width: "96px", cell: (s) => <span className="tabular-nums">{bytesWords(s.bytes)}</span> },
              { id: "last", header: "Last used", width: "128px", cell: (s) => (s.lastSeenAt === undefined ? <span className="text-g-muted">{EMPTY}</span> : <When iso={s.lastSeenAt} />) },
            ]}
          />
        ) : view === "apps" ? (
          <DataTable
            label="Apps that reached AI services"
            rows={apps}
            rowKey={(a) => `${a.app}:${a.bundleId ?? ""}`}
            minWidth={560}
            empty={nothing("app") ?? <EmptyState data-testid="overview-apps-empty" icon={ActivityIcon} title="No apps yet" description="No app reached an AI service in this window." />}
            columns={[
              { id: "app", header: "App", cell: (a) => <AppCell app={{ name: a.app, ...(a.bundleId === undefined ? {} : { bundleId: a.bundleId }) }} /> },
              { id: "events", header: "Events", width: "128px", cell: (a) => <span className="tabular-nums">{fmt(a.events)}</span> },
            ]}
          />
        ) : view === "blocks" ? (
          <DataTable
            label="Rules that blocked the most"
            rows={blocks}
            rowKey={(b) => `${b.kind}:${b.ruleId ?? b.ruleName}`}
            minWidth={560}
            empty={nothing("rule") ?? <EmptyState data-testid="overview-blocks-empty" icon={ActivityIcon} title="Nothing blocked" description="Nothing was blocked in this window." />}
            columns={[
              { id: "rule", header: "Rule", cell: (b) => <CellTitle title={b.ruleName} sub={BLOCK_KIND[b.kind]} /> },
              { id: "count", header: page.clientMode === "monitor" ? "Would have blocked" : "Blocked", width: "160px", cell: (b) => <span className="tabular-nums">{fmt(b.count)}</span> },
            ]}
          />
        ) : (
          <DataTable<GuardEventRow>
            label="Latest decisions"
            rows={latest}
            rowKey={(e) => e.eventId}
            minWidth={720}
            onRowClick={(e) => navigate(`/activity?event=${encodeURIComponent(e.eventId)}`)}
            rowLabel={(e) => `${e.person.name ?? e.person.email}, ${e.serviceName ?? e.serviceId ?? "agent"}, details`}
            empty={nothing("event") ?? <EmptyState data-testid="overview-recent-empty" icon={ActivityIcon} title="No events yet" description="Decisions show up here once laptops report them." />}
            columns={[
              { id: "decision", header: "Decision", width: "128px", cell: (e) => <DecisionPill action={e.action} /> },
              { id: "person", header: "Person", cell: (e) => <PersonLine email={e.person.email} name={e.person.name} /> },
              {
                id: "service",
                header: "Service",
                cell: (e) => <CellTitle icon={<ServiceTile serviceId={e.serviceId} />} title={e.serviceName ?? e.serviceId ?? e.host ?? "The agent"} sub={e.ruleName} />,
              },
              { id: "when", header: "When", width: "128px", cell: (e) => <When iso={e.occurredAt} className="text-g-muted" /> },
            ]}
          />
        )}
        {view === "latest" && page.recent.length > 0 ? (
          <TableFoot>
            <Link to="/activity" className="font-medium text-g-ink underline decoration-g-line underline-offset-2 hover:decoration-g-ink">
              All activity
            </Link>
          </TableFoot>
        ) : null}
      </div>

      {heldPeopleOf.value === undefined ? null : (
        <ServicePeopleModal open={heldPeopleOf.open} service={heldPeopleOf.value} windowDays={page.windowDays} since={windowStart(page)} onClose={() => setPeopleOf(undefined)} />
      )}
    </div>
  );
}
