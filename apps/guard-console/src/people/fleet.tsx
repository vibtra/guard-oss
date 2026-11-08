import * as React from "react";
import { ActivityIcon, SparklesIcon } from "lucide-react";
import { GeneratedAvatar } from "@vibtra/ui/react";
import { GUARD_SYNC_INTERVAL_DEFAULT_S, type GuardActivityPage, type GuardDeviceRow, type GuardEventAction, type GuardEventRow, type GuardInterceptionOffReason } from "@vibtra/guard-contract";
import type { ConsoleGroupRow } from "@vibtra/console-api";
import { guard, type ActivityQuery } from "../api/guard";
import { useDoor, type Door } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { relativeTo } from "../govern/format";
import { appWords } from "../guard/words";
import { DecisionPill } from "../guard/parts";
import { ServiceMark } from "../brand/BrandMark";
import { ActionButton, CountBadge, EmptyState, Pill, SearchInput, SheetList, SheetListRow, cn, type PillDot, type PillTone } from "@/components/kit";

export const dateWords = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" }).format(date);
};

export const seenWords = (iso: string | undefined, now?: number): string => (iso === undefined ? "Not seen yet" : `Last seen ${relativeTo(iso, now)}`);

export interface DeviceState {
  key: "revoked" | "quiet" | "late" | "unprotected" | "no-policy" | "sync-failing" | "protected" | "monitoring";
  label: string;
  tone: PillTone;
  dot?: PillDot;
}

export const DEVICE_STATES: readonly { value: DeviceState["key"]; label: string }[] = [
  { value: "protected", label: "Protected" },
  { value: "unprotected", label: "Not protected" },
  { value: "no-policy", label: "No policy yet" },
  { value: "sync-failing", label: "Sync failing" },
  { value: "monitoring", label: "Monitoring" },
  { value: "late", label: "Late" },
  { value: "quiet", label: "Quiet" },
  { value: "revoked", label: "Revoked" },
];

const PASSES_THROUGH = "AI traffic from this Mac goes through without Guard checking it.";

export const REASON_WORDS: Readonly<Record<GuardInterceptionOffReason, { short: string; sentence: string }>> = {
  "no-secure-enclave": { short: "No Secure Enclave", sentence: `This Mac has no Secure Enclave (a virtual machine, or an Intel Mac without a T2 chip). ${PASSES_THROUGH}` },
  "awaiting-trust": {
    short: "Certificate not trusted",
    sentence: "Guard made a new certificate and this Mac does not trust it yet. The person needs to trust it in the Guard app. Until then, AI traffic from this Mac goes through without Guard checking it.",
  },
  "key-unavailable": { short: "Key unavailable", sentence: `Guard could not make or use its key in this Mac’s Secure Enclave. ${PASSES_THROUGH}` },
  "unsigned-build": { short: "Unsigned build", sentence: `This Mac runs a Guard build that is not signed by your organisation. ${PASSES_THROUGH}` },
  "unsupported-platform": { short: "Unsupported platform", sentence: "Guard cannot check AI traffic on this operating system. AI traffic from this device goes through without Guard checking it." },
  "signer-unavailable": { short: "Signer unavailable", sentence: "The Guard app on this Mac is not running or not responding. Until it is back, AI traffic from this Mac may go through without Guard checking it." },
};

export const interceptionOff = (row: Pick<GuardDeviceRow, "health">): GuardInterceptionOffReason | undefined => {
  const interception = row.health?.interception;
  return interception?.on === false ? interception.reason : undefined;
};

export const interceptionWords = (row: Pick<GuardDeviceRow, "health">): string => {
  const interception = row.health?.interception;
  if (interception === undefined) return "Not reported";
  if (interception.on) return "On";
  const short = REASON_WORDS[interception.reason].short;
  return `Off: ${short.charAt(0).toLowerCase()}${short.slice(1)}`;
};

