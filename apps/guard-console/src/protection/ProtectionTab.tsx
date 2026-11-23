import * as React from "react";
import { useSearchParams } from "react-router";
import { ChevronDownIcon, UndoIcon, UsersIcon } from "lucide-react";
import { toast } from "@vibtra/ui/react";
import type { ConsoleGroupRow } from "@vibtra/console-api";
import { GUARD_PROTECTION_IDS_MAX, type GuardProtectionApplied, type GuardProtectionPage, type GuardProtectionPreview } from "@vibtra/guard-contract";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { When } from "../guard/words";
import { ActionButton, Checkbox, CountBadge, DataTable, EMPTY, EmptyState, FilterPopover, ListToolbar, SegmentedTabs, actionButtonClass, type DataColumn, type RowMenuItem } from "@/components/kit";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, DropdownMenuTwoLineItem } from "@/components/ui/dropdown-menu";
import { BannerCard } from "../guard/parts";
import { PersonTitle } from "../people/fleet";
import { protectionDoor } from "../people/doors";
import { DefaultSheet } from "./DefaultSheet";
import { PreviewDialog } from "./PreviewDialog";
import { RolloutPanel } from "./RolloutPanel";
import { MODE_WORD, ModePill } from "./modes";
import { MODES, MODE_LABEL, countsByMode, isMode, isSource, membersOf, nameOf, peopleWords, rolloutScope, type Ask, type Mode, type ProtectionPerson, type RolloutScope, type Source } from "./model";

type ModeView = Mode | "all";

const SOURCE_LABEL: Readonly<Record<Source, string>> = { set: "Set for them", default: "Follows the default" };

const revisionOf = (value: string | null): number | undefined => {
  const n = value === null ? Number.NaN : Number(value);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
};

export function ProtectionTab({
  groups,
  groupsOf,
  macsOf,
  onChanged,
}: {
  groups: readonly ConsoleGroupRow[] | undefined;
  groupsOf: (email: string) => string[] | undefined;
  macsOf: (userId: string) => number | undefined;
  onChanged: () => void;
}) {
  const [params, setParams] = useSearchParams();
  const door = useDoor(() => protectionDoor.page(), []);
  const [ask, setAsk] = React.useState<Ask | undefined>(undefined);
  const [scope, setScope] = React.useState<RolloutScope | undefined>(undefined);
  const [choosing, setChoosing] = React.useState(false);
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const rollout = revisionOf(params.get("rollout"));
  const modeParam = params.get("mode");
  const sourceParam = params.get("source");
  const page = door.state.status === "ready" ? door.state.data : undefined;

  const setParam = (name: string, value: string | undefined, replace = true) =>
    setParams(
      (was) => {
        const next = new URLSearchParams(was);
        if (value === undefined) next.delete(name);
        else next.set(name, value);
        return next;
      },
      { replace },
    );

  const applied = (result: GuardProtectionApplied, done: Ask, preview: GuardProtectionPreview) => {
    setAsk(undefined);
    door.reload();
    onChanged();
    const moved = rolloutScope(result.revision, done, preview);
    const follow = result.applied > 0 && moved.people.size > 0;
    if (done.kind === "default") toast.success(`The default is now ${MODE_LABEL[done.to]}.`);
    else if (result.applied === 0) toast.success("Nothing changed: everyone was already as asked.");
    else {
      setSelected(new Set());
      toast.success(`Saved for ${peopleWords(result.applied)}.${follow ? " Their Macs are switching now." : ""}`);
    }
    if (!follow) return;
    setScope(moved);
    setParam("rollout", String(result.revision), false);
  };

  return (
    <div data-testid="protection-tab">
      {rollout === undefined ? null : <RolloutPanel key={rollout} revision={rollout} scope={scope} onDismiss={() => setParam("rollout", undefined)} />}
      {door.state.status === "loading" ? (
        <DoorSkeleton rows={6} />
      ) : door.state.status === "error" ? (
        <DoorError error={door.state.error} onRetry={door.reload} />
      ) : page === undefined ? null : (
        <>
          <DefaultCard page={page} onChange={() => setChoosing(true)} />
          <PeopleModes
            page={page}
            groups={groups}
            groupsOf={groupsOf}
            macsOf={macsOf}
            mode={isMode(modeParam) ? modeParam : undefined}
            source={isSource(sourceParam) ? sourceParam : undefined}
            onMode={(next) => setParam("mode", next)}
            onSource={(next) => setParam("source", next)}
            selected={selected}
            onSelect={setSelected}
            onAsk={setAsk}
          />
        </>
      )}
      {page === undefined ? null : (
        <DefaultSheet
          open={choosing}
          value={page.defaultMode}
          onClose={() => setChoosing(false)}
          onPreview={(to) => {
            setChoosing(false);
            setAsk({ kind: "default", to });
          }}
        />
      )}
      <PreviewDialog ask={ask} onClose={() => setAsk(undefined)} onApplied={applied} />
    </div>
  );
}

