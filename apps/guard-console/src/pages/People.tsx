import * as React from "react";
import { useSearchParams } from "react-router";
import { PlusIcon, UserIcon, UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleGroupRow, ConsolePersonRow } from "@vibtra/console-api";
import type { GuardDeviceRow } from "@vibtra/guard-contract";
import { guard } from "../api/guard";
import { refusalSentence } from "../api/client";
import { useSession } from "../api/session";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { When } from "../guard/words";
import {
  ActionButton,
  CellTitle,
  ConfirmModal,
  CountBadge,
  DataTable,
  EMPTY,
  EmptyState,
  FilterPopover,
  IconTile,
  ListToolbar,
  PageHeader,
  Pill,
  SegmentedTabs,
  useHeld,
  useSheetParam,
  type DataColumn,
} from "@/components/kit";
import { groupsDoor, peopleDoor } from "../people/doors";
import { PersonTitle, dateWords, groupsByEmail } from "../people/fleet";
import { ACCESS, PersonSheet, accessOf, type PersonManagement } from "../people/PersonSheet";
import { InviteSheet } from "../people/InviteSheet";
import { roleOf } from "../people/roles";
import { plural } from "../guard/words";
import { AddGroupSheet, GroupSheet } from "../people/GroupSheets";

type Tab = "people" | "groups";

export function People() {
  const [params] = useSearchParams();
  const tab: Tab = params.get("tab") === "groups" ? "groups" : "people";
  const people = useDoor(() => guard.people(), []);
  const groupsRead = useDoor(() => groupsDoor.list(), []);
  const devicesRead = useDoor(() => guard.devices().catch(() => undefined), []);
  const personSheet = useSheetParam("person");
  const groupSheet = useSheetParam("group");
  const [adding, setAdding] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [removing, setRemoving] = React.useState<ConsolePersonRow | undefined>(undefined);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const session = useSession();

  const groups = groupsRead.state.status === "ready" ? groupsRead.state.data.rows : undefined;
  const devices = devicesRead.state.status === "ready" ? devicesRead.state.data?.rows : undefined;
  const rows = people.state.status === "ready" ? people.state.data.rows : [];
  const openPerson = personSheet.value === null ? undefined : rows.find((p) => p.subject === personSheet.value);
  const openGroup = groupSheet.value === null || groups === undefined ? undefined : groups.find((g) => g.id === groupSheet.value);
  const heldPerson = useHeld(openPerson);
  const heldGroup = useHeld(openGroup);

  const tabs = (
    <SegmentedTabs<Tab>
      label="People"
      value={tab}
      items={[
        { value: "people", label: "People", icon: UserIcon, to: "/people" },
        { value: "groups", label: "Groups", icon: UsersIcon, to: "/people?tab=groups" },
      ]}
    />
  );
  const header = (
    <PageHeader
      tabs={tabs}
      actions={
        tab === "groups" && groupsRead.state.status === "ready" ? (
          <ActionButton variant="primary" icon={PlusIcon} onClick={() => setAdding(true)} data-testid="add-group-open">
            Add group
          </ActionButton>
        ) : tab === "people" && people.state.status === "ready" && people.state.data.mayManage === true ? (
          <ActionButton variant="primary" icon={UserPlusIcon} onClick={() => setInviting(true)} data-testid="invite-open">
            Invite people
          </ActionButton>
        ) : undefined
      }
    />
  );

  if (people.state.status !== "ready") {
    return (
      <div data-testid="people-page">
        {header}
        {people.state.status === "loading" ? <DoorSkeleton rows={5} /> : <DoorError error={people.state.error} onRetry={people.reload} />}
      </div>
    );
  }

  const page = people.state.data;
  const manage: PersonManagement | undefined =
    page.mayManage === true
      ? { viewer: session.orgRole, owners: rows.filter((p) => roleOf(p) === "owner").length, onChanged: people.reload, onRemove: setRemoving }
      : undefined;
  const remove = async (person: ConsolePersonRow) => {
    setRemoveBusy(true);
    try {
      await peopleDoor.remove(person.subject);
      toast.success(`${person.name ?? person.email} was removed from ${session.orgName}.`);
      if (personSheet.value === person.subject) personSheet.close();
      setRemoving(undefined);
      people.reload();
    } catch (error) {
      toastError(`${person.name ?? person.email} was not removed`, refusalSentence(error));
      setRemoving(undefined);
    } finally {
      setRemoveBusy(false);
    }
  };
  const groupIndex = groupsByEmail(groups);
  const groupsOf = (p: ConsolePersonRow): string[] | undefined => (groups === undefined ? undefined : (groupIndex.get(p.email.toLowerCase()) ?? []));
  const devicesOf = (p: ConsolePersonRow): GuardDeviceRow[] | undefined => devices?.filter((d) => d.person.userId === p.subject && d.status === "active");

  return (
    <div data-testid="people-page">
      {header}
      {tab === "people" ? (
        <PeopleTable rows={rows} groups={groups} groupsOf={groupsOf} devicesOf={devicesOf} onOpen={(p) => personSheet.open(p.subject)} onRemove={manage === undefined ? undefined : setRemoving} />
      ) : groupsRead.state.status === "loading" ? (
        <DoorSkeleton rows={3} />
      ) : groupsRead.state.status === "error" ? (
        <DoorError error={groupsRead.state.error} onRetry={groupsRead.reload} />
      ) : (
        <GroupsTable rows={groupsRead.state.data.rows} onOpen={(g) => groupSheet.open(g.id)} />
      )}

      {heldPerson.value === undefined ? null : (
        <PersonSheet
          key={heldPerson.value.subject}
          open={heldPerson.open}
          person={heldPerson.value}
          groups={groupsOf(heldPerson.value)}
          devices={devicesOf(heldPerson.value)}
          onClose={personSheet.close}
          {...(manage === undefined ? {} : { manage })}
        />
      )}
      {heldGroup.value === undefined ? null : (
        <GroupSheet key={heldGroup.value.id} open={heldGroup.open} group={heldGroup.value} people={rows} onClose={groupSheet.close} onChanged={groupsRead.reload} />
      )}
      <InviteSheet open={inviting} mailEnabled={page.mailEnabled === true} orgName={session.orgName} onClose={() => setInviting(false)} onInvited={people.reload} />
      <ConfirmModal
        open={removing !== undefined}
        onClose={() => setRemoving(undefined)}
        title={removing === undefined ? "" : `Remove ${removing.name ?? removing.email} from ${session.orgName}?`}
        confirmLabel="Remove"
        busy={removeBusy}
        onConfirm={() => removing !== undefined && void remove(removing)}
      >
        {removing === undefined ? "" : removeWords(removing)}
      </ConfirmModal>
      <AddGroupSheet
        open={adding}
        people={rows}
        onClose={() => setAdding(false)}
        onDone={(id) => {
          setAdding(false);
          groupsRead.reload();
          groupSheet.open(id);
        }}
      />
    </div>
  );
}

