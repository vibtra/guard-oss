import * as React from "react";
import { PlusIcon, UsersIcon } from "lucide-react";
import { toast, toastError } from "@vibtra/ui/react";
import type { ConsoleGroupRow, ConsolePersonRow } from "@vibtra/console-api";
import {
  ActionButton,
  Checkbox,
  ComboboxInput,
  DetailSheet,
  EmptyState,
  Field,
  FieldStack,
  FormSheet,
  IconTile,
  Pill,
  SearchInput,
  SheetList,
  SheetListRow,
  SheetSection,
  TextInput,
  cn,
} from "@/components/kit";
import { refusalWords } from "../api/client";
import { plural } from "../guard/words";
import { groupsDoor } from "./doors";
import { PersonTitle, dateWords } from "./fleet";

export function GroupSheet({
  open,
  group,
  people,
  onClose,
  onChanged,
}: {
  open: boolean;
  group: ConsoleGroupRow;
  people: readonly ConsolePersonRow[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [adding, setAdding] = React.useState("");
  const [addError, setAddError] = React.useState<string | undefined>(undefined);
  const [busy, setBusy] = React.useState<string | undefined>(undefined);
  const members = group.members ?? [];
  const inGroup = new Set(members.map((m) => m.email.toLowerCase()));
  const candidates = people.filter((p) => !inGroup.has(p.email.toLowerCase()));
  const nameOf = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())?.name;
  const who = (email: string) => nameOf(email) ?? email;

  const add = async () => {
    if (busy !== undefined) return;
    if (adding === "") {
      setAddError("Choose a person to add.");
      document.getElementById("add-person")?.focus();
      return;
    }
    setBusy("add");
    try {
      await groupsDoor.addMember(group.id, adding);
      toast.success(`${who(adding)} added to ${group.name}`);
      setAdding("");
      onChanged();
    } catch (error) {
      toastError(`${who(adding)} was not added to ${group.name}`, refusalWords(error));
    } finally {
      setBusy(undefined);
    }
  };
  const remove = async (email: string) => {
    if (busy !== undefined) return;
    setBusy(email);
    try {
      await groupsDoor.removeMember(group.id, email);
      toast.success(`${who(email)} removed from ${group.name}`, {
        action: {
          label: "Undo",
          onClick: () => {
            groupsDoor.addMember(group.id, email).then(onChanged, (error: unknown) => toastError(`${who(email)} was not added back to ${group.name}`, refusalWords(error)));
          },
        },
      });
      onChanged();
    } catch (error) {
      toastError(`${who(email)} was not removed from ${group.name}`, refusalWords(error));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      icon={<IconTile size={40} icon={UsersIcon} />}
      title={group.name}
      pills={<Pill size="header">{plural(group.memberCount, "person", "people")}</Pill>}
      sub={`Made ${dateWords(group.createdAt)}${group.createdBy === undefined ? "" : ` by ${group.createdBy}`}`}
    >
      <div data-testid="group-sheet" className="flex flex-col gap-4">
        <SheetSection title="People in this group" description="Rules that name this group apply to them at their laptop’s next check-in.">
          {candidates.length === 0 ? null : (
            <form
              noValidate
              className="flex items-start gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void add();
              }}
            >
              <Field label="Person to add" htmlFor="add-person" error={addError} className="min-w-0 flex-1">
                <ComboboxInput<string>
                  id="add-person"
                  placeholder="Search people"
                  value={adding}
                  aria-invalid={addError === undefined ? undefined : true}
                  {...(addError === undefined ? {} : { "aria-describedby": "add-person-error" })}
                  onValueChange={(email) => {
                    setAdding(email);
                    setAddError(undefined);
                  }}
                  options={candidates.map((p) => ({
                    value: p.email,
                    label: p.name ?? p.email,
                    description: p.name === undefined ? undefined : p.email,
                    textValue: `${p.name ?? ""} ${p.email}`,
                  }))}
                />
              </Field>
              <ActionButton type="submit" icon={PlusIcon} loading={busy === "add"} className="mt-[25px]">
                Add
              </ActionButton>
            </form>
          )}
          {members.length === 0 ? (
            <div className="rounded-g-card border border-g-line">
              <EmptyState icon={UsersIcon} title="Nobody in this group yet" description="Add a person above. Rules that name this group apply to them at once." />
            </div>
          ) : (
            <SheetList
              label="Members"
              items={members}
              itemKey={(m) => m.email}
              render={(m) => (
                <div data-testid="group-member">
                  <SheetListRow
                    title={<PersonTitle email={m.email} name={m.name ?? nameOf(m.email)} />}
                    trailing={
                      <ActionButton variant="ghost" loading={busy === m.email} onClick={() => void remove(m.email)} aria-label={`Remove ${m.name ?? m.email}`}>
                        Remove
                      </ActionButton>
                    }
                  />
                </div>
              )}
            />
          )}
        </SheetSection>
        <p className="text-12 text-g-muted">Rename or delete a group in the Vibtra console.</p>
      </div>
    </DetailSheet>
  );
}

