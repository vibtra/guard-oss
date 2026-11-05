import * as React from "react";
import { Badge, type BadgeTone } from "@vibtra/ui/react";
import type {
  GuardAudience,
  GuardDetector,
  GuardDetectorKind,
  GuardEventAction,
  GuardEventRow,
  GuardFlowAction,
  GuardServiceCategory,
} from "@vibtra/guard-contract";
import { relativeTo } from "../govern/format";
import { cn } from "@/lib/utils";
import { AppMark, ServiceMark } from "../brand/BrandMark";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export const ACTION_WORD: Record<GuardEventAction, { label: string; tone: BadgeTone }> = {
  observed: { label: "Observed", tone: "neutral" },
  allowed: { label: "Allowed", tone: "ok" },
  blocked: { label: "Blocked", tone: "danger" },
  asked: { label: "Asked", tone: "warn" },
  redirected: { label: "Redirected", tone: "info" },
  requested: { label: "Requested", tone: "info" },
};

export function ActionPill({ action, className }: { action: GuardEventAction; className?: string }) {
  const word = ACTION_WORD[action];
  return (
    <Badge tone={word.tone} data-testid="action-pill" data-action={action} className={className}>
      {word.label}
    </Badge>
  );
}

export const FLOW_WORD: Record<GuardFlowAction, { label: string; tone: BadgeTone }> = {
  allow: { label: "Allow", tone: "ok" },
  block: { label: "Block", tone: "danger" },
  ask: { label: "Ask IT", tone: "warn" },
};

export function RuleActionPill({ action }: { action: GuardFlowAction }) {
  const word = FLOW_WORD[action];
  return (
    <Badge tone={word.tone} data-testid="rule-action" data-action={action}>
      {word.label}
    </Badge>
  );
}

export const CATEGORY_WORD: Record<GuardServiceCategory, string> = {
  chat: "Chat",
  api: "API",
  coding: "Coding",
  search: "Search",
  writing: "Writing",
  image: "Image",
  audio: "Audio",
  meeting: "Meetings",
  agent: "Agents",
  cloud: "Cloud",
  notebook: "Notebooks",
};

export const categoryWord = (category: string): string => CATEGORY_WORD[category as GuardServiceCategory] ?? category;

export function CategoryChip({ category }: { category: string }) {
  return (
    <Badge size="md" data-testid="category-chip">
      {categoryWord(category)}
    </Badge>
  );
}

export function ServiceTile({ serviceId, markId, size = "sm" }: { serviceId: string; markId?: string | undefined; name?: string; size?: "xs" | "sm" | "md" }) {
  return <ServiceMark serviceId={serviceId} markId={markId} size={size} />;
}

export type NameFit = "truncate" | "wrap";
const NAME_FIT: Record<NameFit, { name: string; code: string }> = {
  truncate: { name: "truncate", code: "truncate" },
  wrap: { name: "min-w-0 [overflow-wrap:break-word]", code: "min-w-0 [overflow-wrap:anywhere]" },
};

export function ServiceName({
  serviceId,
  markId,
  name,
  sub,
  className,
  fit = "truncate",
}: {
  serviceId: string;
  markId?: string | undefined;
  name: string;
  sub?: React.ReactNode;
  className?: string;
  fit?: NameFit;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <ServiceTile serviceId={serviceId} markId={markId} />
      <span className="flex min-w-0 flex-col">
        <span className={cn(NAME_FIT[fit].name, "font-medium text-foreground")}>{name}</span>
        {sub === undefined ? null : <span className={cn(NAME_FIT[fit].name, "text-xs text-muted-foreground")}>{sub}</span>}
      </span>
    </span>
  );
}

export const DETECTOR_WORD: Record<GuardDetectorKind, string> = {
  "au-tfn": "Tax file number",
  "au-abn": "ABN",
  "au-acn": "ACN",
  "au-medicare": "Medicare number",
  "card-number": "Payment card number",
  identifiers: "Personal identifiers",
  secret: "API key or secret",
  "email-bulk": "Bulk email addresses",
  "phone-bulk": "Bulk phone numbers",
  keyword: "Keywords",
  "file-type": "File types",
};

