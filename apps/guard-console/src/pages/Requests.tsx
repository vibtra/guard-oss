import * as React from "react";
import { CopyIcon, EyeIcon, InboxIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsolePolicyGrantRow, ConsolePolicyRequestRow } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { refusalWords } from "../api/client";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { useShellCounts } from "../shell/counts";
import { When } from "../guard/words";
import { ServiceMark } from "../brand/BrandMark";
import { personWords, usePeopleIndex, type PersonFacts } from "@/components/patterns/PersonCell";
import { copyToClipboard } from "@/lib/copy";
import {
  ActionButton,
  CellTitle,
  ConfirmModal,
  DataTable,
  EMPTY,
  EmptyState,
  FilterPopover,
  ListToolbar,
  Pill,
  SegmentedTabs,
  useHeld,
  useSheetParam,
  type DataColumn,
  type RowMenuItem,
} from "@/components/kit";
import { PersonTitle } from "../people/fleet";
import { DecideSheet } from "../requests/DecideSheet";
import { REQUEST_STATUS, statusOf, subjectOf, subjectWords } from "../requests/words";

type View = "review" | "reviewed" | "grants";

function usePeople() {
  const door = useDoor(() => guard.people().catch(() => undefined), []);
  return usePeopleIndex(door.state.status === "ready" ? door.state.data?.rows : undefined);
}

export function Requests() {
  const [view, setView] = React.useState<View>("review");
  const [q, setQ] = React.useState("");
  const [statuses, setStatuses] = React.useState<string[]>([]);
  const pending = useDoor(() => guard.policyRequests("pending"), []);
  const people = usePeople();
  const sheet = useSheetParam("request");
  const counts = useShellCounts();
  const [decided, setDecided] = React.useState<ReadonlyMap<string, "approved" | "declined">>(() => new Map());

  const pendingRows = pending.state.status === "ready" ? pending.state.data.requests.filter((r) => r.kind === "guard") : undefined;
  const waiting = pendingRows?.filter((r) => !decided.has(r.id)).length;

  return (
    <div data-testid="requests-page">
      <ListToolbar
        views={
          <SegmentedTabs<View>
            size="list"
            label="Request views"
            value={view}
            onValueChange={(next) => {
              setView(next);
              setQ("");
              setStatuses([]);
            }}
            idPrefix="requests"
            items={[
              { value: "review", label: "Needs review", ...(waiting === undefined ? {} : { count: waiting }) },
              { value: "reviewed", label: "Reviewed" },
              { value: "grants", label: "Grants" },
            ]}
          />
        }
        search={{ value: q, onChange: setQ, placeholder: view === "grants" ? "Search grants…" : "Search requests…" }}
        filter={
          view === "reviewed" ? (
            <FilterPopover
              facets={[
                {
                  id: "status",
                  label: "Decision",
                  options: Object.entries(REQUEST_STATUS)
                    .filter(([value]) => value !== "pending")
                    .map(([value, s]) => ({ value, label: s.label })),
                  selected: statuses,
                  onChange: setStatuses,
                },
              ]}
            />
          ) : undefined
        }
      />
      <div role="tabpanel" id={`requests-panel-${view}`} aria-labelledby={`requests-tab-${view}`}>
        {view === "grants" ? (
          <GrantsView q={q} people={people} onClearSearch={() => setQ("")} />
        ) : (
          <AsksView
            key={view}
            view={view}
            q={q}
            statuses={statuses}
            people={people}
            pending={pending}
            decided={decided}
            sheetValue={sheet.value}
            onOpen={(r) => sheet.open(r.id)}
            onCloseSheet={sheet.close}
            onClearSearch={() => {
              setQ("");
              setStatuses([]);
            }}
            onDecided={(id, status) => {
              setDecided((held) => new Map(held).set(id, status));
              sheet.close();
              pending.reload();
              counts.refresh();
            }}
          />
        )}
      </div>
    </div>
  );
}

