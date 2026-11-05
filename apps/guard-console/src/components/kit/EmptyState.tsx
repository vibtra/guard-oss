import * as React from "react";
import { SearchIcon, type LucideIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import { IconTile } from "./Pill";

export function EmptyState({
  icon = SearchIcon,
  title,
  description,
  action,
  detail,
  className,
  ...props
}: Omit<React.ComponentProps<"div">, "title" | "children"> & {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <div data-slot="empty-state" className={cn("g-enter flex flex-col items-center px-6 py-12 text-center", className)} {...props}>
      <IconTile icon={icon} />
      <p className="mt-3.5 text-14 font-medium text-g-ink">{title}</p>
      {description === undefined ? null : <p className="mt-1.5 max-w-[420px] text-12 text-pretty text-g-muted">{description}</p>}
      {detail === undefined ? null : <div className="mt-2 max-w-[420px] text-start">{detail}</div>}
      {action === undefined ? null : <div className="mt-4">{action}</div>}
    </div>
  );
}
