import * as React from "react";
import { useNavigate } from "react-router";
import { ActivityIcon, LaptopIcon, LayoutGridIcon, ShieldIcon, UserMinusIcon } from "lucide-react";
import { GeneratedAvatar, toast, toastError } from "@vibtra/ui/react";
import type { GuardDeviceRow } from "@vibtra/guard-contract";
import type { ConsolePersonRow } from "@vibtra/console-api";
import { When } from "../guard/words";
import {
  ConfirmModal,
  DetailSheet,
  EMPTY,
  EmptyState,
  Field,
  IconTile,
  Pill,
  SelectInput,
  SheetDefinitions,
  SheetList,
  SheetListRow,
  SheetSection,
  type PillTone,
  type SelectOption,
} from "@/components/kit";
import { refusalSentence } from "../api/client";
import { peopleDoor } from "./doors";
import { DevicePill, EventList, dateWords, seenWords, useEvents } from "./fleet";
import { ROLES, changedWords, confirmWords, lockedReason, needsConfirm, roleOf, type OrgRole } from "./roles";

export const ACCESS: Readonly<Record<string, { label: string; tone: PillTone }>> = ROLES;
export const accessOf = (p: ConsolePersonRow): { key: string; label: string; tone: PillTone } => {
  const key = roleOf(p);
  return { key, ...(ACCESS[key] ?? { label: key, tone: "muted" as const }) };
};

export interface PersonManagement {
  viewer: OrgRole | undefined;
  owners: number;
  onChanged: () => void;
  onRemove: (person: ConsolePersonRow) => void;
}

type Tab = "overview" | "devices" | "activity";

export function PersonSheet({
  open,
  person,
  groups,
  devices,
  onClose,
  manage,
}: {
  open: boolean;
  person: ConsolePersonRow;
  manage?: PersonManagement;
  groups: readonly string[] | undefined;
  devices: readonly GuardDeviceRow[] | undefined;
  onClose: () => void;
}) {
  const [tab, setTab] = React.useState<Tab>("overview");
  const navigate = useNavigate();
  const events = useEvents({ personUserId: person.subject });
  const access = accessOf(person);
  const rows: { label: string; value: React.ReactNode }[] = [
    { label: "Email", value: person.email },
    { label: "Role", value: access.label },
    { label: "Groups", value: groups === undefined ? EMPTY : groups.length === 0 ? "None" : groups.join(", ") },
    { label: "Added", value: dateWords(person.createdAt) },
    { label: "Last signed in", value: person.lastSeenAt === undefined || person.lastSeenAt === null ? EMPTY : <When iso={person.lastSeenAt} /> },
    ...(person.identitySource === undefined ? [] : [{ label: "Signs in with", value: person.identitySource === "password" ? "Email and password" : person.identitySource }]),
  ];
  return (
    <DetailSheet<Tab>
      open={open}
      onClose={onClose}
      icon={<GeneratedAvatar seed={person.email} name={person.name ?? person.email} kind="person" photoUrl={person.image} showTitle={false} className="size-10 shrink-0" />}
      title={person.name ?? person.email}
      pills={
        <Pill size="header" tone={access.tone}>
          {access.label}
        </Pill>
      }
      sub={person.email}
      {...(manage !== undefined && person.mayManage === true
        ? { menu: [{ label: "Remove from organisation", icon: UserMinusIcon, destructive: true, onSelect: () => manage.onRemove(person) }], menuLabel: `Actions for ${person.name ?? person.email}` }
        : {})}
      tabsLabel="Person sections"
      tabs={[
        { value: "overview", label: "Overview", icon: LayoutGridIcon },
        { value: "devices", label: "Devices", icon: LaptopIcon },
        { value: "activity", label: "Activity", icon: ActivityIcon },
      ]}
      tab={tab}
      onTabChange={setTab}
    >
      <div data-testid="person-sheet">
        {tab === "overview" ? (
          <>
            {manage === undefined ? null : <RoleSection person={person} manage={manage} />}
            <SheetSection title="General information" className="pt-2">
              <SheetDefinitions rows={rows} />
            </SheetSection>
          </>
        ) : tab === "devices" ? (
          devices === undefined ? (
            <div className="rounded-g-card border border-g-line">
              <EmptyState icon={LaptopIcon} title="Devices are not available" description="The devices list did not load. Open the Devices page to try again." />
            </div>
          ) : devices.length === 0 ? (
            <div className="rounded-g-card border border-g-line">
              <EmptyState icon={LaptopIcon} title="No laptop enrolled" description="Enrol a laptop for this person from the Devices page." />
            </div>
          ) : (
            <SheetList
              label="Their devices"
              items={devices}
              itemKey={(d) => d.deviceId}
              render={(d) => (
                <button
                  type="button"
                  data-testid="person-device"
                  onClick={() => navigate(`/devices?device=${encodeURIComponent(d.deviceId)}`)}
                  className="focus-knox block w-full text-start outline-hidden transition-[background-color] duration-(--g-dur-fast) hover:bg-g-hover"
                >
                  <SheetListRow icon={<IconTile icon={LaptopIcon} />} title={d.hostname} sub={[d.modelIdentifier, seenWords(d.lastSeenAt)].filter(Boolean).join(" · ")} trailing={<DevicePill row={d} />} />
                </button>
              )}
            />
          )
        ) : (
          <EventList door={events} context="person" emptyText="Nothing recorded for this person yet." />
        )}
      </div>
    </DetailSheet>
  );
}

