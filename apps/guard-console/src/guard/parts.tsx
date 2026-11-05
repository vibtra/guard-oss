import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { GeneratedAvatar } from "@vibtra/ui/react";
import type { GuardEventAction, GuardEventRow } from "@vibtra/guard-contract";
import { cn, IconTile, Pill, type PillTone } from "@/components/kit";
import { AppMark, ServiceMark } from "../brand/BrandMark";
import { DoorSkeleton } from "../shell/DoorState";
import { ACTION_WORD, appWords } from "./words";

const TILE = "rounded-g-control border border-g-line bg-g-surface";

export function ServiceTile({ serviceId, markId, size = "row" }: { serviceId?: string | undefined; markId?: string | undefined; size?: "row" | "header" }) {
  return <ServiceMark serviceId={serviceId} markId={markId} size={size === "header" ? "lg" : "md"} className={TILE} />;
}

export function AppTile({ app, size = "row" }: { app: GuardEventRow["app"]; size?: "row" | "header" }) {
  return <AppMark app={app} size={size === "header" ? "lg" : "md"} className={TILE} />;
}

export function PersonLine({ email, name, image, sub }: { email: string; name?: string | undefined; image?: string | undefined; sub?: React.ReactNode }) {
  const first = name ?? email;
  const second = sub ?? (name === undefined ? undefined : email);
  return (
    <span data-slot="person-line" className="flex min-w-0 items-center gap-3">
      <GeneratedAvatar seed={email} name={first} kind="person" photoUrl={image} showTitle={false} className="size-8 shrink-0" />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-14 font-medium text-g-ink">{first}</span>
        {second === undefined ? null : <span className="truncate text-13 text-g-muted">{second}</span>}
      </span>
    </span>
  );
}

export const ACTION_TONE: Readonly<Record<GuardEventAction, PillTone>> = {
  blocked: "bad",
  allowed: "ok",
  asked: "warn",
  observed: "neutral",
  redirected: "neutral",
  requested: "neutral",
};

export function DecisionPill({ action, size = "table" }: { action: GuardEventAction; size?: "table" | "header" }) {
  return (
    <Pill tone={ACTION_TONE[action]} size={size} data-testid="action-pill" data-action={action}>
      {ACTION_WORD[action].label}
    </Pill>
  );
}

export function AppCell({ app }: { app: GuardEventRow["app"] }) {
  const sub = app?.bundleId ?? (app?.cli === undefined ? undefined : `$ ${app.cli}`);
  return (
    <span className="flex min-w-0 items-center gap-3">
      <AppTile app={app} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-14 font-medium text-g-ink">{appWords(app)}</span>
        {sub === undefined ? null : <span className="truncate font-mono text-12 text-g-muted">{sub}</span>}
      </span>
    </span>
  );
}

export function BannerCard({
  icon,
  title,
  description,
  action,
  className,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & { icon: LucideIcon; title: React.ReactNode; description?: React.ReactNode; action?: React.ReactNode }) {
  return (
    <section
      data-slot="banner-card"
      className={cn("mb-6 flex items-center gap-4 rounded-g-card border border-g-line bg-g-surface px-6 py-5 max-md:flex-col max-md:items-start max-md:px-4 max-md:py-4", className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-center gap-4">
        <IconTile icon={icon} size={40} />
        <div className="flex min-w-0 flex-col">
          <h2 className="text-14 font-medium text-g-ink-strong">{title}</h2>
          {description === undefined ? null : <p className="max-w-[72ch] text-14 text-pretty text-g-muted">{description}</p>}
        </div>
      </div>
      {action === undefined ? null : <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </section>
  );
}

export function PageLoading({ rows = 5 }: { rows?: number }) {
  return (
    <div data-slot="page-skeleton" className="flex flex-col gap-6">
      <DoorSkeleton rows={rows} />
    </div>
  );
}

export function TableFoot({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mt-3 text-12 tabular-nums text-g-muted", className)}>{children}</p>;
}
