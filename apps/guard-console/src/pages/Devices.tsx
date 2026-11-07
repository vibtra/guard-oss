import * as React from "react";
import { useSearchParams } from "react-router";
import {
  ActivityIcon,
  CopyIcon,
  EyeIcon,
  InfoIcon,
  LaptopIcon,
  LinkIcon,
  PackageIcon,
  PlusIcon,
  SparklesIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import {
  GUARD_ENROL_LINK_HOURS_DEFAULT,
  GUARD_ENROL_LINK_HOURS_MAX,
  type GuardDeviceRow,
  type GuardEnrolLink,
  type GuardEnrolLinksPage,
  type GuardEventRow,
} from "@vibtra/guard-contract";
import type { ConsolePeoplePage } from "@vibtra/console-api";
import { guard } from "../api/guard";
import { refusalWords } from "../api/client";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { useShellCounts } from "../shell/counts";
import { When, absoluteWords, appWords, minutesWords } from "../guard/words";
import { ServiceMark } from "../brand/BrandMark";
import { CodeBox } from "../devices/CodeBox";
import { DistributeSheet } from "../devices/distribute";
import { BannerCard } from "../guard/parts";
import { useOrg } from "../api/session";
import { CopyIconButton } from "@/components/patterns/CopyIconButton";
import { copyToClipboard } from "@/lib/copy";
import {
  ActionButton,
  CellTitle,
  ComboboxInput,
  ConfirmModal,
  DataTable,
  DetailSheet,
  EMPTY,
  EmptyState,
  Field,
  FieldStack,
  FilterPopover,
  FormSheet,
  IconTile,
  ListToolbar,
  PageHeader,
  Pill,
  RadioCards,
  SegmentedTabs,
  SelectInput,
  SheetDefinitions,
  StatCard,
  StatRow,
  TextInput,
  cn,
  useHeld,
  useSheetParam,
  type DataColumn,
  type RowMenuItem,
  type SelectOption,
} from "@/components/kit";
import { groupsDoor } from "../people/doors";
import { relativeTo } from "../govern/format";
import {
  DEVICE_STATES,
  DevicePill,
  EventList,
  EventPill,
  REASON_WORDS,
  UsageList,
  deviceState,
  groupsByEmail,
  interceptionOff,
  interceptionWords,
  seenWords,
  useEvents,
  type DeviceState,
} from "../people/fleet";

const EXPIRY_OPTIONS: SelectOption<string>[] = [
  { value: "1", label: "1 hour" },
  { value: "8", label: "8 hours" },
  { value: String(GUARD_ENROL_LINK_HOURS_DEFAULT), label: "24 hours" },
  { value: "72", label: "3 days" },
  { value: String(GUARD_ENROL_LINK_HOURS_MAX), label: "7 days" },
];

type View = "devices" | "links" | "activity";
type EnrolMethod = "link" | "terminal";
type LinkRow = GuardEnrolLinksPage["rows"][number];

const short = (hex: string | undefined, n = 8): string | undefined => (hex === undefined ? undefined : hex.replace(/:/g, "").slice(0, n).toLowerCase());

export function EnrolSheet({ open, serverUrl, onClose, onMinted }: { open: boolean; serverUrl: string; onClose: () => void; onMinted: () => void }) {
  const people = useDoor(() => guard.people().catch(() => undefined as ConsolePeoplePage | undefined), []);
  const rows = people.state.status === "ready" ? (people.state.data?.rows ?? []) : [];
  const [personEmail, setPersonEmail] = React.useState("");
  const [method, setMethod] = React.useState<EnrolMethod>("link");
  const [hours, setHours] = React.useState<number>(GUARD_ENROL_LINK_HOURS_DEFAULT);
  const [note, setNote] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [minted, setMinted] = React.useState<GuardEnrolLink | undefined>(undefined);
  const [needPerson, setNeedPerson] = React.useState(false);
  const personRef = React.useRef<HTMLInputElement>(null);
  const email = personEmail.trim().toLowerCase();

  React.useEffect(() => {
    if (open) return;
    setMinted(undefined);
    setPersonEmail("");
    setNote("");
    setNeedPerson(false);
  }, [open]);

  const mint = async () => {
    if (busy) return;
    if (email === "") {
      setNeedPerson(true);
      (personRef.current ?? document.getElementById("enrol-person"))?.focus();
      return;
    }
    setBusy(true);
    try {
      const link = await guard.createEnrolLink({ personEmail: email, expiresInHours: hours, ...(note.trim() === "" ? {} : { note: note.trim() }) });
      setMinted(link);
      onMinted();
    } catch (error) {
      toastError(`No enrol link was made for ${email}`, refusalWords(error));
    } finally {
      setBusy(false);
    }
  };

  const personAria = {
    "aria-invalid": needPerson ? true : undefined,
    "aria-describedby": needPerson ? "enrol-person-error" : "enrol-person-hint",
  } as const;
  const choosePerson = (value: string) => {
    setPersonEmail(value);
    setNeedPerson(false);
  };

  if (minted !== undefined) {
    const primary = method === "link" ? { label: "Enrol link", value: minted.url } : { label: "Enrol command", value: minted.command };
    const other = method === "link" ? { label: "Enrol command", value: minted.command } : { label: "Enrol link", value: minted.url };
    return (
      <FormSheet
        open={open}
        onClose={onClose}
        title={`Enrol ${minted.personEmail}’s laptop`}
        footer={
          <ActionButton variant="primary" className="flex-1" onClick={onClose}>
            Done
          </ActionButton>
        }
      >
        <div data-testid="enrol-dialog" className="flex flex-col gap-5">
          <div data-testid="enrol-minted" className="flex flex-col gap-5">
            <div className="flex flex-wrap gap-2">
              <Pill size="header" icon={LaptopIcon}>
                macOS
              </Pill>
              <Pill size="header" icon={method === "link" ? LinkIcon : SquareTerminalIcon}>
                {method === "link" ? "Link" : "Terminal"}
              </Pill>
            </div>
            <p className="text-14 text-g-muted">
              {method === "link"
                ? "Open the link on the laptop. The Vibtra Guard menu-bar app picks it up and enrols."
                : "Paste the command in Terminal on the laptop. Install Vibtra Guard there first."}{" "}
              It works once, until {absoluteWords(minted.expiresAt)}.
            </p>
            <CodeBox label={primary.label} value={primary.value} />
            <CodeBox label={other.label} value={other.value} />
            <div data-testid="enrol-once" className="flex items-start gap-2.5 rounded-g-card border border-g-line bg-g-header px-4 py-3 text-14 text-g-ink">
              <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-g-muted" />
              <span>This will not be shown again. Anyone with it can enrol a laptop as {minted.personEmail} until it is used or expires.</span>
            </div>
            <p className="text-12 text-g-muted">Server: {serverUrl}</p>
          </div>
        </div>
      </FormSheet>
    );
  }

  return (
    <FormSheet
      open={open}
      onClose={onClose}
      title="Enrol a laptop"
      description="Make a one-time link that enrols one laptop as one person."
      primaryLabel="Create link"
      onPrimary={() => void mint()}
      busy={busy}
    >
      <div data-testid="enrol-dialog">
        <FieldStack className="gap-6">
          <Field
            label="Person"
            htmlFor="enrol-person"
            hint={needPerson ? undefined : "The laptop’s activity is theirs, and their rules apply to it."}
            error={needPerson ? "Choose the person whose laptop this is." : undefined}
          >
            {rows.length > 0 ? (
              <ComboboxInput<string>
                id="enrol-person"
                placeholder="Search people"
                {...personAria}
                value={personEmail}
                onValueChange={choosePerson}
                options={rows.map((p) => ({
                  value: p.email,
                  label: p.name ?? p.email,
                  description: p.name === undefined ? undefined : p.email,
                  textValue: `${p.name ?? ""} ${p.email}`,
                }))}
              />
            ) : (
              <TextInput
                id="enrol-person"
                ref={personRef}
                {...personAria}
                type="text"
                inputMode="email"
                autoComplete="email"
                placeholder="someone@yourcompany.com"
                value={personEmail}
                onChange={(event) => choosePerson(event.target.value)}
              />
            )}
          </Field>
          <Field label="How it reaches the laptop">
            <RadioCards
              name="enrol-method"
              label="How it reaches the laptop"
              value={method}
              onValueChange={setMethod}
              options={[
                { value: "link", title: "Open a link", description: "The menu-bar app opens it and enrols. Nothing to type.", icon: LinkIcon, badge: <Pill>Recommended</Pill> },
                { value: "terminal", title: "Run a command", description: "Paste one line in Terminal on the laptop.", icon: SquareTerminalIcon },
              ]}
            />
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="The link works for" htmlFor="enrol-expiry">
              <SelectInput<string> id="enrol-expiry" value={String(hours)} onValueChange={(v) => setHours(Number(v))} options={EXPIRY_OPTIONS} />
            </Field>
            <Field label="Note" htmlFor="enrol-note" hint="Optional.">
              <TextInput id="enrol-note" aria-describedby="enrol-note-hint" maxLength={120} placeholder="Ada’s MacBook Air" value={note} onChange={(event) => setNote(event.target.value)} />
            </Field>
          </div>
        </FieldStack>
      </div>
    </FormSheet>
  );
}

type SheetTab = "activity" | "usage" | "details";

const trustWords = (value: boolean | undefined, yes: string, no: string): string => (value === true ? yes : value === false ? no : "Not reported");

function DeviceDetails({ row, groups }: { row: GuardDeviceRow; groups: readonly string[] | undefined }) {
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Person", value: row.person.name === undefined ? row.person.email : `${row.person.name} (${row.person.email})` },
    { label: "Groups", value: groups === undefined ? EMPTY : groups.length === 0 ? "None" : groups.join(", ") },
    { label: "Model", value: row.modelIdentifier ?? EMPTY },
    { label: "macOS", value: row.osVersion.replace(/^macOS\s+/i, "") },
    ...(row.serialNumber === undefined ? [] : [{ label: "Serial number", value: <span className="font-mono text-13">{row.serialNumber}</span> }]),
    { label: "Guard version", value: row.agentVersion },
    { label: "Mode", value: row.clientMode === "enforce" ? "Enforce: blocks what the rules block" : "Monitor: records and lets through" },
    { label: "AI traffic checks", value: interceptionWords(row) },
    {
      label: "Rules",
      value:
        row.bundleVersion === undefined ? (
          "None yet"
        ) : (
          <span>
            Version {row.bundleVersion}
            {row.bundleDigest === undefined ? null : <span className="font-mono text-13 text-g-muted"> {short(row.bundleDigest, 7)}</span>}
          </span>
        ),
    },
    { label: "Catalogue", value: row.catalogueVersion ?? EMPTY },
    {
      label: "Local CA",
      value: (
        <span data-testid="ca-trusted" data-trusted={row.health?.caTrusted === undefined ? "unknown" : String(row.health.caTrusted)} className="flex flex-col">
          <span>{row.ca === undefined ? "None on this Mac" : trustWords(row.health?.caTrusted, "Trusted by macOS", "Not trusted by macOS")}</span>
          {row.ca?.fingerprintSha256 === undefined ? null : <span className="font-mono text-13 text-g-muted">{short(row.ca.fingerprintSha256, 16)}</span>}
        </span>
      ),
    },
    { label: "Proxy", value: trustWords(row.health?.proxyListening, "Listening", "Not listening") },
    { label: "Browser extension", value: trustWords(row.health?.extensionActive, "Active", "Not active") },
    { label: "Enrolled", value: absoluteWords(row.enrolledAt) },
    ...(row.revokedAt === undefined ? [] : [{ label: "Revoked", value: `${absoluteWords(row.revokedAt)}${row.revokedBy === undefined ? "" : ` by ${row.revokedBy}`}` }]),
    {
      label: "Device ID",
      value: (
        <span className="flex items-center gap-2">
          <span className="font-mono text-13">{row.deviceId}</span>
          <CopyIconButton text={row.deviceId} label="Copy the device ID" />
        </span>
      ),
    },
  ];
  return <SheetDefinitions rows={rows} />;
}

