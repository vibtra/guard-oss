import * as React from "react";
import { Select as SelectPrimitive } from "@base-ui/react/select";
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import { CheckIcon, ChevronDownIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export function FieldStack({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field-stack" className={cn("flex flex-col gap-4", className)} {...props} />;
}

export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="field" className={cn("flex flex-col gap-1.5", className)}>
      {htmlFor === undefined ? (
        <span className="text-13 font-medium text-g-ink">{label}</span>
      ) : (
        <label htmlFor={htmlFor} className="text-13 font-medium text-g-ink">
          {label}
        </label>
      )}
      {children}
      {hint === undefined ? null : (
        <p id={htmlFor === undefined ? undefined : `${htmlFor}-hint`} className="text-12 text-g-muted">
          {hint}
        </p>
      )}
      {error === undefined || error === null ? null : (
        <p id={htmlFor === undefined ? undefined : `${htmlFor}-error`} role="alert" data-slot="field-error" className="g-rise text-12 text-g-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function Problem({ id, children, className }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <p id={id} role="alert" data-slot="problem" className={cn("g-rise rounded-g-control border border-g-pill-bad-line bg-g-pill-bad-bg px-3 py-2 text-13 text-g-pill-bad-ink", className)}>
      {children}
    </p>
  );
}

const BOX =
  "h-(--g-input-h) w-full min-w-0 rounded-g-control border border-g-line-control bg-g-surface text-14 text-g-ink focus-field placeholder:text-g-muted disabled:cursor-not-allowed disabled:opacity-60 aria-invalid:border-g-danger max-md:text-16";

export function TextInput({ className, ...props }: React.ComponentProps<"input">) {
  return <input data-slot="text-input" className={cn(BOX, "px-3", className)} {...props} />;
}

export function TextAreaInput({ className, rows = 3, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="text-area-input" rows={rows} className={cn(BOX, "h-auto resize-none px-3 py-2 leading-5", className)} {...props} />;
}

export interface SelectOption<V extends string = string> {
  value: V;
  label: React.ReactNode;
  icon?: LucideIcon;
  iconClassName?: string;
  description?: React.ReactNode;
  disabled?: boolean;
  separatorBefore?: boolean;
  textValue?: string;
}

const textOf = (option: SelectOption): string => option.textValue ?? labelOf(option);
const labelOf = (option: SelectOption): string => (typeof option.label === "string" ? option.label : option.value);
const fold = (words: string): string => words.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase();
const matches = (words: string, query: string): boolean => fold(words).includes(fold(query.trim()));

const POPUP =
  "scrollbar-knox max-h-(--available-height) min-w-(--anchor-width) origin-(--transform-origin) overflow-y-auto overscroll-contain rounded-lg border border-g-divider bg-g-surface p-1 text-g-ink shadow-g-pop outline-hidden v-popup-motion data-ending-style:duration-(--g-dur-fast)";

const ITEM =
  "relative flex min-h-8 cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-14 text-g-ink outline-hidden focus-knox [--v-focus-offset:-2px] data-highlighted:bg-g-tint data-disabled:pointer-events-none data-disabled:opacity-50";

function OptionRow({ option, indicator }: { option: SelectOption; indicator: React.ReactNode }) {
  const Icon = option.icon;
  return (
    <>
      {Icon === undefined ? null : <Icon aria-hidden className={cn("size-4 shrink-0", option.iconClassName ?? "text-g-muted")} />}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate">{option.label}</span>
        {option.description === undefined ? null : <span className="text-12 text-g-muted">{option.description}</span>}
      </span>
      {indicator}
    </>
  );
}

const SEPARATOR = "-mx-1 my-1 h-px bg-g-divider";

interface SelectInputProps<V extends string> {
  value: V | "";
  onValueChange: (value: V) => void;
  options: readonly SelectOption<V>[];
  placeholder?: string;
  id?: string;
  name?: string;
  disabled?: boolean;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
  size?: "md" | "sm";
  className?: string;
  wrapperClassName?: string;
  icon?: LucideIcon;
  iconClassName?: string;
}

export function SelectInput<V extends string>(props: SelectInputProps<V>): React.JSX.Element {
  return <BaseSelect {...props} />;
}

function BaseSelect<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  id,
  name,
  disabled,
  size = "md",
  className,
  wrapperClassName,
  icon,
  iconClassName,
  ...aria
}: SelectInputProps<V>) {
  const chosen = options.find((option) => option.value === value);
  const Icon = icon ?? chosen?.icon;
  const glyphClass = icon === undefined ? chosen?.iconClassName : iconClassName;
  const items = React.useMemo(() => options.map((option) => ({ value: option.value, label: option.label })), [options]);
  return (
    <SelectPrimitive.Root<V>
      value={value === "" ? null : value}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next);
      }}
      items={items}
      disabled={disabled}
      {...(name === undefined ? {} : { name })}
    >
      <span data-slot="select-input" data-size={size} className={cn("relative flex w-full min-w-0 items-center", wrapperClassName)}>
        <SelectPrimitive.Trigger
          id={id}
          {...aria}
          className={cn(
            BOX,
            "group/select flex cursor-pointer items-center gap-2 text-start data-disabled:cursor-not-allowed data-disabled:opacity-60 data-popup-open:border-(--v-line-active)",
            size === "sm" ? "h-8" : "",
            Icon === undefined ? "ps-3" : "ps-9",
            "pe-9",
            className,
          )}
        >
          {Icon === undefined ? null : <Icon aria-hidden className={cn("pointer-events-none absolute start-3 size-4", glyphClass ?? "text-g-muted")} />}
          <SelectPrimitive.Value placeholder={placeholder} className="min-w-0 flex-1 truncate data-placeholder:text-g-muted" />
          <ChevronDownIcon
            aria-hidden
            className="pointer-events-none absolute end-3 size-4 text-g-muted transition-[rotate] duration-(--g-dur) ease-g group-data-popup-open/select:rotate-180"
          />
        </SelectPrimitive.Trigger>
      </span>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Positioner sideOffset={4} alignItemWithTrigger={false} className="z-50 outline-hidden">
          <SelectPrimitive.Popup data-slot="select-popup" className={POPUP}>
            <SelectPrimitive.List>
              {options.map((option) => (
                <React.Fragment key={option.value}>
                  {option.separatorBefore === true ? <SelectPrimitive.Separator className={SEPARATOR} /> : null}
                  <SelectPrimitive.Item value={option.value} label={textOf(option)} disabled={option.disabled} data-slot="select-item" className={ITEM}>
                    <OptionRow
                      option={option}
                      indicator={
                        <SelectPrimitive.ItemIndicator className="ms-auto flex shrink-0">
                          <CheckIcon aria-hidden className="size-4" />
                        </SelectPrimitive.ItemIndicator>
                      }
                    />
                  </SelectPrimitive.Item>
                </React.Fragment>
              ))}
            </SelectPrimitive.List>
          </SelectPrimitive.Popup>
        </SelectPrimitive.Positioner>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export function ComboboxInput<V extends string>({
  value,
  onValueChange,
  options,
  placeholder,
  emptyText = "No matches",
  id,
  name,
  disabled,
  size = "md",
  className,
  wrapperClassName,
  ...aria
}: Omit<SelectInputProps<V>, "icon" | "iconClassName"> & {
  emptyText?: string;
}) {
  const chosen = options.find((option) => option.value === value) ?? null;
  const Icon = chosen?.icon;
  return (
    <ComboboxPrimitive.Root<SelectOption<V>>
      items={options}
      value={chosen}
      onValueChange={(next) => {
        if (next !== null) onValueChange(next.value);
      }}
      itemToStringLabel={labelOf}
      itemToStringValue={(option) => option.value}
      filter={(option, query) => matches(textOf(option), query)}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
      {...(name === undefined ? {} : { name })}
    >
      <span data-slot="combobox-input" data-size={size} className={cn("relative flex w-full min-w-0 items-center", wrapperClassName)}>
        {Icon === undefined ? null : <Icon aria-hidden className={cn("pointer-events-none absolute start-3 size-4", chosen?.iconClassName ?? "text-g-muted")} />}
        <ComboboxPrimitive.Input
          id={id}
          placeholder={placeholder}
          {...aria}
          className={cn(BOX, size === "sm" ? "h-8" : "", Icon === undefined ? "ps-3" : "ps-9", "pe-9", className)}
        />
        <ComboboxPrimitive.Trigger
          aria-label="Show options"
          className="group/combo focus-knox absolute end-1.5 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink data-disabled:pointer-events-none"
        >
          <ChevronDownIcon aria-hidden className="size-4 transition-[rotate] duration-(--g-dur) ease-g group-data-popup-open/combo:rotate-180" />
        </ComboboxPrimitive.Trigger>
      </span>
      <ComboboxPrimitive.Portal>
        <ComboboxPrimitive.Positioner sideOffset={4} className="z-50 outline-hidden">
          <ComboboxPrimitive.Popup data-slot="combobox-popup" className={POPUP}>
            <ComboboxPrimitive.Empty className="px-2 py-1.5 text-14 text-g-muted empty:hidden">{emptyText}</ComboboxPrimitive.Empty>
            <ComboboxPrimitive.List>
              {(option: SelectOption<V>) => (
                <ComboboxPrimitive.Item key={option.value} value={option} disabled={option.disabled} data-slot="combobox-item" className={ITEM}>
                  <OptionRow
                    option={option}
                    indicator={
                      <ComboboxPrimitive.ItemIndicator className="ms-auto flex shrink-0">
                        <CheckIcon aria-hidden className="size-4" />
                      </ComboboxPrimitive.ItemIndicator>
                    }
                  />
                </ComboboxPrimitive.Item>
              )}
            </ComboboxPrimitive.List>
          </ComboboxPrimitive.Popup>
        </ComboboxPrimitive.Positioner>
      </ComboboxPrimitive.Portal>
    </ComboboxPrimitive.Root>
  );
}

