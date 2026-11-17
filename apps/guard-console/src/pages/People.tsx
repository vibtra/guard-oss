import * as React from "react";
import { useSearchParams } from "react-router";
import { MailIcon, PlusIcon, TimerIcon, UserIcon, UserMinusIcon, UserPlusIcon, UsersIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleGroupRow, ConsolePersonRow, OnboardingInviteRow, OnboardingPage, OnboardingStage } from "@vibtra/console-api";
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
  type RowMenuItem,
} from "@/components/kit";
import { groupsDoor, onboardingDoor, peopleDoor } from "../people/doors";
import { PersonTitle, dateWords, groupsByEmail } from "../people/fleet";
import { ACCESS, PersonSheet, accessOf, type PersonManagement } from "../people/PersonSheet";
import { InviteSheet } from "../people/InviteSheet";
import { ROLES, roleOf } from "../people/roles";
import { plural } from "../guard/words";
import { AddGroupSheet, GroupSheet } from "../people/GroupSheets";
import { ChaseList, useChase } from "../people/ChaseList";
import { InvitationSheet } from "../people/InvitationSheet";
import { AttentionBar, STAGE_OPTIONS, StageChip } from "../people/onboarding";

type Tab = "people" | "chase" | "groups";

type Row = { kind: "person"; person: ConsolePersonRow } | { kind: "invite"; invite: OnboardingInviteRow };

const tabOf = (value: string | null): Tab => (value === "groups" || value === "chase" ? value : "people");

const rowsOf = (people: readonly ConsolePersonRow[], onboarding: OnboardingPage | undefined): Row[] => [
  ...people.map((person): Row => ({ kind: "person", person })),
  ...(onboarding?.rows ?? []).flatMap((row): Row[] => (row.kind === "invite" ? [{ kind: "invite", invite: row }] : [])),
];

const isStage = (value: string): value is OnboardingStage => STAGE_OPTIONS.some((o) => o.value === value);

const stageOf = (row: Row): OnboardingStage | undefined => (row.kind === "invite" ? row.invite.stage : row.person.stage);

const placeOf = (row: Row): { stage: OnboardingStage; since: string } | undefined => {
  if (row.kind === "invite") return { stage: row.invite.stage, since: row.invite.stageSince };
  const { stage, stageSince } = row.person;
  return stage === undefined || stageSince === undefined ? undefined : { stage, since: stageSince };
};