function AsksView({
  view,
  q,
  statuses,
  people,
  pending,
  decided,
  sheetValue,
  onOpen,
  onCloseSheet,
  onClearSearch,
  onDecided,
}: {
  view: "review" | "reviewed";
  q: string;
  statuses: readonly string[];
  people: Map<string, PersonFacts>;
  pending: ReturnType<typeof useDoor<Awaited<ReturnType<typeof guard.policyRequests>>>>;
  decided: ReadonlyMap<string, "approved" | "declined">;
  sheetValue: string | null;
  onOpen: (r: ConsolePolicyRequestRow) => void;
  onCloseSheet: () => void;
  onClearSearch: () => void;
  onDecided: (id: string, status: "approved" | "declined") => void;
}) {
  const all = useDoor(() => (view === "reviewed" ? guard.policyRequests() : Promise.resolve(undefined)), [view]);
  const door = view === "review" ? pending : all;
  const loaded = door.state.status === "ready" ? (door.state.data?.requests ?? []) : undefined;
  const missing = sheetValue !== null && loaded !== undefined && !loaded.some((r) => r.id === sheetValue);
  const single = useDoor(() => (missing && sheetValue !== null ? guard.policyRequest(sheetValue).catch(() => undefined) : Promise.resolve(undefined)), [missing, sheetValue]);
  const openRow =
    sheetValue === null || loaded === undefined
      ? undefined
      : (loaded.find((r) => r.id === sheetValue) ?? (single.state.status === "ready" ? single.state.data?.request : undefined));
  const held = useHeld(openRow);
  const heldStatus = held.value === undefined ? undefined : decided.get(held.value.id);
  const heldRequest = held.value === undefined || heldStatus === undefined ? held.value : { ...held.value, status: heldStatus };

  if (door.state.status === "loading") return <DoorSkeleton />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const now = Date.now();
  const withDecided = (loaded ?? [])
    .filter((r) => r.kind === "guard")
    .map((r) => {
      const status = decided.get(r.id);
      return status === undefined ? r : { ...r, status };
    });
  const needle = q.trim().toLowerCase();
  const who = (r: ConsolePolicyRequestRow): PersonFacts | undefined => people.get(r.requesterUserId);
  const rows = withDecided
    .filter((r) => (view === "review" ? true : r.status !== "pending"))
    .filter((r) => statuses.length === 0 || statuses.includes(r.status))
    .filter((r) => {
      if (needle === "") return true;
      const s = subjectOf(r.subject);
      return [r.words, who(r)?.name, who(r)?.email, s?.serviceName, s?.hostname, s?.ruleName].some((v) => v?.toLowerCase().includes(needle));
    })
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

  const menuFor = (r: ConsolePolicyRequestRow): RowMenuItem[] => [
    { label: r.status === "pending" ? "Review" : "View details", icon: EyeIcon, onSelect: () => onOpen(r) },
    { label: "Copy ID", icon: CopyIcon, onSelect: () => copyToClipboard(r.id, "Request ID"), separatorBefore: true },
  ];
  const columns: DataColumn<ConsolePolicyRequestRow>[] = [
    {
      id: "status",
      header: "Status",
      width: "130px",
      cell: (r) => (
        <Pill tone={statusOf(r.status).tone} data-testid="desk-status" data-status={r.status}>
          {statusOf(r.status).label}
        </Pill>
      ),
    },
    {
      id: "person",
      header: "Person",
      width: "24%",
      cell: (r) => {
        const p = who(r);
        return <PersonTitle email={p?.email ?? r.requesterUserId} name={p?.name} image={p?.image} />;
      },
    },
    {
      id: "service",
      header: "AI service",
      cell: (r) => {
        const s = subjectOf(r.subject);
        return <CellTitle icon={<ServiceMark serviceId={s?.serviceId} size="sm" />} title={subjectWords(r.subject)} sub={r.words} />;
      },
    },
    {
      id: "device",
      header: "Device",
      width: "18%",
      cell: (r) => {
        const s = subjectOf(r.subject);
        return s === undefined ? EMPTY : <CellTitle title={s.hostname ?? s.deviceId} sub={s.app} />;
      },
    },
    {
      id: "asked",
      header: "Requested",
      width: "130px",
      cell: (r) => <When iso={r.createdAt} now={now} />,
    },
  ];
  return (
    <>
      <DataTable<ConsolePolicyRequestRow>
        label={view === "review" ? "Requests to review" : "Reviewed requests"}
        rows={rows}
        rowKey={(r) => r.id}
        columns={columns}
        onRowClick={onOpen}
        rowLabel={(r) => `${personWords(r.requesterUserId, who(r))}: ${r.words}, ${r.status === "pending" ? "review" : "details"}`}
        rowMenu={menuFor}
        menuLabel={(r) => `Actions for ${r.words}`}
        minWidth={900}
        empty={
          <div data-testid="desk-empty">
            {needle !== "" || statuses.length > 0 ? (
              <EmptyState
                title={needle === "" ? "No requests match the filter" : `No requests match “${q.trim()}”`}
                description="Try a different search, or clear it to see every request."
                action={
                  <ActionButton static onClick={onClearSearch}>
                    {needle === "" ? "Clear filter" : "Clear search"}
                  </ActionButton>
                }
              />
            ) : view === "review" ? (
              <EmptyState icon={InboxIcon} title="Nothing waiting" description="When a laptop blocks something and the person asks for access, the request lands here." />
            ) : (
              <EmptyState icon={InboxIcon} title="No requests reviewed yet" description="Approved, declined and expired requests are kept here." />
            )}
          </div>
        }
      />
      {heldRequest === undefined ? null : (
        <DecideSheet
          key={heldRequest.id}
          open={held.open}
          request={heldRequest}
          person={who(heldRequest)}
          onClose={onCloseSheet}
          onDone={(status) => onDecided(heldRequest.id, status)}
        />
      )}
    </>
  );
}