export interface RadioCardOption<V extends string = string> {
  value: V;
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  badge?: React.ReactNode;
  disabled?: boolean;
}

export function RadioCards<V extends string>({
  name,
  value,
  onValueChange,
  options,
  label,
  className,
}: {
  name: string;
  value: V | undefined;
  onValueChange: (value: V) => void;
  options: readonly RadioCardOption<V>[];
  label: string;
  className?: string;
}) {
  const groupId = React.useId();
  return (
    <div role="radiogroup" aria-label={label} data-slot="radio-cards" className={cn("flex flex-col gap-3", className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        const titleId = `${groupId}-${index}-title`;
        const descId = option.description === undefined ? undefined : `${groupId}-${index}-desc`;
        const Icon = option.icon;
        return (
          <label
            key={option.value}
            data-slot="radio-card"
            data-checked={checked ? "" : undefined}
            className={cn(
              "relative flex cursor-pointer items-center gap-4 rounded-g-card border bg-g-surface p-4 transition-[border-color,background-color] duration-(--g-dur) ease-g",
              "has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-g-ink",
              checked ? "border-g-line-strong" : "border-g-line hover:bg-g-hover",
              option.disabled === true && "pointer-events-none opacity-60",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              disabled={option.disabled}
              onChange={() => onValueChange(option.value)}
              aria-labelledby={titleId}
              aria-describedby={descId}
              className="sr-only"
            />
            {Icon === undefined ? null : <Icon aria-hidden className="size-4 shrink-0 text-g-ink" />}
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex flex-wrap items-center gap-2 text-14 font-medium text-g-ink">
                <span id={titleId}>{option.title}</span>
                {option.badge}
              </span>
              {option.description === undefined ? null : (
                <span id={descId} className="text-12 text-g-muted">
                  {option.description}
                </span>
              )}
            </span>
            <span
              aria-hidden
              className={cn(
                "flex size-[18px] shrink-0 items-center justify-center rounded-full border transition-[border-color] duration-(--g-dur) ease-g",
                checked ? "border-g-line-strong" : "border-g-line-control",
              )}
            >
              <span
                data-slot="radio-dot"
                className={cn(
                  "size-2.5 rounded-full bg-g-ink motion-safe:transition-[scale,opacity] motion-safe:duration-(--g-dur) motion-safe:ease-g",
                  checked ? "scale-100 opacity-100" : "scale-0 opacity-0",
                )}
              />
            </span>
          </label>
        );
      })}
    </div>
  );
}

export function Toggle({
  checked,
  onCheckedChange,
  disabled,
  className,
  ...props
}: Omit<React.ComponentProps<"button">, "onChange" | "type" | "role"> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-slot="toggle"
      data-state={checked ? "checked" : "unchecked"}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "focus-knox relative inline-flex h-[18px] w-[30px] shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-[background-color,box-shadow] duration-(--g-dur) ease-g",
        "before:absolute before:inset-x-0 before:-inset-y-[3px] before:content-['']",
        checked ? "bg-g-ink shadow-[inset_0_0_0_1px_transparent]" : "bg-g-switch-off shadow-[inset_0_0_0_1px_var(--g-line-control)]",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn(
          "block size-3.5 rounded-full bg-g-surface shadow-g-nav transition-[translate] duration-(--g-dur) ease-g",
          checked ? "translate-x-3 rtl:-translate-x-3" : "translate-x-0",
        )}
      />
    </button>
  );
}
