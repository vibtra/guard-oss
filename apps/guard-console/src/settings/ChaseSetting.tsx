import * as React from "react";
import { toast, toastError } from "@vibtra/ui/react";
import { ChaseAfterDays, type OnboardingSettings } from "@vibtra/console-api";
import { SelectInput, SettingsCard, SettingsRow, SettingsSection, type SelectOption } from "@/components/kit";
import { refusalWords } from "../api/client";
import { useDoor } from "../api/useDoor";
import { plural } from "../guard/words";
import { onboardingDoor } from "../people/doors";
import { DoorError, DoorSkeleton } from "../shell/DoorState";

const PRESETS: readonly ChaseAfterDays[] = [3, 7, 14, 30];

const chaseOptions = (current: ChaseAfterDays): SelectOption<string>[] => [
  ...(PRESETS.includes(current) ? [] : [{ value: String(current), label: `${plural(current, "day", "days")} (set elsewhere)` }]),
  ...PRESETS.map((days) => ({ value: String(days), label: plural(days, "day", "days") })),
];

export function ChaseSetting() {
  const door = useDoor(() => onboardingDoor.settings(), []);
  return (
    <SettingsSection title="Onboarding">
      {door.state.status === "loading" ? (
        <DoorSkeleton rows={1} />
      ) : door.state.status === "error" ? (
        <DoorError error={door.state.error} onRetry={door.reload} />
      ) : (
        <ChaseRow loaded={door.state.data} />
      )}
    </SettingsSection>
  );
}

function ChaseRow({ loaded }: { loaded: OnboardingSettings }) {
  const [days, setDays] = React.useState(loaded.chaseAfterDays);
  const [busy, setBusy] = React.useState(false);
  const save = async (value: string) => {
    const next = ChaseAfterDays.safeParse(Number(value));
    if (!next.success || next.data === days) return;
    setBusy(true);
    try {
      const saved = await onboardingDoor.setChaseAfterDays(next.data);
      setDays(saved.chaseAfterDays);
      toast.success(`People who have not enrolled a Mac after ${plural(saved.chaseAfterDays, "day", "days")} are on the chase list.`);
    } catch (error) {
      toastError("The chase list setting was not saved", refusalWords(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsCard>
      <SettingsRow
        title={<span id="chase-title">Chase after</span>}
        description={<span id="chase-desc">Someone invited or signed in who has not enrolled a Mac for this long is put on the chase list under People.</span>}
        control={{
          kind: "control",
          children: (
            <SelectInput<string>
              aria-labelledby="chase-title"
              aria-describedby="chase-desc"
              data-testid="chase-after-days"
              disabled={busy}
              value={String(days)}
              options={chaseOptions(days)}
              onValueChange={(value) => void save(value)}
            />
          ),
        }}
      />
    </SettingsCard>
  );
}