export const detectorWords = (detector: GuardDetector): string => {
  switch (detector.kind) {
    case "secret":
      return detector.rules === undefined || detector.rules.length === 0 ? "API keys and secrets (all patterns)" : `Secrets: ${detector.rules.join(", ")}`;
    case "email-bulk":
      return `${detector.threshold}+ email addresses`;
    case "phone-bulk":
      return `${detector.threshold}+ phone numbers`;
    case "keyword":
      return `Keywords: ${detector.keywords.join(", ")}${detector.wholeWord ? " (whole words)" : ""}`;
    case "file-type":
      return `Files: ${detector.extensions.map((e) => `.${e}`).join(" ")}`;
    default:
      return DETECTOR_WORD[detector.kind];
  }
};

export const audienceWords = (audience: GuardAudience, groups: ReadonlyMap<string, string>): string => {
  if (audience.kind === "org") return "Everyone";
  if (audience.kind === "groups") return audience.groupIds.map((id) => groups.get(id) ?? id).join(", ");
  return audience.emails.join(", ");
};

export const bytesWords = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`;
};

export function When({ iso, now, className, prefix }: { iso: string | undefined; now?: number; className?: string; prefix?: string }) {
  if (iso === undefined) return <span className={cn("text-g-muted", className)}>Never</span>;
  const absolute = absoluteWords(iso);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<time dateTime={iso} tabIndex={0} />}
        className={cn("rounded-sm whitespace-nowrap outline-hidden focus-visible:focus-knox", className)}
      >
        {prefix === undefined ? null : `${prefix} `}
        {relativeTo(iso, now)}
        <span className="sr-only">, {absolute}</span>
      </TooltipTrigger>
      <TooltipContent>{absolute}</TooltipContent>
    </Tooltip>
  );
}

export const absoluteWords = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(date);
};

export const dayTimeWords = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
};

export const plural = (count: number, one: string, other: string): string =>
  `${count.toLocaleString()} ${new Intl.PluralRules(undefined).select(count) === "one" ? one : other}`;

export const appWords = (app: GuardEventRow["app"]): string => app?.name ?? (app?.cli === undefined ? undefined : `${app.cli} (CLI)`) ?? app?.bundleId ?? "An unknown app";

export function AppName({ app, sub, className, fit = "truncate" }: { app: GuardEventRow["app"]; sub?: React.ReactNode; className?: string; fit?: NameFit }) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", className)}>
      <AppMark app={app} />
      <span className="flex min-w-0 flex-col">
        <span className={cn(NAME_FIT[fit].name, "text-foreground")}>{appWords(app)}</span>
        {sub === undefined || sub === null ? null : <span className={cn(NAME_FIT[fit].code, "font-mono text-xs text-muted-foreground")}>{sub}</span>}
      </span>
    </span>
  );
}

export function EventServiceName({
  serviceId,
  name,
  className,
  fit = "truncate",
  size = "sm",
}: {
  serviceId?: string | undefined;
  name?: string | undefined;
  className?: string;
  fit?: NameFit;
  size?: "xs" | "sm";
}) {
  if (serviceId === undefined && name === undefined) return <span className="text-muted-foreground">None</span>;
  return (
    <span className={cn("flex min-w-0 items-center", size === "xs" ? "gap-1.5" : "gap-2", className)}>
      <ServiceMark serviceId={serviceId} size={size} />
      <span className={NAME_FIT[fit].name} data-testid="event-service-name">
        {name ?? serviceId}
      </span>
    </span>
  );
}

export const matchWords = (row: Pick<GuardEventRow, "matchType" | "matchCount">): string | undefined =>
  row.matchType === undefined ? undefined : `${DETECTOR_WORD[row.matchType]}${row.matchCount === undefined ? "" : ` × ${row.matchCount}`}`;

export const minutesWords = (minutes: number): string =>
  minutes < 90 ? `${minutes} min` : minutes < 48 * 60 ? `${Math.round(minutes / 60)} h` : `${Math.round(minutes / (60 * 24))} days`;