function RoleSection({ person, manage }: { person: ConsolePersonRow; manage: PersonManagement }) {
  const current = roleOf(person);
  const [pending, setPending] = React.useState<OrgRole | undefined>(undefined);
  const [busy, setBusy] = React.useState(false);
  const refocus = React.useRef(false);
  const roleTrigger = () => document.getElementById("person-role");
  React.useEffect(() => {
    if (busy || !refocus.current) return;
    refocus.current = false;
    roleTrigger()?.focus();
  }, [busy]);
  const may = person.mayManage === true;
  const options: SelectOption<OrgRole>[] = (["owner", "admin", "member"] as const).map((role) => ({
    value: role,
    label: ROLES[role].label,
    description: role === "owner" && manage.viewer !== "owner" ? "Only an owner can make someone an owner." : ROLES[role].description,
    disabled: role === "owner" && manage.viewer !== "owner",
  }));
  const save = async (to: OrgRole) => {
    refocus.current = pending !== undefined;
    setBusy(true);
    try {
      await peopleDoor.setRole(person.subject, to);
      toast.success(changedWords(person, to));
      setPending(undefined);
      manage.onChanged();
    } catch (error) {
      toastError(`${person.name ?? person.email}’s role was not changed`, refusalSentence(error));
      setPending(undefined);
    } finally {
      setBusy(false);
    }
  };
  const choose = (to: OrgRole) => {
    if (to === current || busy) return;
    if (needsConfirm(current, to)) setPending(to);
    else void save(to);
  };
  const words = pending === undefined ? undefined : confirmWords(person, current, pending);
  return (
    <div data-testid="person-role" className="flex flex-col pt-2 pb-6">
      <Field label={<span id="person-role-label">Role</span>} htmlFor="person-role" hint={may ? undefined : lockedReason(person, manage.viewer, manage.owners)}>
        <SelectInput<OrgRole>
          id="person-role"
          aria-labelledby="person-role-label"
          {...(may ? {} : { "aria-describedby": "person-role-hint" })}
          disabled={!may || busy}
          value={current}
          icon={ShieldIcon}
          options={options}
          onValueChange={choose}
          wrapperClassName="max-w-[320px]"
        />
      </Field>
      <ConfirmModal
        open={pending !== undefined}
        onClose={() => setPending(undefined)}
        finalFocus={roleTrigger}
        title={words?.title ?? ""}
        confirmLabel={words?.label ?? "Change role"}
        destructive={false}
        busy={busy}
        onConfirm={() => pending !== undefined && void save(pending)}
      >
        {words?.body ?? ""}
      </ConfirmModal>
    </div>
  );
}
