import * as React from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";

export interface ListSearch {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}

export function SearchInput({ search, className }: { search: ListSearch; className?: string }) {
  const placeholder = search.placeholder ?? "Search…";
  return (
    <label
      data-slot="list-search"
      className={cn(
        "relative flex h-8 w-60 min-w-0 items-center rounded-g-control border border-g-line-control bg-g-surface transition-[border-color,box-shadow] duration-(--g-dur) ease-g focus-within:border-(--v-line-active) focus-within:shadow-[0_0_0_4px_var(--v-input-focus-ring)]",
        className,
      )}
    >
      <SearchIcon aria-hidden className="pointer-events-none absolute start-2.5 size-4 text-g-muted" />
      <input
        type="text"
        role="searchbox"
        autoComplete="off"
        value={search.value}
        aria-label={search.label ?? placeholder}
        placeholder={placeholder}
        onChange={(event) => search.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape" || search.value === "") return;
          event.preventDefault();
          search.onChange("");
        }}
        className="h-full w-full min-w-0 bg-transparent ps-8 pe-2.5 text-12 text-g-ink outline-hidden placeholder:text-g-muted max-md:text-16"
      />
    </label>
  );
}

export function ListToolbar({
  views,
  search,
  filter,
  action,
  className,
}: {
  views?: React.ReactNode;
  search?: ListSearch;
  filter?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div data-slot="list-toolbar" className={cn("mb-4 flex flex-wrap items-center gap-2", className)}>
      {views === undefined ? null : <div className="flex min-w-0 max-md:basis-full">{views}</div>}
      {search === undefined ? null : <SearchInput search={search} className="max-md:flex-1" />}
      {filter}
      {action === undefined ? null : <div className="ms-auto flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}
