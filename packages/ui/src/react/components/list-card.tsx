import * as React from "react";
import { CornerDownRightIcon, PlusIcon } from "lucide-react";
import { cn } from "../lib/cn";

export function ListCard({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="list-card"
      className={cn(
        "flex flex-col overflow-hidden rounded-xl border border-border bg-card",
        "[&>li+li]:border-t [&>li+li]:border-border",
        className,
      )}
      {...props}
    />
  );
}

export interface ListRowProps extends Omit<React.ComponentProps<"li">, "title"> {
  icon?: React.ReactNode;
  tile?: "square" | "round";
  title: React.ReactNode;
  tags?: React.ReactNode;
  description?: React.ReactNode;
  end?: React.ReactNode;
  link?: React.ReactElement<{ className?: string; children?: React.ReactNode }>;
}

export function ListRow({ icon, tile = "square", title, tags, description, end, link, className, ...props }: ListRowProps) {
  const body = (
    <>
      {icon === undefined ? null : (
        <span
          aria-hidden
          data-slot="list-row-icon"
          data-tile={tile}
          className={cn(
            "inline-flex shrink-0 items-center justify-center overflow-hidden [&_svg]:size-5",
            tile === "round" ? "size-9 rounded-full bg-muted [&_img]:size-5" : "size-8 rounded-lg [&_img]:size-8",
          )}
        >
          {icon}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span data-slot="list-row-title" className="truncate text-sm leading-pair font-medium text-foreground">
            {title}
          </span>
          {tags}
        </span>
        {description === undefined ? null : (
          <span
            data-slot="list-row-description"
            className="max-w-[500px] text-sm leading-pair text-secondary-foreground"
          >
            {description}
          </span>
        )}
      </span>
    </>
  );
  const rowClass = "flex min-h-[72px] min-w-0 items-center gap-2 p-4";
  return (
    <li
      data-slot="list-row"
      className={cn("group/list-row relative transition-colors duration-(--v-dur-1) hover:bg-accent", className)}
      {...props}
    >
      {link === undefined ? (
        <div className={rowClass}>
          {body}
          {end === undefined ? null : <span className="ml-auto flex shrink-0 items-center gap-2">{end}</span>}
        </div>
      ) : (
        <div className={rowClass}>
          {React.cloneElement(link, {
            className: cn(
              "focus-knox flex min-w-0 flex-1 items-center gap-2 outline-hidden after:absolute after:inset-0",
              link.props.className,
            ),
            children: body,
          })}
          {end === undefined ? null : (
            <span className="relative z-1 ml-auto flex shrink-0 items-center gap-2">{end}</span>
          )}
        </div>
      )}
    </li>
  );
}

export function ListAddRow({
  className,
  children,
  icon,
  ...props
}: React.ComponentProps<"button"> & { icon?: React.ReactNode }) {
  return (
    <li data-slot="list-add-row" className="flex items-center gap-2 p-4">
      <CornerDownRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className={cn(
          "focus-knox inline-flex h-(--v-control-h-sm) items-center gap-2 rounded-lg bg-secondary px-3 text-sm text-muted-foreground outline-hidden",
          "transition-colors duration-(--v-dur-2) hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
          "[&_svg]:size-4 [&_svg]:shrink-0",
          className,
        )}
        {...props}
      >
        {icon ?? <PlusIcon aria-hidden />}
        {children}
      </button>
    </li>
  );
}
