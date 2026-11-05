'use client';

import * as React from 'react';
import { useHref, useLocation, useNavigate } from 'react-router';
import { PanelLeftIcon } from 'lucide-react';
import { Kbd } from '@vibtra/ui/react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { currentNavId, navGroupsFor, type NavItem } from '@/nav';
import { useRole } from '@/auth/roles';
import { VibtraMark } from '@/brand/Mark';
import { WorkspaceMenu } from '@/shell/AccountMenu';
import { useShellCounts } from '@/shell/counts';
import { cn } from '@/components/kit/cn';

export { GUARD_DOCS_URL } from '@/nav';

const RAIL_TIP_DELAY = 700;

export function GuardWordmark({ className }: { className?: string }) {
  return (
    <span data-slot="guard-wordmark" className={cn('inline-flex items-center gap-2 text-g-ink-strong', className)}>
      <VibtraMark className="size-[18px] shrink-0" />
      <span className="text-16 font-[600] tracking-[-0.01em]">Guard</span>
      <span className="text-12 font-medium text-g-muted">by Vibtra</span>
    </span>
  );
}

export const ICON_BUTTON =
  'focus-knox inline-flex size-8 shrink-0 items-center justify-center rounded-g-control text-g-nav outline-hidden transition-colors duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink active:bg-g-pressed [&_svg]:size-4';

export function SidebarToggle({ className }: { className?: string }) {
  const { open, isMobile, openMobile, toggleSidebar } = useSidebar();
  const expanded = isMobile ? openMobile : open;
  const label = isMobile ? (openMobile ? 'Close navigation' : 'Open navigation') : open ? 'Collapse sidebar' : 'Expand sidebar';
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-slot="sidebar-toggle"
            aria-label={label}
            aria-expanded={expanded}
            aria-keyshortcuts="Meta+B Control+B"
            onClick={toggleSidebar}
            className={cn(ICON_BUTTON, className)}
          />
        }
      >
        <PanelLeftIcon aria-hidden />
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        <Kbd>⌘B</Kbd>
      </TooltipContent>
    </Tooltip>
  );
}

function CountBadgeInline({ count }: { count: number }) {
  return (
    <span
      data-slot="nav-count"
      className="ms-auto inline-flex h-5 min-w-6 shrink-0 items-center justify-center rounded-full bg-g-tint px-1.5 text-10 font-[600] tabular-nums text-g-ink"
    >
      <span className="sr-only">, </span>
      {count}
    </span>
  );
}

function NavRow({ item, current, count, rail, onNavigate }: { item: NavItem; current: boolean; count?: number; rail: boolean; onNavigate: (event: React.MouseEvent, item: NavItem) => void }) {
  const Icon = item.icon;
  const href = useHref(item.href);
  const counted = count !== undefined && count > 0;
  const row = (
    <SidebarMenuButton
      isActive={current}
      aria-current={current ? 'page' : undefined}
      render={<a href={href} />}
      onClick={(event: React.MouseEvent) => onNavigate(event, item)}
      data-nav-id={item.id}
      data-rail={rail ? '' : undefined}
      className={rail ? 'relative w-8 justify-center gap-0 px-0' : undefined}
    >
      <Icon aria-hidden />
      <span className={rail ? 'sr-only' : undefined}>{item.label}</span>
      {counted && !rail ? <CountBadgeInline count={count} /> : null}
      {counted && rail ? (
        <span data-slot="nav-count-dot" className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-g-nav ring-2 ring-g-page">
          <span className="sr-only">, {count}</span>
        </span>
      ) : null}
    </SidebarMenuButton>
  );
  return (
    <SidebarMenuItem>
      {rail ? (
        <Tooltip>
          <TooltipTrigger render={row} />
          <TooltipContent side="right" sideOffset={12}>
            {counted ? `${item.label} · ${count}` : item.label}
          </TooltipContent>
        </Tooltip>
      ) : (
        row
      )}
    </SidebarMenuItem>
  );
}

function countFor(item: NavItem, counts: ReturnType<typeof useShellCounts>): number | undefined {
  if (item.count === 'openRequests') return counts.openRequests?.length;
  if (item.count === 'devices') return counts.devices;
  return undefined;
}

export function AppSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const role = useRole();
  const counts = useShellCounts();
  const { state, isMobile, setOpenMobile } = useSidebar();
  const rail = !isMobile && state === 'collapsed';
  const selected = currentNavId(location.pathname);
  const home = useHref('/');

  const go = (event: React.MouseEvent, to: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    navigate(to);
    if (isMobile) setOpenMobile(false);
  };

  return (
    <TooltipProvider delay={RAIL_TIP_DELAY}>
      <Sidebar data-frame="app" data-rail={rail ? '' : undefined}>
        <SidebarHeader className="h-(--g-topbar-h) flex-row items-center gap-3 px-3">
          <SidebarToggle />
          {rail ? null : (
            <a href={home} aria-label="Vibtra Guard, overview" onClick={(event) => go(event, '/')} className="focus-knox rounded-sm outline-hidden">
              <GuardWordmark />
            </a>
          )}
        </SidebarHeader>
        <div className={cn('shrink-0 pt-4', rail ? 'px-3' : 'px-2.5')}>{rail ? <WorkspaceMenu variant="rail" /> : <WorkspaceMenu />}</div>
        <SidebarContent className={rail ? 'px-3' : undefined}>
          <nav aria-label="Guard">
            {navGroupsFor(role).map(({ group, items }) => (
              <SidebarGroup key={group.id} aria-label={group.label} className="pt-3">
                <SidebarGroupLabel aria-hidden={rail ? true : undefined} className={rail ? 'invisible' : undefined}>
                  {group.label}
                </SidebarGroupLabel>
                <SidebarMenu>
                  {items.map((item) => {
                    const count = countFor(item, counts);
                    return (
                      <NavRow
                        key={item.id}
                        item={item}
                        current={selected === item.id}
                        {...(count === undefined ? {} : { count })}
                        rail={rail}
                        onNavigate={(event) => go(event, item.href)}
                      />
                    );
                  })}
                </SidebarMenu>
              </SidebarGroup>
            ))}
          </nav>
        </SidebarContent>
      </Sidebar>
    </TooltipProvider>
  );
}