function GrantsView({ q, people, onClearSearch }: { q: string; people: Map<string, PersonFacts>; onClearSearch: () => void }) {
  const door = useDoor(() => guard.policyGrants(), []);
  const [asking, setAsking] = React.useState<ConsolePolicyGrantRow | undefined>(undefined);
  const heldAsking = useHeld(asking);
  const [busy, setBusy] = React.useState(false);
  if (door.state.status === "loading") return <DoorSkeleton />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const needle = q.trim().toLowerCase();
  const everyone = (g: ConsolePolicyGrantRow) => g.scope === "org" || g.userId === undefined;
  const whoWords = (g: ConsolePolicyGrantRow) => (everyone(g) ? "Everyone" : personWords(g.userId as string, people.get(g.userId as string)));
  const grants = [...door.state.data.grants]
    .filter((g) => needle === "" || [whoWords(g), subjectWords(g.subject)].some((v) => v.toLowerCase().includes(needle)))
    .sort((a, b) => Number(b.live) - Number(a.live) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const revoke = async (grant: ConsolePolicyGrantRow) => {
    setBusy(true);
    try {
      await guard.revokeGrant(grant.id);
      toast.success("Revoked. Their laptop drops it at its next check-in.");
      door.reload();
    } catch (error) {
      toastError(`${exceptionWords(grant)} was not revoked`, refusalWords(error));
    } finally {
      setBusy(false);
      setAsking(undefined);
    }
  };
  const exceptionWords = (g: ConsolePolicyGrantRow) => `${whoWords(g) === "Everyone" ? "Everyone’s" : `${whoWords(g)}’s`} exception for ${subjectWords(g.subject)}`;
  const menuFor = (g: ConsolePolicyGrantRow): RowMenuItem[] => [
    { label: "Copy ID", icon: CopyIcon, onSelect: () => copyToClipboard(g.id, "Grant ID") },
    ...(g.live ? [{ label: "Revoke…", icon: Trash2Icon, onSelect: () => setAsking(g), destructive: true, separatorBefore: true, disabled: busy }] : []),
  ];
  const columns: DataColumn<ConsolePolicyGrantRow>[] = [
    {
      id: "state",
      header: "Status",
      width: "120px",
      cell: (g) => (
        <Pill tone={g.live ? "ok" : "muted"} data-testid="grant-state" data-live={g.live ? "true" : "false"}>
          {g.live ? "Active" : "Lapsed"}
        </Pill>
      ),
    },
    {
      id: "who",
      header: "Who",
      width: "26%",
      cell: (g) => {
        if (everyone(g)) return <CellTitle icon={<span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-g-line text-g-muted"><KeyRoundIcon className="size-4" /></span>} title="Everyone" />;
        const p = people.get(g.userId as string);
        return <PersonTitle email={p?.email ?? (g.userId as string)} name={p?.name} image={p?.image} />;
      },
    },
    {
      id: "what",
      header: "AI service",
      cell: (g) => <CellTitle icon={<ServiceMark serviceId={subjectOf(g.subject)?.serviceId} size="sm" />} title={subjectWords(g.subject)} />,
    },
    {
      id: "expires",
      header: "Expires",
      width: "150px",
      cell: (g) =>
        g.revokedAt !== undefined ? (
          <When iso={g.revokedAt} prefix="Revoked" />
        ) : g.expiresAt !== undefined ? (
          <When iso={g.expiresAt} />
        ) : (
          <span className="whitespace-nowrap">Until revoked</span>
        ),
    },
    { id: "by", header: "Approved by", width: "16%", cell: (g) => <span className="block truncate text-g-muted">{personWords(g.approvedBy, people.get(g.approvedBy))}</span> },
  ];
  return (
    <>
      <DataTable<ConsolePolicyGrantRow>
        label="Grants"
        rows={grants}
        rowKey={(g) => g.id}
        columns={columns}
        rowMenu={menuFor}
        menuLabel={(g) => `Actions for ${subjectWords(g.subject)}, ${whoWords(g)}`}
        minWidth={860}
        empty={
          <div data-testid="grants-empty">
            {needle === "" ? (
              <EmptyState icon={KeyRoundIcon} title="No grants" description="An approved request becomes a time-boxed grant. It is listed here until it expires or is revoked." />
            ) : (
              <EmptyState
                title={`No grants match “${q.trim()}”`}
                description="Try a different search, or clear it to see every grant."
                action={
                  <ActionButton static onClick={onClearSearch}>
                    Clear search
                  </ActionButton>
                }
              />
            )}
          </div>
        }
      />
      {heldAsking.value === undefined ? null : (
        <ConfirmModal
          open={heldAsking.open}
          onClose={() => setAsking(undefined)}
          title={`Revoke ${exceptionWords(heldAsking.value).replace(/^Everyone’s/, "everyone’s")}?`}
          confirmLabel="Revoke exception"
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={() => {
            if (heldAsking.value !== undefined) void revoke(heldAsking.value);
          }}
        >
          Their laptop drops it at its next check-in, about a minute. The rule applies again until someone approves a new request.
        </ConfirmModal>
      )}
    </>
  );
}
