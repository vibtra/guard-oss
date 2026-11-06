import * as React from "react";
import { ListFilterIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import { CountBadge } from "./Pill";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface FilterFacet<V extends string = string> {
  id: string;
  label: string;
  options: readonly { value: V; label: string; count?: number }[];
  selected: readonly V[];
  onChange: (next: V[]) => void;
}

export function FilterPopover({ facets, label = "Filter", className }: { facets: readonly FilterFacet[]; label?: string; className?: string }) {
  const active = facets.reduce((sum, facet) => sum + facet.selected.length, 0);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="filter-trigger"
        aria-label={active > 0 ? `${label}, ${active} selected` : label}
        className={cn(
          "focus-knox relative inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-g-control border border-g-line bg-g-surface outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-hover data-popup-open:bg-g-hover",
          active > 0 ? "text-g-ink" : "text-g-muted",
          className,
        )}
      >
        <ListFilterIcon aria-hidden className="size-4" />
        {active > 0 ? <span aria-hidden className="absolute -top-0.5 -end-0.5 size-2 rounded-full bg-g-ink ring-2 ring-g-surface" /> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={6} data-slot="filter-menu" className="min-w-[190px]">
        {facets.map((facet) => (
          <DropdownMenuSub key={facet.id}>
            <DropdownMenuSubTrigger>
              <span className="flex-1">{facet.label}</span>
              {facet.selected.length > 0 ? <span className="text-12 tabular-nums text-g-muted">{facet.selected.length}</span> : null}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="min-w-[200px]">
              {facet.options.map((option) => {
                const checked = facet.selected.includes(option.value);
                return (
                  <DropdownMenuCheckboxItem
                    key={option.value}
                    indicator="checkbox"
                    checked={checked}
                    closeOnClick={false}
                    onCheckedChange={(next: boolean) =>
                      facet.onChange(next ? [...facet.selected, option.value] : facet.selected.filter((value) => value !== option.value))
                    }
                  >
                    {option.label}
                    {option.count === undefined || option.count === 0 ? null : <CountBadge count={option.count} className="ms-auto border-g-pill-bad-line bg-g-pill-bad-bg text-g-pill-bad-ink" />}
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        ))}
        {active > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => {
                for (const facet of facets) if (facet.selected.length > 0) facet.onChange([]);
              }}
            >
              Clear filters
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
