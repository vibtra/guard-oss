import * as React from "react";
import { Link, useHref, useLocation, useNavigate } from "react-router";
import { ChevronRightIcon, InboxIcon, SettingsIcon } from "lucide-react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@/components/kit/cn";
import { useSidebar } from "@/components/ui/sidebar";
import { ICON_BUTTON, SidebarToggle } from "@/components/sidebar-05/app-sidebar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { GUARD_DOCS_URL, destinationFor } from "../nav";
import { relativeTo } from "../govern/format";
import { useRole } from "../auth/roles";
import { AccountMenu } from "./AccountMenu";
import { useShellCounts } from "./counts";
import { useCurrentCrumbs } from "./page-primary";

export function useTopBarTitle(): { title: string; parent?: { label: string; to: string } } {
  const { pathname } = useLocation();
  const crumbs = useCurrentCrumbs();
  if (crumbs !== undefined) return { title: crumbs.leaf === "" ? crumbs.rootLabel : crumbs.leaf, ...(crumbs.leaf === "" ? {} : { parent: { label: crumbs.rootLabel, to: crumbs.rootTo } }) };
  return { title: destinationFor(pathname)?.label ?? "Not found" };
}

function TopBarTitle() {
  const { title, parent } = useTopBarTitle();
  React.useEffect(() => {
    document.title = `${title} · Vibtra Guard`;
  }, [title]);
  return (
    <div data-slot="topbar-title" className="flex min-w-0 items-center gap-1.5 text-14 font-medium">
      {parent === undefined ? null : (
        <>
          <Link to={parent.to} className="focus-knox shrink-0 truncate rounded-sm text-g-muted outline-hidden transition-[color] duration-(--g-dur) ease-g hover:text-g-ink">
            {parent.label}
          </Link>
          <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-g-subtle rtl:-scale-x-100" />
        </>
      )}
      <h1 tabIndex={-1} className="min-w-0 truncate rounded-sm text-g-ink-strong outline-hidden focus-visible:focus-knox">
        {title}
      </h1>
    </div>
  );
}

function InboxButton() {
  const { openRequests } = useShellCounts();
  const navigate = useNavigate();
  const requestsHref = useHref("/requests");
  const [open, setOpen] = React.useState(false);
  const count = openRequests?.length ?? 0;
  const shown = (openRequests ?? []).slice(0, 5);
  const go = (event: React.MouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    setOpen(false);
    navigate("/requests");
  };
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        data-slot="inbox-trigger"
        aria-label={count > 0 ? `Inbox, ${count} open ${count === 1 ? "request" : "requests"}` : "Inbox"}
        className={cn(ICON_BUTTON, "relative data-popup-open:bg-g-tint")}
      >
        <InboxIcon aria-hidden />
        {count > 0 ? <span aria-hidden data-slot="inbox-dot" className="absolute top-1.5 end-1.5 size-1.5 rounded-full bg-g-ink ring-2 ring-g-page" /> : null}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={4} className="z-50">
          <Popover.Popup
            data-slot="inbox-popover"
            className="v-popup-motion w-[360px] max-w-[calc(100vw-16px)] origin-(--transform-origin) overscroll-contain rounded-g-card border border-g-line bg-g-surface text-g-ink shadow-g-pop outline-hidden data-ending-style:duration-(--g-dur-fast)"
          >
            <Popover.Title className="px-4 pt-3 pb-1 text-13 font-medium text-g-muted">Inbox</Popover.Title>
            {shown.length === 0 ? (
              <p className="px-4 py-4 text-center text-13 text-g-muted">{openRequests === undefined ? "Requests could not be read." : "No requests are waiting."}</p>
            ) : (
              <ul className="flex flex-col px-1.5 pb-1.5">
                {shown.map((row) => (
                  <li key={row.id}>
                    <a
                      href={requestsHref}
                      onClick={go}
                      className="focus-knox flex flex-col gap-0.5 rounded-g-control px-2.5 py-2 outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-tint"
                    >
                      <span className="line-clamp-2 text-14 font-medium text-g-ink">{row.words}</span>
                      <span className="text-12 text-g-muted">Asked {relativeTo(row.createdAt)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-g-divider p-3">
              <a
                href={requestsHref}
                onClick={go}
                className="focus-knox flex h-8 w-full items-center justify-center rounded-g-control border border-g-line bg-g-surface text-14 font-medium text-g-ink outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-hover"
              >
                View requests
              </a>
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function SettingsButton() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const href = useHref("/settings");
  const here = destinationFor(pathname)?.id === "settings";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            data-slot="settings-gear"
            aria-label="Settings"
            aria-current={here ? "page" : undefined}
            onClick={(event) => {
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
              event.preventDefault();
              navigate("/settings");
            }}
            className={cn(ICON_BUTTON, here && "bg-g-tint text-g-ink")}
          />
        }
      >
        <SettingsIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom">Settings</TooltipContent>
    </Tooltip>
  );
}

export function TopBar() {
  const { isMobile } = useSidebar();
  const admin = useRole() === "admin";
  return (
    <TooltipProvider delay={500}>
      <header data-slot="topbar" className={cn("flex h-(--g-topbar-h) shrink-0 items-center gap-2 bg-g-page pe-3", isMobile ? "ps-3" : "ps-1")}>
        {isMobile ? <SidebarToggle className="me-1" /> : null}
        <TopBarTitle />
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <a
            href={GUARD_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            data-slot="topbar-docs"
            className="focus-knox inline-flex h-8 items-center rounded-g-control px-2.5 text-12 font-medium text-g-ink outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-tint"
          >
            Docs
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
          {admin ? <InboxButton /> : null}
          {admin ? <SettingsButton /> : null}
          <AccountMenu />
        </div>
      </header>
    </TooltipProvider>
  );
}
