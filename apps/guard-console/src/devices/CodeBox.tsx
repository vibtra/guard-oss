import { CopyIconButton } from "@/components/patterns/CopyIconButton";

export function CodeBox({ label, value }: { label: string; value: string }) {
  return (
    <div role="group" aria-label={label} data-slot="code-box" className="rounded-g-card border border-g-line bg-g-header p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <span className="text-14 font-[600] text-g-ink">{label}</span>
        <CopyIconButton text={value} label={`Copy the ${label.toLowerCase()}`} />
      </div>
      <p className="font-mono text-13 break-all text-g-ink select-all">{value}</p>
    </div>
  );
}
