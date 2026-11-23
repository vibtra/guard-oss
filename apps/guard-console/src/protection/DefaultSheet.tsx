import * as React from "react";
import { FormSheet, RadioCards } from "@/components/kit";
import { MODES, type Mode } from "./model";
import { MODE_WORD } from "./modes";

export function DefaultSheet({ open, value, onClose, onPreview }: { open: boolean; value: Mode; onClose: () => void; onPreview: (mode: Mode) => void }) {
  const [choice, setChoice] = React.useState(value);
  React.useEffect(() => {
    if (open) setChoice(value);
  }, [open, value]);
  return (
    <FormSheet
      open={open}
      size="sm"
      title="Default mode"
      description="Everyone you have not set on their own follows the default. Before anything changes you see what it does to each person."
      primaryLabel="Preview"
      primaryDisabled={choice === value}
      onPrimary={() => onPreview(choice)}
      onClose={onClose}
    >
      <RadioCards
        name="default-mode"
        label="Default mode"
        value={choice}
        onValueChange={setChoice}
        options={MODES.map((mode) => ({ value: mode, title: MODE_WORD[mode].label, description: MODE_WORD[mode].meaning, icon: MODE_WORD[mode].icon }))}
      />
    </FormSheet>
  );
}