function PeopleTable({
  rows,
  groups,
  groupsOf,
  devicesOf,
  onOpen,
  onRemove,
}: {
  rows: readonly ConsolePersonRow[];
  groups: readonly ConsoleGroupRow[] | undefined;
  groupsOf: (p: ConsolePersonRow) => string[] | undefined;
  devicesOf: (p: ConsolePersonRow) => GuardDeviceRow[] | undefined;
  onOpen: (p: ConsolePersonRow) => void;
  onRemove: ((p: ConsolePersonRow) => void) | undefined;
}) {
  const [q, setQ] = React.useState("");
  const [dir, setDir] = React.useState<"asc" | "desc">("asc");
  const [access, setAccess] = React.useState<string[]>([]);
  const [inGroups, setInGroups] = React.useState<string[]>([]);
  const needle = q.trim().toLowerCase();
  const nameOf = (p: ConsolePersonRow) => p.name ?? p.email;
  const shown = rows
    .filter((p) => needle === "" || [p.name, p.email].some((v) => v?.toLowerCase().includes(needle)))
    .filter((p) => access.length === 0 || access.includes(accessOf(p).key))
    .filter((p) => inGroups.length === 0 || (groupsOf(p) ?? []).some((g) => inGroups.includes(g)))
    .sort((a, b) => (dir === "asc" ? 1 : -1) * nameOf(a).localeCompare(nameOf(b)));
  const columns: DataColumn<ConsolePersonRow>[] = [
    {
      id: "name",
      header: "Name",
      sort: dir,
      onSort: () => setDir((d) => (d === "asc" ? "desc" : "asc")),
      cell: (p) => <PersonTitle email={p.email} name={p.name} image={p.image} />,
    },
    {
      id: "role",
      header: "Role",
      width: "120px",
      cell: (p) => {
        const a = accessOf(p);
        return <Pill tone={a.tone}>{a.label}</Pill>;
      },
    },
    {
      id: "groups",
      header: "Groups",
      width: "18%",
      cell: (p) => {
        const names = groupsOf(p);
        return <span className="block truncate">{names === undefined || names.length === 0 ? EMPTY : names.join(", ")}</span>;
      },
    },
    {
      id: "devices",
      header: "Devices",
      width: "100px",
      cell: (p) => {
        const owned = devicesOf(p);
        return owned === undefined ? EMPTY : <CountBadge count={owned.length} />;
      },
    },
    {
      id: "signed-in",
      header: "Last signed in",
      width: "150px",
      cell: (p) =>
        p.lastSeenAt === undefined || p.lastSeenAt === null ? EMPTY : <When iso={p.lastSeenAt} />,
    },
    { id: "added", header: "Added", width: "130px", cell: (p) => <span className="whitespace-nowrap">{dateWords(p.createdAt)}</span> },
  ];
  const groupNames = [...new Set((groups ?? []).map((g) => g.name))].sort((a, b) => a.localeCompare(b));
  return (
    <>
      <ListToolbar
        search={{ value: q, onChange: setQ, placeholder: "Search people…" }}
        filter={
          <FilterPopover
            facets={[
              { id: "role", label: "Role", options: Object.entries(ACCESS).map(([value, a]) => ({ value, label: a.label })), selected: access, onChange: setAccess },
              ...(groupNames.length === 0 ? [] : [{ id: "group", label: "Group", options: groupNames.map((g) => ({ value: g, label: g })), selected: inGroups, onChange: setInGroups }]),
            ]}
          />
        }
      />
      <DataTable<ConsolePersonRow>
        label="People"
        rows={shown}
        rowKey={(p) => p.subject}
        columns={columns}
        onRowClick={onOpen}
        rowLabel={(p) => `${nameOf(p)}, details`}
        {...(onRemove === undefined
          ? {}
          : {
              rowMenu: (p: ConsolePersonRow) => (p.mayManage === true ? [{ label: "Remove from organisation", icon: UserMinusIcon, destructive: true, onSelect: () => onRemove(p) }] : []),
              menuLabel: (p: ConsolePersonRow) => `Actions for ${nameOf(p)}`,
            })}
        minWidth={820}
        empty={
          rows.length === 0 ? (
            <EmptyState title="Nobody here yet" description="People who join the organisation are listed here." />
          ) : (
            <EmptyState
              title={needle === "" ? "No people match the filters" : `No people match “${q.trim()}”`}
              description="Try a different search, or clear it to see everyone."
              action={
                <ActionButton
                  static
                  onClick={() => {
                    setQ("");
                    setAccess([]);
                    setInGroups([]);
                  }}
                >
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

function GroupsTable({ rows, onOpen }: { rows: readonly ConsoleGroupRow[]; onOpen: (g: ConsoleGroupRow) => void }) {
  const [q, setQ] = React.useState("");
  const [dir, setDir] = React.useState<"asc" | "desc">("asc");
  const needle = q.trim().toLowerCase();
  const shown = rows.filter((g) => needle === "" || g.name.toLowerCase().includes(needle)).sort((a, b) => (dir === "asc" ? 1 : -1) * a.name.localeCompare(b.name));
  const columns: DataColumn<ConsoleGroupRow>[] = [
    {
      id: "name",
      header: "Name",
      sort: dir,
      onSort: () => setDir((d) => (d === "asc" ? "desc" : "asc")),
      cell: (g) => <CellTitle icon={<IconTile icon={UsersIcon} />} title={g.name} sub={g.createdBy === undefined ? undefined : `Made by ${g.createdBy}`} />,
    },
    { id: "people", header: "People", width: "160px", cell: (g) => <CountBadge count={g.memberCount} /> },
    { id: "created", header: "Creation date", width: "180px", cell: (g) => <span className="whitespace-nowrap">{dateWords(g.createdAt)}</span> },
  ];
  return (
    <>
      <ListToolbar search={{ value: q, onChange: setQ, placeholder: "Search groups…" }} />
      <DataTable<ConsoleGroupRow>
        label="Groups"
        rows={shown}
        rowKey={(g) => g.id}
        columns={columns}
        onRowClick={onOpen}
        rowLabel={(g) => `${g.name}, members`}
        empty={
          rows.length === 0 ? (
            <EmptyState icon={UsersIcon} title="No groups yet" description="Make a group to give rules to some people and not others." />
          ) : (
            <EmptyState
              title={`No groups match “${q.trim()}”`}
              description="Try a different search, or clear it to see every group."
              action={
                <ActionButton static onClick={() => setQ("")}>
                  Clear search
                </ActionButton>
              }
            />
          )
        }
      />
    </>
  );
}

function removeWords(person: ConsolePersonRow): string {
  const tokens = person.doorTokens ?? [];
  const held =
    tokens.length === 0 ? "" : ` ${plural(tokens.length, "token they hold is", "tokens they hold are")} revoked: ${tokens.map((t) => t.name).join(", ")}.`;
  return `They lose access at their next request.${held} What they did stays in the activity history.`;
}