const SYNC_FAILING_AFTER_MS = 5 * GUARD_SYNC_INTERVAL_DEFAULT_S * 1000;

type DeviceStateRow = Pick<GuardDeviceRow, "status" | "quiet" | "late" | "clientMode" | "health" | "lastSeenAt" | "lastPostflightAt" | "bundleVersion">;

export const deviceState = (row: DeviceStateRow): DeviceState => {
  if (row.status === "revoked") return { key: "revoked", label: "Revoked", tone: "muted" };
  if (interceptionOff(row) !== undefined) return { key: "unprotected", label: "Not protected", tone: "bad" };
  if (row.quiet) return { key: "quiet", label: "Quiet", tone: "warn" };
  if (row.late) return { key: "late", label: "Late", tone: "warn" };
  if (row.bundleVersion === undefined || row.lastPostflightAt === undefined) return { key: "no-policy", label: "No policy yet", tone: "warn" };
  if (Date.parse(row.lastSeenAt ?? row.lastPostflightAt) - Date.parse(row.lastPostflightAt) > SYNC_FAILING_AFTER_MS) return { key: "sync-failing", label: "Sync failing", tone: "warn" };
  if (row.clientMode === "enforce") return { key: "protected", label: "Protected", tone: "ok" };
  return { key: "monitoring", label: "Monitoring", tone: "neutral", dot: "ok" };
};

export function DevicePill({ row, size, className }: { row: DeviceStateRow; size?: "table" | "header"; className?: string }) {
  const state = deviceState(row);
  return (
    <Pill tone={state.tone} {...(state.dot === undefined ? {} : { dot: state.dot })} size={size} data-testid="device-status" data-state={state.key} className={className}>
      {state.label}
    </Pill>
  );
}

export const groupsByEmail = (groups: readonly ConsoleGroupRow[] | undefined): Map<string, string[]> => {
  const index = new Map<string, string[]>();
  for (const group of groups ?? []) {
    for (const member of group.members ?? []) {
      const key = member.email.toLowerCase();
      index.set(key, [...(index.get(key) ?? []), group.name]);
    }
  }
  for (const names of index.values()) names.sort((a, b) => a.localeCompare(b));
  return index;
};

export function PersonTitle({ email, name, image, size = 32, sub }: { email: string; name?: string | null | undefined; image?: string | undefined; size?: 32 | 40; sub?: React.ReactNode }) {
  const first = name ?? email;
  const second = sub ?? (name === undefined || name === null ? undefined : email);
  return (
    <span data-slot="person-title" className="flex min-w-0 items-center gap-3">
      <GeneratedAvatar seed={email} name={first} kind="person" photoUrl={image} showTitle={false} className={cn("shrink-0", size === 40 ? "size-10" : "size-8")} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-14 font-medium text-g-ink">{first}</span>
        {second === undefined ? null : <span className="truncate text-13 text-g-muted">{second}</span>}
      </span>
    </span>
  );
}

export function EventPill({ action }: { action: GuardEventAction }) {
  return <DecisionPill action={action} />;
}

export function useEvents(query: Pick<ActivityQuery, "deviceId" | "personUserId">): Door<GuardActivityPage> {
  return useDoor(() => guard.activity({ ...query, limit: 200 }), [query.deviceId, query.personUserId]);
}

const eventService = (row: GuardEventRow): string => row.serviceName ?? row.host ?? "An unknown service";

function Coverage({ page, noun }: { page: GuardActivityPage; noun: string }) {
  if (page.nextCursor === undefined) return null;
  return (
    <p className="mt-3 text-12 text-g-muted">
      From the latest {page.rows.length.toLocaleString("en-US")} {noun}. The Activity page has the rest.
    </p>
  );
}