export function AddGroupSheet({ open, people, onClose, onDone }: { open: boolean; people: readonly ConsolePersonRow[]; onClose: () => void; onDone: (groupId: string) => void }) {
  const [name, setName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | undefined>(undefined);
  const [q, setQ] = React.useState("");
  const [picked, setPicked] = React.useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    if (open) return;
    setName("");
    setNameError(undefined);
    setQ("");
    setPicked(new Set());
  }, [open]);

  const needle = q.trim().toLowerCase();
  const shown = people.filter((p) => needle === "" || [p.name, p.email].some((v) => v?.toLowerCase().includes(needle)));
  const toggle = (email: string, on: boolean) =>
    setPicked((was) => {
      const next = new Set(was);
      if (on) next.add(email);
      else next.delete(email);
      return next;
    });

  const create = async () => {
    if (busy) return;
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Give the group a name.");
      document.getElementById("group-name")?.focus();
      return;
    }
    setBusy(true);
    try {
      const made = await groupsDoor.create(trimmed);
      const failed: string[] = [];
      for (const email of picked) {
        try {
          await groupsDoor.addMember(made.row.id, email);
        } catch {
          failed.push(email);
        }
      }
      if (failed.length === 0) toast.success(`${trimmed} is ready`);
      else
        toastError(
          `${trimmed} was made, but ${plural(failed.length, "person was", "people were")} not added`,
          `Add ${failed.join(", ")} from the group’s sheet.`,
        );
      onDone(made.row.id);
    } catch (error) {
      toastError(`${trimmed} was not made`, refusalWords(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <FormSheet open={open} onClose={onClose} title="Add group" primaryLabel="Add group" onPrimary={() => void create()} busy={busy}>
      <FieldStack data-testid="add-group" className="gap-6">
        <Field label="Name" htmlFor="group-name" error={nameError}>
          <TextInput
            id="group-name"
            maxLength={64}
            placeholder="Finance"
            aria-invalid={nameError === undefined ? undefined : true}
            {...(nameError === undefined ? {} : { "aria-describedby": "group-name-error" })}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(undefined);
            }}
          />
        </Field>
        <Field label="People">
          <div className="flex flex-col gap-2">
            <SearchInput search={{ value: q, onChange: setQ, placeholder: "Search people…" }} className="h-[38px] w-full" />
            {shown.length === 0 ? (
              <p className="px-1 py-3 text-13 text-g-muted">Nobody matches “{q.trim()}”.</p>
            ) : (
              <ul aria-label="People to add" className="overflow-hidden rounded-g-card border border-g-line">
                {shown.map((p) => {
                  const checked = picked.has(p.email);
                  return (
                    <li key={p.subject} className="border-t border-g-divider first:border-t-0">
                      <label className={cn("flex cursor-pointer items-center gap-3 px-4 py-2.5 transition-[background-color] duration-(--g-dur-fast) hover:bg-g-hover", checked && "bg-g-header")}>
                        <Checkbox checked={checked} onCheckedChange={(on) => toggle(p.email, on)} />
                        <PersonTitle email={p.email} name={p.name} />
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </Field>
      </FieldStack>
    </FormSheet>
  );
}