export function People() {
  const [params] = useSearchParams();
  const people = useDoor(() => guard.people(), []);
  const mayManage = people.state.status === "ready" ? people.state.data.mayManage === true : undefined;
  const asked = tabOf(params.get("tab"));
  const tab: Tab = asked === "chase" && mayManage === false ? "people" : asked;
  const onboardingRead = useDoor((): Promise<OnboardingPage | undefined> => (mayManage === true ? onboardingDoor.page() : Promise.resolve(undefined)), [mayManage]);
  const groupsRead = useDoor(() => groupsDoor.list(), []);
  const devicesRead = useDoor(() => guard.devices().catch(() => undefined), []);
  const personSheet = useSheetParam("person");
  const groupSheet = useSheetParam("group");
  const [invitationOpen, setInvitationOpen] = React.useState<{ id: string; was?: string } | undefined>(undefined);
  const [adding, setAdding] = React.useState(false);
  const [inviting, setInviting] = React.useState(false);
  const [removing, setRemoving] = React.useState<ConsolePersonRow | undefined>(undefined);
  const [removeBusy, setRemoveBusy] = React.useState(false);
  const session = useSession();
  const chase = useChase((made) => {
    people.reload();
    onboardingRead.reload();
    const was = invitationOpen?.id;
    if (made !== undefined && was !== undefined && made.invitationId !== was) setInvitationOpen({ id: made.invitationId, was });
  });

  const groups = groupsRead.state.status === "ready" ? groupsRead.state.data.rows : undefined;
  const devices = devicesRead.state.status === "ready" ? devicesRead.state.data?.rows : undefined;
  const rows = people.state.status === "ready" ? people.state.data.rows : [];
  const onboarding = onboardingRead.state.status === "ready" ? onboardingRead.state.data : undefined;
  const chasing = onboarding?.rows.filter((row) => row.chase).length;
  const openPerson = personSheet.value === null ? undefined : rows.find((p) => p.subject === personSheet.value);
  const openGroup = groupSheet.value === null || groups === undefined ? undefined : groups.find((g) => g.id === groupSheet.value);
  const inviteOf = (invitationId: string | undefined): OnboardingInviteRow | undefined =>
    invitationId === undefined ? undefined : onboarding?.rows.find((row): row is OnboardingInviteRow => row.kind === "invite" && row.invitationId === invitationId);
  const openInvite = invitationOpen === undefined ? undefined : (inviteOf(invitationOpen.id) ?? inviteOf(invitationOpen.was));
  const heldPerson = useHeld(openPerson);
  const heldInvite = useHeld(openInvite);
  const heldGroup = useHeld(openGroup);

  const tabs = (
    <SegmentedTabs<Tab>
      label="People"
      value={tab}
      items={[
        { value: "people", label: "People", icon: UserIcon, to: "/people" },
        ...(mayManage === false
          ? []
          : [{ value: "chase" as const, label: "Chase", icon: TimerIcon, to: "/people?tab=chase", ...(chasing === undefined || chasing === 0 ? {} : { count: chasing }) }]),
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
        ) : tab !== "groups" && people.state.status === "ready" && people.state.data.mayManage === true ? (
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
  const reloadAll = () => {
    people.reload();
    onboardingRead.reload();
  };

  return (
    <div data-testid="people-page">
      {header}
      {tab === "people" && onboardingRead.state.status === "loading" ? (
        <DoorSkeleton rows={5} />
      ) : tab === "people" ? (
        <>
          {onboardingRead.state.status === "error" ? (
            <div data-testid="onboarding-error" className="mb-4 rounded-g-card border border-g-line">
              <DoorError error={onboardingRead.state.error} onRetry={onboardingRead.reload} />
            </div>
          ) : null}
          <PeopleTable
            rows={rowsOf(rows, onboarding)}
            staged={onboarding !== undefined || rows.some((p) => p.stage !== undefined)}
            groups={groups}
            groupsOf={groupsOf}
            devicesOf={devicesOf}
            onOpen={(row) => (row.kind === "person" ? personSheet.open(row.person.subject) : setInvitationOpen({ id: row.invite.invitationId }))}
            onRemove={manage === undefined ? undefined : setRemoving}
            onResend={page.mayManage === true ? (invite) => void chase.resend(invite) : undefined}
          />
        </>
      ) : tab === "chase" ? (
        onboardingRead.state.status === "loading" ? (
          <DoorSkeleton rows={3} />
        ) : onboardingRead.state.status === "error" ? (
          <DoorError error={onboardingRead.state.error} onRetry={onboardingRead.reload} />
        ) : onboarding === undefined ? null : (
          <ChaseList
            rows={onboarding.rows}
            chaseAfterDays={onboarding.chaseAfterDays}
            mailEnabled={page.mailEnabled === true}
            mayChase={page.mayManage === true}
            chase={chase}
          />
        )
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
      {heldInvite.value === undefined ? null : (
        <InvitationSheet
          open={heldInvite.open}
          invite={heldInvite.value}
          mayResend={page.mayManage === true}
          chase={chase}
          onClose={() => setInvitationOpen(undefined)}
        />
      )}
      {heldGroup.value === undefined ? null : (
        <GroupSheet key={heldGroup.value.id} open={heldGroup.open} group={heldGroup.value} people={rows} onClose={groupSheet.close} onChanged={groupsRead.reload} />
      )}
      <InviteSheet open={inviting} mailEnabled={page.mailEnabled === true} orgName={session.orgName} onClose={() => setInviting(false)} onInvited={reloadAll} />
      {chase.linkModal}
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
  staged,
  groups,
  groupsOf,
  devicesOf,
  onOpen,
  onRemove,
  onResend,
}: {
  rows: readonly Row[];
  staged: boolean;
  groups: readonly ConsoleGroupRow[] | undefined;
  groupsOf: (p: ConsolePersonRow) => string[] | undefined;
  devicesOf: (p: ConsolePersonRow) => GuardDeviceRow[] | undefined;
  onOpen: (row: Row) => void;
  onRemove: ((p: ConsolePersonRow) => void) | undefined;
  onResend: ((invite: OnboardingInviteRow) => void) | undefined;
}) {
  const [q, setQ] = React.useState("");
  const [dir, setDir] = React.useState<"asc" | "desc">("asc");
  const [access, setAccess] = React.useState<string[]>([]);
  const [inGroups, setInGroups] = React.useState<string[]>([]);
  const [stages, setStages] = React.useState<OnboardingStage[]>([]);
  const needle = q.trim().toLowerCase();
  const nameOf = (row: Row) => (row.kind === "person" ? (row.person.name ?? row.person.email) : row.invite.email);
  const roleKeyOf = (row: Row) => (row.kind === "person" ? accessOf(row.person).key : row.invite.role);
  const groupsOfRow = (row: Row) => (row.kind === "person" ? groupsOf(row.person) : undefined);
  const count = (stage: OnboardingStage) => rows.filter((row) => stageOf(row) === stage).length;
  const shown = rows
    .filter((row) => needle === "" || (row.kind === "person" ? [row.person.name, row.person.email] : [row.invite.email]).some((v) => v?.toLowerCase().includes(needle)))
    .filter((row) => access.length === 0 || access.includes(roleKeyOf(row)))
    .filter((row) => inGroups.length === 0 || (groupsOfRow(row) ?? []).some((g) => inGroups.includes(g)))
    .filter((row) => {
      const stage = stageOf(row);
      return stages.length === 0 || (stage !== undefined && stages.includes(stage));
    })
    .sort((a, b) => (dir === "asc" ? 1 : -1) * nameOf(a).localeCompare(nameOf(b)));
  const columns: DataColumn<Row>[] = [
    {
      id: "name",
      header: "Name",
      sort: dir,
      onSort: () => setDir((d) => (d === "asc" ? "desc" : "asc")),
      cell: (row) =>
        row.kind === "person" ? <PersonTitle email={row.person.email} name={row.person.name} image={row.person.image} /> : <PersonTitle email={row.invite.email} sub="Invitation pending" />,
    },
    ...(staged
      ? [
          {
            id: "stage",
            header: "Stage",
            width: "220px",
            cell: (row: Row) => {
              const place = placeOf(row);
              return place === undefined ? EMPTY : <StageChip stage={place.stage} since={place.since} />;
            },
          },
        ]
      : []),
    {
      id: "role",
      header: "Role",
      width: "120px",
      cell: (row) => {
        const a = row.kind === "person" ? accessOf(row.person) : ROLES[row.invite.role];
        return <Pill tone={a.tone}>{a.label}</Pill>;
      },
    },
    {
      id: "groups",
      header: "Groups",
      width: "16%",
      cell: (row) => {
        const names = groupsOfRow(row);
        return <span className="block truncate">{names === undefined || names.length === 0 ? EMPTY : names.join(", ")}</span>;
      },
    },
    {
      id: "devices",
      header: "Devices",
      width: "100px",
      cell: (row) => {
        const owned = row.kind === "person" ? devicesOf(row.person) : undefined;
        return owned === undefined ? EMPTY : <CountBadge count={owned.length} />;
      },
    },
    {
      id: "signed-in",
      header: "Last signed in",
      width: "150px",
      cell: (row) => (row.kind === "invite" || row.person.lastSeenAt === undefined || row.person.lastSeenAt === null ? EMPTY : <When iso={row.person.lastSeenAt} />),
    },
    {
      id: "added",
      header: "Added",
      width: "130px",
      cell: (row) => <span className="whitespace-nowrap">{dateWords(row.kind === "person" ? row.person.createdAt : row.invite.stageSince)}</span>,
    },
  ];
  const groupNames = [...new Set((groups ?? []).map((g) => g.name))].sort((a, b) => a.localeCompare(b));
  const menuFor = (row: Row): RowMenuItem[] => {
    if (row.kind === "invite") return onResend === undefined ? [] : [{ label: "Re-send invitation", icon: MailIcon, onSelect: () => onResend(row.invite) }];
    return onRemove !== undefined && row.person.mayManage === true
      ? [{ label: "Remove from organisation", icon: UserMinusIcon, destructive: true, onSelect: () => onRemove(row.person) }]
      : [];
  };
  return (
    <>
      <AttentionBar late={count("late")} tampered={count("tampered")} onShow={(stage) => setStages([stage])} />
      <ListToolbar
        search={{ value: q, onChange: setQ, placeholder: "Search people…" }}
        filter={
          <FilterPopover
            facets={[
              ...(staged
                ? [{ id: "stage", label: "Stage", options: STAGE_OPTIONS.map((o) => ({ ...o, count: count(o.value) })), selected: stages, onChange: (next: string[]) => setStages(next.filter(isStage)) }]
                : []),
              { id: "role", label: "Role", options: Object.entries(ACCESS).map(([value, a]) => ({ value, label: a.label })), selected: access, onChange: setAccess },
              ...(groupNames.length === 0 ? [] : [{ id: "group", label: "Group", options: groupNames.map((g) => ({ value: g, label: g })), selected: inGroups, onChange: setInGroups }]),
            ]}
          />
        }
      />
      <DataTable<Row>
        label="People"
        rows={shown}
        rowKey={(row) => (row.kind === "person" ? row.person.subject : `invite:${row.invite.invitationId}`)}
        columns={columns}
        onRowClick={onOpen}
        rowLabel={(row) => (row.kind === "person" ? `${nameOf(row)}, details` : `${nameOf(row)}, invitation`)}
        rowMenu={menuFor}
        menuLabel={(row) => `Actions for ${nameOf(row)}`}
        minWidth={staged ? 1020 : 820}
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
                    setStages([]);
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