export function EventList({ door, context, emptyText }: { door: Door<GuardActivityPage>; context: "device" | "person"; emptyText: string }) {
  const [q, setQ] = React.useState("");
  if (door.state.status === "loading") return <DoorSkeleton rows={4} />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const page = door.state.data;
  const needle = q.trim().toLowerCase();
  const rows = needle === "" ? page.rows : page.rows.filter((r) => [eventService(r), appWords(r.app), r.ruleName, r.hostname, r.host].some((v) => v?.toLowerCase().includes(needle)));
  const where = (r: GuardEventRow) => (context === "device" ? r.ruleName : (r.hostname ?? r.deviceId));
  return (
    <div data-testid="sheet-activity">
      <div className="mb-4 flex items-center gap-2">
        <SearchInput search={{ value: q, onChange: setQ, placeholder: "Search activity…" }} className="max-md:flex-1" />
      </div>
      {rows.length === 0 ? (
        <div className="rounded-g-card border border-g-line">
          {needle === "" ? (
            <EmptyState icon={ActivityIcon} title="No activity" description={emptyText} />
          ) : (
            <EmptyState
              title={`Nothing matches “${q.trim()}”`}
              description="Try a different search, or clear it to see every event."
              action={
                <ActionButton static onClick={() => setQ("")}>
                  Clear search
                </ActionButton>
              }
            />
          )}
        </div>
      ) : (
        <SheetList
          label="Activity"
          items={rows}
          itemKey={(r) => r.eventId}
          render={(r) => (
            <div data-testid="sheet-event">
              <SheetListRow
                icon={<ServiceMark serviceId={r.serviceId} size="sm" />}
                title={eventService(r)}
                sub={[appWords(r.app), where(r), relativeTo(r.occurredAt)].filter((v): v is string => v !== undefined).join(" · ")}
                trailing={<EventPill action={r.action} />}
              />
            </div>
          )}
        />
      )}
      <Coverage page={page} noun="events" />
    </div>
  );
}

interface Usage {
  serviceId: string | undefined;
  name: string;
  events: number;
  blocked: number;
  lastAt: string;
}

export const usageOf = (rows: readonly GuardEventRow[]): Usage[] => {
  const by = new Map<string, Usage>();
  for (const r of rows) {
    const key = r.serviceId ?? r.host ?? "unknown";
    const seen = by.get(key) ?? { serviceId: r.serviceId, name: eventService(r), events: 0, blocked: 0, lastAt: r.occurredAt };
    seen.events += 1;
    if (r.action === "blocked") seen.blocked += 1;
    if (Date.parse(r.occurredAt) > Date.parse(seen.lastAt)) seen.lastAt = r.occurredAt;
    by.set(key, seen);
  }
  return [...by.values()].sort((a, b) => b.events - a.events || a.name.localeCompare(b.name));
};

export function UsageList({ door, emptyText }: { door: Door<GuardActivityPage>; emptyText: string }) {
  if (door.state.status === "loading") return <DoorSkeleton rows={3} />;
  if (door.state.status === "error") return <DoorError error={door.state.error} onRetry={door.reload} />;
  const page = door.state.data;
  const usage = usageOf(page.rows);
  return (
    <div data-testid="sheet-usage">
      {usage.length === 0 ? (
        <div className="rounded-g-card border border-g-line">
          <EmptyState icon={SparklesIcon} title="No AI services used" description={emptyText} />
        </div>
      ) : (
        <SheetList
          label="AI services used"
          items={usage}
          itemKey={(u) => u.serviceId ?? u.name}
          render={(u) => (
            <div data-testid="usage-row">
              <SheetListRow
                icon={<ServiceMark serviceId={u.serviceId} size="sm" />}
                title={u.name}
                sub={`Last used ${relativeTo(u.lastAt)}${u.blocked > 0 ? ` · ${u.blocked.toLocaleString("en-US")} blocked` : ""}`}
                trailing={
                  <span className="flex items-center gap-2 text-12 text-g-muted">
                    Events <CountBadge count={u.events} />
                  </span>
                }
              />
            </div>
          )}
        />
      )}
      <Coverage page={page} noun="events" />
    </div>
  );
}
