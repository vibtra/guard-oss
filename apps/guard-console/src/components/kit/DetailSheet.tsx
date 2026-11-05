import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import { useNarrow } from "@/components/ui/sidebar";
import { RowMenu, type RowMenuItem } from "@/components/patterns/RowMenu";
import { SegmentedTabs, type SegmentedTab } from "./SegmentedTabs";
import { useMountOpen } from "./useHeld";

export const SHEET_MOTION =
  "transition-[opacity,translate] duration-(--g-dur-sheet) ease-g data-ending-style:duration-(--g-dur-exit) data-starting-style:translate-x-6 data-starting-style:opacity-0 data-ending-style:translate-x-6 data-ending-style:opacity-0 rtl:data-starting-style:-translate-x-6 rtl:data-ending-style:-translate-x-6";

export const SHEET_BACKDROP =
  "fixed inset-0 z-50 bg-g-overlay-sheet transition-[opacity] duration-(--g-dur-sheet) ease-g data-ending-style:duration-(--g-dur-exit) data-ending-style:opacity-0 data-starting-style:opacity-0";

export function OverlayClose({ label = "Close", className }: { label?: string; className?: string }) {
  return (
    <Dialog.Close
      data-slot="overlay-close"
      aria-label={label}
      className={cn(
        "focus-knox inline-flex size-8 shrink-0 items-center justify-center rounded-g-control text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink",
        className,
      )}
    >
      <XIcon aria-hidden className="size-4" />
    </Dialog.Close>
  );
}

export function DetailSheet<V extends string = string>({
  open,
  onClose,
  icon,
  title,
  pills,
  sub,
  menu,
  menuLabel,
  tabs,
  tab,
  onTabChange,
  tabsLabel = "Sections",
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  icon?: React.ReactNode;
  title: React.ReactNode;
  pills?: React.ReactNode;
  sub?: React.ReactNode;
  menu?: readonly RowMenuItem[];
  menuLabel?: string;
  tabs?: readonly SegmentedTab<V>[];
  tab?: V;
  onTabChange?: (value: V) => void;
  tabsLabel?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const narrow = useNarrow();
  const idPrefix = React.useId().replace(/:/g, "");
  const popupRef = React.useRef<HTMLDivElement>(null);
  const showTabs = tabs !== undefined && tabs.length > 0 && tab !== undefined;
  const shown = useMountOpen(open);
  return (
    <Dialog.Root
      open={shown}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop data-slot="detail-sheet-overlay" className={SHEET_BACKDROP} />
        <Dialog.Popup
          ref={popupRef}
          initialFocus={popupRef}
          tabIndex={-1}
          data-slot="detail-sheet"
          data-narrow={narrow ? "" : undefined}
          className={cn(
            "fixed z-50 flex flex-col overflow-hidden bg-g-surface text-g-ink outline-hidden",
            SHEET_MOTION,
            narrow
              ? "inset-0"
              : "top-(--g-sheet-inset) end-(--g-sheet-inset) bottom-(--g-sheet-inset) w-[min(var(--g-sheet-w),calc(100vw_-_24px))] rounded-g-sheet border border-g-line shadow-g-sheet",
            className,
          )}
        >
          <header data-slot="detail-sheet-header" className="flex shrink-0 items-start gap-3 border-b border-g-line py-4 ps-6 pe-4">
            {icon === undefined ? null : <div className="pt-0.5">{icon}</div>}
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Dialog.Title className="min-w-0 truncate text-18 font-medium text-g-ink-strong">{title}</Dialog.Title>
                {pills}
              </div>
              {sub === undefined ? null : <Dialog.Description className="text-13 text-g-muted">{sub}</Dialog.Description>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {menu === undefined ? null : <RowMenu label={menuLabel ?? "More actions"} items={menu} />}
              <OverlayClose />
            </div>
          </header>
          <div data-slot="detail-sheet-body" className="scrollbar-knox min-h-0 flex-1 overflow-y-auto overscroll-contain p-6 max-md:p-4">
            {showTabs ? (
              <>
                <SegmentedTabs
                  items={tabs}
                  value={tab}
                  {...(onTabChange === undefined ? {} : { onValueChange: onTabChange })}
                  label={tabsLabel}
                  idPrefix={idPrefix}
                  className="mb-4"
                />
                <div role="tabpanel" id={`${idPrefix}-panel-${tab}`} aria-labelledby={`${idPrefix}-tab-${tab}`}>
                  {children}
                </div>
              </>
            ) : (
              children
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function SheetDefinitions({ rows, className }: { rows: readonly { label: string; value: React.ReactNode }[]; className?: string }) {
  return (
    <dl data-slot="sheet-definitions" className={cn("overflow-hidden rounded-g-card border border-g-line bg-g-surface", className)}>
      {rows.map((row) => (
        <div key={row.label} className="grid grid-cols-[128px_minmax(0,1fr)] items-center gap-4 border-t border-g-divider px-4 py-3 first:border-t-0 max-md:grid-cols-1 max-md:gap-1">
          <dt className="text-13 text-g-muted">{row.label}</dt>
          <dd className="min-w-0 text-14 break-words text-g-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function SheetList<Item>({
  items,
  itemKey,
  render,
  label,
  className,
}: {
  items: readonly Item[];
  itemKey: (item: Item) => string;
  render: (item: Item) => React.ReactNode;
  label: string;
  className?: string;
}) {
  return (
    <ul aria-label={label} data-slot="sheet-list" className={cn("overflow-hidden rounded-g-card border border-g-line bg-g-surface", className)}>
      {items.map((item) => (
        <li key={itemKey(item)} className="border-t border-g-divider first:border-t-0">
          {render(item)}
        </li>
      ))}
    </ul>
  );
}

export function SheetListRow({ icon, title, sub, trailing }: { icon?: React.ReactNode; title: React.ReactNode; sub?: React.ReactNode; trailing?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 px-4 py-2.5">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-14 font-medium text-g-ink">{title}</span>
        {sub === undefined ? null : <span className="truncate text-13 text-g-muted">{sub}</span>}
      </div>
      {trailing === undefined ? null : <div className="flex shrink-0 items-center gap-2">{trailing}</div>}
    </div>
  );
}
