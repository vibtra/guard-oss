import {
  ActivityIcon,
  InboxIcon,
  LaptopIcon,
  LayoutDashboardIcon,
  type LucideIcon,
  SettingsIcon,
  ShieldCheckIcon,
  SparklesIcon,
  UsersIcon,
} from "lucide-react";
import type { ConsoleRole } from "./auth/roles";

export type NavGroupId = "protect" | "fleet" | "catalogue";

export interface NavGroup {
  id: NavGroupId;
  label: string;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: "protect", label: "Protect" },
  { id: "fleet", label: "Fleet" },
  { id: "catalogue", label: "Catalogue" },
];

export type NavItem = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  href: string;
  roles: readonly ConsoleRole[];
  group?: NavGroupId;
  count?: "openRequests" | "devices";
};

const ADMIN: readonly ConsoleRole[] = ["admin"];

export const GUARD_DOCS_URL = "https://github.com/vibtra/guard-oss#readme";

export const NAV_ITEMS: readonly NavItem[] = [
  { id: "overview", label: "Overview", description: "Which AI services people use, from which apps, and what was blocked.", icon: LayoutDashboardIcon, href: "/", roles: ADMIN, group: "protect" },
  { id: "activity", label: "Activity", description: "Every decision the laptops made: who, which app, which service, which rule.", icon: ActivityIcon, href: "/activity", roles: ADMIN, group: "protect" },
  { id: "rules", label: "Rules", description: "Which AI services each team may use, and what may not be sent to them.", icon: ShieldCheckIcon, href: "/rules", roles: ADMIN, group: "protect" },
  { id: "requests", label: "Requests", description: "People asking for access from the block page, and the grants in force.", icon: InboxIcon, href: "/requests", roles: ADMIN, group: "protect", count: "openRequests" },
  { id: "devices", label: "Devices", description: "Enrolled laptops, when each last checked in, and enrol links.", icon: LaptopIcon, href: "/devices", roles: ADMIN, group: "fleet", count: "devices" },
  { id: "people", label: "People", description: "Everyone in the organisation, their groups and their laptops.", icon: UsersIcon, href: "/people", roles: ADMIN, group: "fleet" },
  { id: "services", label: "AI services", description: "The catalogue of AI services the agent recognises: domains, apps and CLIs.", icon: SparklesIcon, href: "/services", roles: ADMIN, group: "catalogue" },
  { id: "settings", label: "Settings", description: "Monitor or enforce, quiet devices, requests, the workspace redirect, the staff notice.", icon: SettingsIcon, href: "/settings", roles: ADMIN },
];

const withoutTrailingSlash = (pathname: string): string => (pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname);

export function destinationFor(pathname: string): NavItem | undefined {
  const address = withoutTrailingSlash(pathname);
  let best: NavItem | undefined;
  for (const item of NAV_ITEMS) {
    const hit = item.href === address || (item.href !== "/" && address.startsWith(`${item.href}/`));
    if (hit && (best === undefined || best.href.length < item.href.length)) best = item;
  }
  return best;
}

export function currentNavId(pathname: string): string | null {
  return destinationFor(pathname)?.id ?? null;
}

export function rowsFor(role: ConsoleRole): NavItem[] {
  return NAV_ITEMS.filter((item) => item.roles.includes(role));
}

export function navGroupsFor(role: ConsoleRole): { group: NavGroup; items: NavItem[] }[] {
  const rows = rowsFor(role);
  return NAV_GROUPS.map((group) => ({ group, items: rows.filter((item) => item.group === group.id) })).filter((entry) => entry.items.length > 0);
}

export function canVisit(role: ConsoleRole, pathname: string): boolean {
  const best = destinationFor(pathname);
  return best === undefined || best.roles.includes(role);
}