function DefaultCard({ page, onChange }: { page: GuardProtectionPage; onChange: () => void }) {
  const word = MODE_WORD[page.defaultMode];
  const following = page.people.filter((person) => person.source === "default").length;
  return (
    <BannerCard
      data-testid="protection-default"
      data-mode={page.defaultMode}
      icon={word.icon}
      title={`Default: ${word.label}`}
      description={`${following.toLocaleString("en-US")} of ${peopleWords(page.people.length)} follow the default. People you set on their own keep their mode when it changes.`}
      action={
        <ActionButton onClick={onChange} data-testid="protection-default-change">
          Change default
        </ActionButton>
      }
    />
  );
}

function PeopleModes({
  page,
  groups,
  groupsOf,
  macsOf,
  mode,
  source,
  onMode,
  onSource,
  selected,
  onSelect,
  onAsk,
}: {
  page: GuardProtectionPage;
  groups: readonly ConsoleGroupRow[] | undefined;
  groupsOf: (email: string) => string[] | undefined;
  macsOf: (userId: string) => number | undefined;
  mode: Mode | undefined;
  source: Source | undefined;
  onMode: (mode: Mode | undefined) => void;
  onSource: (source: Source | undefined) => void;
  selected: ReadonlySet<string>;
  onSelect: (next: ReadonlySet<string>) => void;
  onAsk: (ask: Ask) => void;
}) {
  const [q, setQ] = React.useState("");
  const [dir, setDir] = React.useState<"asc" | "desc">("asc");
  const [inGroups, setInGroups] = React.useState<string[]>([]);
  const needle = q.trim().toLowerCase();
  const counts = countsByMode(page.people);
  const shown = page.people
    .filter((person) => mode === undefined || person.mode === mode)
    .filter((person) => source === undefined || person.source === source)
    .filter((person) => inGroups.length === 0 || (groupsOf(person.email) ?? []).some((g) => inGroups.includes(g)))
    .filter((person) => needle === "" || [person.name, person.email].some((v) => v?.toLowerCase().includes(needle)))
    .sort((a, b) => (dir === "asc" ? 1 : -1) * nameOf(a).localeCompare(nameOf(b)));
  const picked = page.people.filter((person) => selected.has(person.userId));
  const shownPicked = shown.filter((person) => selected.has(person.userId)).length;
  const hiddenPicked = picked.length - shownPicked;
  const tooMany = picked.length > GUARD_PROTECTION_IDS_MAX;
  const toggle = (userId: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(userId);
    else next.delete(userId);
    onSelect(next);
  };
  const toggleShown = (on: boolean) => {
    const next = new Set(selected);
    for (const person of shown) {
      if (on) next.add(person.userId);
      else next.delete(person.userId);
    }
    onSelect(next);
  };
  const pickGroup = (group: ConsoleGroupRow) => {
    const found = membersOf(group, page.people);
    onSelect(new Set([...selected, ...found.people.map((person) => person.userId)]));
    if (found.people.length === 0) toast(`Nobody in ${group.name} has joined yet, so nobody was selected.`);
    else if (found.notJoined > 0)
      toast(`Selected ${peopleWords(found.people.length)} in ${group.name}. ${found.notJoined} ${found.notJoined === 1 ? "member has" : "members have"} not joined yet and ${found.notJoined === 1 ? "is" : "are"} not included.`);
  };
  const ask = (to: Mode | "default", people: readonly ProtectionPerson[]) =>
    onAsk({ kind: "people", people: people.map((person) => ({ userId: person.userId, email: person.email, name: person.name })), to });
  const groupNames = [...new Set((groups ?? []).map((g) => g.name))].sort((a, b) => a.localeCompare(b));
  const clearFilters = () => {
    setQ("");
    setInGroups([]);
    onMode(undefined);
    onSource(undefined);
  };

  const columns: DataColumn<ProtectionPerson>[] = [
    {
      id: "select",
      width: "52px",
      header: (
        <Checkbox
          aria-label="Select everyone shown"
          checked={shown.length > 0 && shownPicked === shown.length}
          indeterminate={shownPicked > 0 && shownPicked < shown.length}
          disabled={shown.length === 0}
          onCheckedChange={() => toggleShown(shownPicked < shown.length)}
        />
      ),
      cell: (person) => <Checkbox aria-label={`Select ${nameOf(person)}`} checked={selected.has(person.userId)} onCheckedChange={(on) => toggle(person.userId, on)} />,
    },
    {
      id: "name",
      header: "Name",
      sort: dir,
      onSort: () => setDir((d) => (d === "asc" ? "desc" : "asc")),
      cell: (person) => <PersonTitle email={person.email} name={person.name} />,
    },
    { id: "mode", header: "Mode", width: "140px", cell: (person) => <ModePill mode={person.mode} /> },
    {
      id: "source",
      header: "Set by",
      width: "26%",
      cell: (person) =>
        person.source === "default" ? (
          <span data-testid="mode-source" data-source="default" className="text-14 text-g-muted">
            {SOURCE_LABEL.default}
          </span>
        ) : (
          <span data-testid="mode-source" data-source="set" className="flex min-w-0 flex-col">
            <span className="truncate text-14 text-g-ink">{person.setBy === undefined ? SOURCE_LABEL.set : person.setBy}</span>
            {person.setAt === undefined ? null : <When iso={person.setAt} className="truncate text-13 text-g-muted" />}
          </span>
        ),
    },
    {
      id: "groups",
      header: "Groups",
      width: "16%",
      cell: (person) => {
        const names = groupsOf(person.email);
        return <span className="block truncate">{names === undefined || names.length === 0 ? EMPTY : names.join(", ")}</span>;
      },
    },
    {
      id: "macs",
      header: "Macs",
      width: "80px",
      cell: (person) => {
        const macs = macsOf(person.userId);
        return macs === undefined ? EMPTY : <CountBadge count={macs} />;
      },
    },
  ];

  const menuFor = (person: ProtectionPerson): RowMenuItem[] => [
    ...MODES.filter((m) => !(person.source === "set" && person.mode === m)).map((m) => ({ label: `Set to ${MODE_LABEL[m]}`, icon: MODE_WORD[m].icon, onSelect: () => ask(m, [person]) })),
    ...(person.source === "set" ? [{ label: `Back to the default (${MODE_LABEL[page.defaultMode]})`, icon: UndoIcon, separatorBefore: true, onSelect: () => ask("default", [person]) }] : []),
  ];

  return (
    <>
      <ListToolbar
        views={
          <SegmentedTabs<ModeView>
            size="list"
            label="Mode"
            value={mode ?? "all"}
            onValueChange={(next) => onMode(next === "all" ? undefined : next)}
            items={[{ value: "all" as const, label: "All", count: page.people.length }, ...MODES.map((m) => ({ value: m, label: MODE_LABEL[m], count: counts[m] }))]}
          />
        }
        search={{ value: q, onChange: setQ, placeholder: "Search people…" }}
        filter={
          <>
            <FilterPopover
              facets={[
                {
                  id: "source",
                  label: "Set by",
                  options: (["set", "default"] as const).map((value) => ({ value, label: SOURCE_LABEL[value], count: page.people.filter((p) => p.source === value).length })),
                  selected: source === undefined ? [] : [source],
                  onChange: (next) => {
                    const last = next[next.length - 1] ?? null;
                    onSource(isSource(last) ? last : undefined);
                  },
                },
                ...(groupNames.length === 0 ? [] : [{ id: "group", label: "Group", options: groupNames.map((g) => ({ value: g, label: g })), selected: inGroups, onChange: setInGroups }]),
              ]}
            />
            {picked.length === 0 ? null : (
              <span role="status" data-testid="protection-selected" className="flex items-center gap-2 ps-2 text-13 text-g-muted">
                <span className="font-medium text-g-ink tabular-nums">{picked.length.toLocaleString("en-US")} selected</span>
                {hiddenPicked > 0 ? <span>({hiddenPicked.toLocaleString("en-US")} hidden by the filters)</span> : null}
                {tooMany ? (
                  <span id="protection-too-many" className="font-medium text-g-pill-warn-ink">
                    You can change up to {GUARD_PROTECTION_IDS_MAX.toLocaleString("en-US")} people at a time; narrow the selection.
                  </span>
                ) : null}
                <button type="button" onClick={() => onSelect(new Set())} className="focus-knox cursor-pointer rounded-sm font-medium text-g-ink underline underline-offset-4 outline-hidden">
                  Clear
                </button>
              </span>
            )}
          </>
        }
        action={
          <>
            {groups === undefined || groups.length === 0 ? null : (
              <DropdownMenu>
                <DropdownMenuTrigger className={actionButtonClass("secondary")} data-testid="protection-select-group">
                  <UsersIcon aria-hidden />
                  Select a group
                  <ChevronDownIcon aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[220px]">
                  {[...groups]
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((group) => (
                      <DropdownMenuTwoLineItem key={group.id} title={group.name} meta={peopleWords(group.memberCount)} onClick={() => pickGroup(group)} />
                    ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger className={actionButtonClass("primary")} disabled={picked.length === 0 || tooMany} aria-describedby={tooMany ? "protection-too-many" : undefined} data-testid="protection-set-to">
                Set to…
                <ChevronDownIcon aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-[300px]">
                {MODES.map((m) => {
                  const Icon = MODE_WORD[m].icon;
                  return <DropdownMenuTwoLineItem key={m} icon={<Icon aria-hidden />} title={MODE_LABEL[m]} meta={SET_TO_META[m]} onClick={() => ask(m, picked)} />;
                })}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => ask("default", picked)}>
                  <UndoIcon aria-hidden />
                  Back to the default ({MODE_LABEL[page.defaultMode]})
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      <DataTable<ProtectionPerson>
        label="Protection for each person"
        rows={shown}
        rowKey={(person) => person.userId}
        columns={columns}
        rowMenu={menuFor}
        menuLabel={(person) => `Change ${nameOf(person)}`}
        minWidth={900}
        empty={
          page.people.length === 0 ? (
            <EmptyState title="Nobody here yet" description="People who join the organisation are listed here with their mode." />
          ) : (
            <EmptyState
              title={needle === "" ? "No people match the filters" : `No people match “${q.trim()}”`}
              description="Try a different search, or clear it to see everyone."
              action={
                <ActionButton static onClick={clearFilters}>
                  {needle === "" ? "Clear filters" : "Clear search"}
                </ActionButton>
              }
            />
          )
        }
      />
    </>
  );
}

const SET_TO_META: Readonly<Record<Mode, string>> = { enforce: "Block what the rules block", monitor: "Record what the rules would block", off: "No inspection, nothing recorded" };