function InterceptionCallout({ row }: { row: GuardDeviceRow }) {
  const reason = interceptionOff(row);
  if (reason === undefined) return null;
  return (
    <div data-testid="interception-callout" className="mb-4 rounded-g-card border border-g-pill-bad-line bg-g-pill-bad-bg px-4 py-3 text-13 leading-normal text-g-ink">
      <p className="mb-1 font-semibold text-g-pill-bad-ink">Guard cannot check AI traffic on this Mac</p>
      <p>
        {REASON_WORDS[reason].sentence}
        {row.lastSeenAt === undefined ? null : ` Reported ${relativeTo(row.lastSeenAt)}.`}
      </p>
    </div>
  );
}

function DeviceSheet({
  open,
  row,
  groups,
  menu,
  onClose,
}: {
  open: boolean;
  row: GuardDeviceRow;
  groups: readonly string[] | undefined;
  menu: readonly RowMenuItem[];
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<SheetTab>("activity");
  const events = useEvents({ deviceId: row.deviceId });
  return (
    <DetailSheet<SheetTab>
      open={open}
      onClose={onClose}
      icon={<IconTile size={40} icon={LaptopIcon} />}
      title={row.hostname}
      pills={
        <>
          <DevicePill row={row} size="header" />
          <Pill size="header">Guard {row.agentVersion}</Pill>
        </>
      }
      sub={seenWords(row.lastSeenAt)}
      menu={menu.filter((item) => item.label !== "View details")}
      menuLabel={`Actions for ${row.hostname}`}
      tabsLabel="Device sections"
      tabs={[
        { value: "activity", label: "Activity", icon: ActivityIcon },
        { value: "usage", label: "AI usage", icon: SparklesIcon },
        { value: "details", label: "Details", icon: InfoIcon },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <div data-testid="device-sheet">
        <InterceptionCallout row={row} />
        {tab === "activity" ? (
          <EventList door={events} context="device" emptyText="Nothing recorded on this laptop yet." />
        ) : tab === "usage" ? (
          <UsageList door={events} emptyText="No AI service has been reached from this laptop yet." />
        ) : (
          <DeviceDetails row={row} groups={groups} />
        )}
      </div>
    </DetailSheet>
  );
}

const linkState = (l: LinkRow, now: number): { label: string; tone: "ok" | "neutral" | "muted" } =>
  l.usedAt !== undefined ? { label: "Used", tone: "ok" } : Date.parse(l.expiresAt) < now ? { label: "Expired", tone: "muted" } : { label: "Open", tone: "neutral" };

function useSettled(value: string, ms = 250): string {
  const [settled, setSettled] = React.useState(value);
  React.useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function FleetActivity({ q, onOpen, onClearSearch }: { q: string; onOpen: (deviceId: string) => void; onClearSearch: () => void }) {
  const settled = useSettled(q.trim());
  const door = useDoor(() => guard.activity({ limit: 50, ...(settled === "" ? {} : { q: settled }) }), [settled]);
  if (door.state.status === "loading") return <DoorSkeleton rows={4} />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const page = door.state.data;
  const columns: DataColumn<GuardEventRow>[] = [
    { id: "action", header: "Decision", width: "140px", cell: (r) => <EventPill action={r.action} /> },
    {
      id: "service",
      header: "AI service",
      cell: (r) => <CellTitle icon={<ServiceMark serviceId={r.serviceId} size="sm" />} title={r.serviceName ?? r.host ?? "An unknown service"} sub={appWords(r.app)} />,
    },
    { id: "device", header: "Device", cell: (r) => <CellTitle title={r.hostname ?? r.deviceId} sub={r.person.name ?? r.person.email} /> },
    { id: "when", header: "When", width: "150px", cell: (r) => <When iso={r.occurredAt} /> },
  ];
  return (
    <>
      <DataTable<GuardEventRow>
        label="Device activity"
        rows={page.rows}
        rowKey={(r) => r.eventId}
        columns={columns}
        onRowClick={(r) => onOpen(r.deviceId)}
        rowLabel={(r) => `${r.serviceName ?? r.host ?? "Event"} on ${r.hostname ?? r.deviceId}, open the device`}
        empty={
          settled === "" ? (
            <EmptyState icon={ActivityIcon} title="No activity" description="Decisions show up here once laptops report them." />
          ) : (
            <EmptyState
              title={`No activity matches “${settled}”`}
              description="Try a different search, or clear it to see every event."
              action={
                <ActionButton static onClick={onClearSearch}>
                  Clear search
                </ActionButton>
              }
            />
          )
        }
      />
      {page.nextCursor === undefined ? null : <p className="mt-3 text-12 text-g-muted">The latest {page.rows.length} events. The Activity page has every one.</p>}
    </>
  );
}

export function Devices() {
  const [params, setParams] = useSearchParams();
  const door = useDoor(() => guard.devices(), []);
  const links = useDoor(() => guard.enrolLinks(), []);
  const groupsRead = useDoor(() => groupsDoor.list().catch(() => undefined), []);
  const week = useDoor(() => guard.overview(7).catch(() => undefined), []);
  const counts = useShellCounts();
  const sheet = useSheetParam("device");
  const [view, setView] = React.useState<View>("devices");
  const [q, setQ] = React.useState("");
  const [states, setStates] = React.useState<DeviceState["key"][]>([]);
  const [groupFilter, setGroupFilter] = React.useState<string[]>([]);
  const [sort, setSort] = React.useState<{ by: "device" | "seen"; dir: "asc" | "desc" }>({ by: "device", dir: "asc" });
  const [enrolling, setEnrolling] = React.useState(params.get("enrol") === "1");
  const [distributing, setDistributing] = React.useState(params.get("distribute") === "1");
  const org = useOrg();
  const [revoking, setRevoking] = React.useState<GuardDeviceRow | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const heldRevoking = useHeld(revoking);
  const openRow = door.state.status !== "ready" || sheet.value === null ? undefined : door.state.data.rows.find((r) => r.deviceId === sheet.value);
  const heldOpen = useHeld(openRow);

  const groups = groupsRead.state.status === "ready" ? groupsRead.state.data?.rows : undefined;
  const groupIndex = React.useMemo(() => groupsByEmail(groups), [groups]);
  const groupsOf = (row: GuardDeviceRow): string[] | undefined => (groups === undefined ? undefined : (groupIndex.get(row.person.email.toLowerCase()) ?? []));

  const closeEnrol = () => {
    setEnrolling(false);
    if (params.has("enrol")) {
      const next = new URLSearchParams(params);
      next.delete("enrol");
      setParams(next, { replace: true });
    }
  };
  const closeDistribute = () => {
    setDistributing(false);
    if (params.has("distribute")) {
      const next = new URLSearchParams(params);
      next.delete("distribute");
      setParams(next, { replace: true });
    }
  };
  const distribute = (serverUrl: string | undefined) => (
    <DistributeSheet
      open={distributing}
      serverUrl={serverUrl}
      organisation={org.name}
      onClose={closeDistribute}
      onEnrol={() => {
        closeDistribute();
        setEnrolling(true);
      }}
    />
  );
  const header = (
    <PageHeader
      className="-mt-2"
      actions={
        <div className="flex h-10 items-center gap-2">
          <ActionButton icon={PackageIcon} onClick={() => setDistributing(true)} data-testid="distribute-open">
            Distribute Guard
          </ActionButton>
          <ActionButton variant="primary" icon={PlusIcon} onClick={() => setEnrolling(true)} data-testid="enrol-open">
            Enrol laptop
          </ActionButton>
        </div>
      }
    />
  );

  if (door.state.status !== "ready") {
    return (
      <div data-testid="devices-page">
        {header}
        {door.state.status === "loading" ? <DoorSkeleton rows={5} /> : <DoorError error={door.state.error} onRetry={door.reload} />}
        {distribute(undefined)}
      </div>
    );
  }
  const page = door.state.data;
  const now = Date.now();
  const active = page.rows.filter((r) => r.status === "active");
  const unprotected = active.filter((r) => deviceState(r).key === "unprotected").length;
  const linkRows = links.state.status === "ready" ? links.state.data.rows : undefined;
  const openLinks = linkRows?.filter((l) => linkState(l, now).label === "Open").length;

  const revoke = async (row: GuardDeviceRow) => {
    setBusy(true);
    try {
      await guard.revokeDevice(row.deviceId);
      toast.success(`${row.hostname} is revoked: it can no longer sync.`);
      door.reload();
      counts.refresh();
    } catch (error) {
      toastError(`${row.hostname} was not revoked`, refusalWords(error));
    } finally {
      setBusy(false);
      setRevoking(undefined);
    }
  };
  const menuFor = (row: GuardDeviceRow): RowMenuItem[] => [
    { label: "View details", icon: EyeIcon, onSelect: () => sheet.open(row.deviceId) },
    { label: "Copy device ID", icon: CopyIcon, onSelect: () => copyToClipboard(row.deviceId, "Device ID") },
    ...(row.serialNumber === undefined ? [] : [{ label: "Copy serial number", icon: CopyIcon, onSelect: () => copyToClipboard(row.serialNumber as string, "Serial number") }]),
    ...(row.status === "active" ? [{ label: "Revoke…", icon: Trash2Icon, destructive: true, separatorBefore: true, disabled: busy, onSelect: () => setRevoking(row) }] : []),
  ];

  const needle = q.trim().toLowerCase();
  const shown = page.rows
    .filter((r) => needle === "" || [r.hostname, r.person.name, r.person.email, r.serialNumber, r.modelIdentifier].some((v) => v?.toLowerCase().includes(needle)))
    .filter((r) => states.length === 0 || states.includes(deviceState(r).key))
    .filter((r) => groupFilter.length === 0 || (groupsOf(r) ?? []).some((g) => groupFilter.includes(g)))
    .sort((a, b) => {
      const revokedLast = Number(a.status === "revoked") - Number(b.status === "revoked");
      if (revokedLast !== 0) return revokedLast;
      const sign = sort.dir === "asc" ? 1 : -1;
      if (sort.by === "seen") return sign * ((Date.parse(a.lastSeenAt ?? "") || 0) - (Date.parse(b.lastSeenAt ?? "") || 0));
      return sign * a.hostname.localeCompare(b.hostname);
    });
  const flip = (by: "device" | "seen") => setSort((s) => (s.by === by ? { by, dir: s.dir === "asc" ? "desc" : "asc" } : { by, dir: by === "seen" ? "desc" : "asc" }));
  const deviceColumns: DataColumn<GuardDeviceRow>[] = [
    {
      id: "status",
      header: "Status",
      width: "180px",
      cell: (r) => {
        const reason = deviceState(r).key === "unprotected" ? interceptionOff(r) : undefined;
        return (
          <span className="flex flex-col items-start gap-0.5">
            <DevicePill row={r} />
            {reason === undefined ? null : (
              <span data-testid="device-reason" className="text-12 whitespace-nowrap text-g-pill-bad-ink">
                {REASON_WORDS[reason].short}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "device",
      header: "Device",
      sort: sort.by === "device" ? sort.dir : false,
      onSort: () => flip("device"),
      cell: (r) => <CellTitle icon={<IconTile icon={LaptopIcon} />} title={r.hostname} sub={r.person.name ?? r.person.email} />,
    },
    {
      id: "group",
      header: "Group",
      width: "22%",
      cell: (r) => {
        const names = groupsOf(r);
        return <span className="block truncate">{names === undefined || names.length === 0 ? EMPTY : names.join(", ")}</span>;
      },
    },
    {
      id: "seen",
      header: "Last seen",
      width: "180px",
      sort: sort.by === "seen" ? sort.dir : false,
      onSort: () => flip("seen"),
      cell: (r) => (
        <span className="flex flex-col">
          {r.lastSeenAt === undefined ? (
            <span className="text-g-muted">Never</span>
          ) : (
            <When iso={r.lastSeenAt} now={now} />
          )}
          {r.quiet && r.status === "active" ? (
            <span data-testid="quiet-pill" className="text-13 whitespace-nowrap text-g-muted">
              {r.quietForMinutes === undefined ? "Quiet" : `Quiet for ${minutesWords(r.quietForMinutes)}`}
            </span>
          ) : null}
        </span>
      ),
    },
  ];

  const linkColumns: DataColumn<LinkRow>[] = [
    {
      id: "state",
      header: "Status",
      width: "120px",
      cell: (l) => {
        const s = linkState(l, now);
        return (
          <Pill tone={s.tone} data-testid="link-state">
            {s.label}
          </Pill>
        );
      },
    },
    { id: "link", header: "Link", cell: (l) => <CellTitle icon={<IconTile icon={LinkIcon} />} title={<span className="font-mono text-13">{l.tokenPrefix}…</span>} sub={l.note} /> },
    { id: "for", header: "For", cell: (l) => <span className="block truncate">{l.personEmail}</span> },
    { id: "by", header: "Made by", cell: (l) => <span className="block truncate text-g-muted">{l.createdBy}</span> },
    {
      id: "when",
      header: "Expires or used",
      width: "200px",
      cell: (l) =>
        l.usedAt === undefined ? (
          <When iso={l.expiresAt} now={now} prefix={Date.parse(l.expiresAt) < now ? "Expired" : "Expires"} />
        ) : (
          <span className="flex flex-col">
            <When iso={l.usedAt} now={now} prefix="Used" />
            {l.usedByDevice === undefined ? null : <span className="font-mono text-12 text-g-muted">{l.usedByDevice}</span>}
          </span>
        ),
    },
  ];
  const shownLinks = (linkRows ?? []).filter((l) => needle === "" || [l.personEmail, l.note, l.tokenPrefix, l.createdBy].some((v) => v?.toLowerCase().includes(needle)));

  const groupNames = [...new Set((groups ?? []).map((g) => g.name))].sort((a, b) => a.localeCompare(b));

  return (
    <div data-testid="devices-page">
      {header}
      {page.rows.length === 0 ? (
        <BannerCard
          data-testid="distribute-banner"
          icon={PackageIcon}
          title="Distribute Guard to your Macs"
          description="Sign Guard with your organisation’s Apple Developer ID and deliver it with your device-management tool. A Vibtra-signed download comes later."
          action={
            <ActionButton variant="primary" onClick={() => setDistributing(true)}>
              Set up distribution
            </ActionButton>
          }
        />
      ) : null}
      <StatRow label="Device totals">
        <StatCard label="Devices" value={active.length.toLocaleString("en-US")} />
        <StatCard label="Quiet" value={active.filter((r) => r.quiet).length.toLocaleString("en-US")} delta={`Silent for over ${minutesWords(page.quietAfterMinutes).replace(/ /g, "\u00a0")}`} />
        <StatCard label={week.state.status === "ready" && week.state.data?.clientMode === "monitor" ? "Would have blocked this week" : "Blocked this week"} value={week.state.status === "ready" && week.state.data !== undefined ? week.state.data.totals.blocked.toLocaleString("en-US") : undefined} />
        <StatCard label="Open enrol links" value={openLinks?.toLocaleString("en-US")} />
      </StatRow>
      {unprotected === 0 ? null : (
        <p data-testid="unprotected-line" className="mb-4 text-14 font-semibold text-g-pill-bad-ink">
          {unprotected === 1 ? "1 is not protected." : `${unprotected.toLocaleString("en-US")} are not protected.`}
        </p>
      )}
      <ListToolbar
        views={
          <SegmentedTabs<View>
            size="list"
            label="Device views"
            value={view}
            onValueChange={(next) => {
              setView(next);
              setQ("");
            }}
            idPrefix="devices"
            items={[
              { value: "devices", label: "Devices" },
              { value: "links", label: "Enrol links" },
              { value: "activity", label: "Activity" },
            ]}
          />
        }
        search={{ value: q, onChange: setQ, placeholder: view === "links" ? "Search links…" : view === "activity" ? "Search activity…" : "Search devices…" }}
        filter={
          view === "devices" ? (
            <FilterPopover
              facets={[
                { id: "status", label: "Status", options: DEVICE_STATES.map((o) => (o.value === "unprotected" ? { ...o, count: unprotected } : o)), selected: states, onChange: (next) => setStates(next as DeviceState["key"][]) },
                ...(groupNames.length === 0 ? [] : [{ id: "group", label: "Group", options: groupNames.map((g) => ({ value: g, label: g })), selected: groupFilter, onChange: setGroupFilter }]),
              ]}
            />
          ) : undefined
        }
      />
      <div role="tabpanel" id={`devices-panel-${view}`} aria-labelledby={`devices-tab-${view}`}>
        {view === "devices" ? (
          <DataTable<GuardDeviceRow>
            label="Devices"
            className={cn(shown.length === 0 && "min-h-0")}
            rows={shown}
            rowKey={(r) => r.deviceId}
            columns={deviceColumns}
            onRowClick={(r) => sheet.open(r.deviceId)}
            rowLabel={(r) => `${r.hostname}, details`}
            rowMenu={menuFor}
            menuLabel={(r) => `Actions for ${r.hostname}`}
            empty={
              page.rows.length === 0 ? (
                <EmptyState
                  data-testid="devices-empty"
                  icon={LaptopIcon}
                  title="No laptop enrolled yet"
                  description="Make an enrol link for a person and open it on their laptop. It shows up here at its first check-in."
                />
              ) : (
                <EmptyState
                  title={needle === "" ? "No devices match the filters" : `No devices match “${q.trim()}”`}
                  description="Try a different search, or clear it to see every device."
                  action={
                    <ActionButton
                      static
                      onClick={() => {
                        setQ("");
                        setStates([]);
                        setGroupFilter([]);
                      }}
                    >
                      {needle === "" ? "Clear filters" : "Clear search"}
                    </ActionButton>
                  }
                />
              )
            }
          />
        ) : view === "links" ? (
          links.state.status === "loading" ? (
            <DoorSkeleton rows={2} />
          ) : links.state.status === "error" ? (
            <div data-testid="enrol-links">
              <DoorError error={links.state.error} onRetry={links.reload} />
            </div>
          ) : (
            <div data-testid="enrol-links">
              <DataTable<LinkRow>
                label="Enrol links"
                rows={shownLinks}
                rowKey={(l) => `${l.tokenPrefix}:${l.createdAt}`}
                columns={linkColumns}
                empty={
                  linkRows?.length === 0 ? (
                    <EmptyState icon={LinkIcon} title="No enrol links yet" description="Links made with Enrol laptop are listed here. Only a fingerprint of each link is kept." />
                  ) : (
                    <EmptyState
                      title={`No links match “${q.trim()}”`}
                      description="Try a different search, or clear it to see every link."
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
          )
        ) : (
          <FleetActivity q={q} onOpen={(deviceId) => sheet.open(deviceId)} onClearSearch={() => setQ("")} />
        )}
      </div>

      {heldOpen.value === undefined ? null : (
        <DeviceSheet key={heldOpen.value.deviceId} open={heldOpen.open} row={heldOpen.value} groups={groupsOf(heldOpen.value)} menu={menuFor(heldOpen.value)} onClose={sheet.close} />
      )}
      <EnrolSheet open={enrolling} serverUrl={page.serverUrl} onMinted={links.reload} onClose={closeEnrol} />
      {distribute(page.serverUrl)}
      {heldRevoking.value === undefined ? null : (
        <ConfirmModal
          open={heldRevoking.open}
          onClose={() => setRevoking(undefined)}
          title={`Revoke ${heldRevoking.value.hostname}?`}
          confirmLabel="Revoke laptop"
          cancelLabel="Cancel"
          busy={busy}
          onConfirm={() => {
            if (revoking !== undefined) void revoke(revoking);
          }}
        >
          Its next check-in is refused and it gets no new rules. To use Guard on it again, enrol it with a new link. Its past activity stays.
        </ConfirmModal>
      )}
    </div>
  );
}
