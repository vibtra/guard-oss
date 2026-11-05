import * as React from "react";
import { Link, useLocation } from "react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export interface PageBandContent {
  title: string;
  subtitle?: string;
  badge?: string;
}

export interface PageCrumbs {
  rootLabel: string;
  rootTo: string;
  leaf: string;
}

type Stamped<T> = T & { path: string };
type Register<T> = React.Dispatch<React.SetStateAction<Stamped<T> | undefined>>;
type Slot<T> = { register: Register<T>; path: string };

export interface ProjectSlotTargets {
  left: HTMLElement | null;
  right: HTMLElement | null;
  setLeft: (node: HTMLElement | null) => void;
  setRight: (node: HTMLElement | null) => void;
}

const ProjectTargets = React.createContext<ProjectSlotTargets | undefined>(undefined);

export function useProjectSlotTargets(): ProjectSlotTargets | undefined {
  return React.useContext(ProjectTargets);
}

export function ProjectSlotTarget({ side, className }: { side: "left" | "right"; className?: string }) {
  const targets = React.useContext(ProjectTargets);
  const set = side === "left" ? targets?.setLeft : targets?.setRight;
  return <div data-slot={`project-slot-${side}`} ref={set} className={className} />;
}

const BandSlot = React.createContext<Slot<PageBandContent> | undefined>(undefined);
const BandValue = React.createContext<PageBandContent | undefined>(undefined);
const CrumbSlot = React.createContext<Slot<PageCrumbs> | undefined>(undefined);
const CrumbValue = React.createContext<PageCrumbs | undefined>(undefined);

export function PagePrimaryProvider({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  const [band, setBand] = React.useState<Stamped<PageBandContent> | undefined>();
  const [crumbs, setCrumbs] = React.useState<Stamped<PageCrumbs> | undefined>();
  const [left, setLeft] = React.useState<HTMLElement | null>(null);
  const [right, setRight] = React.useState<HTMLElement | null>(null);
  const targets = React.useMemo<ProjectSlotTargets>(() => ({ left, right, setLeft, setRight }), [left, right]);

  const bandSlot = React.useMemo<Slot<PageBandContent>>(
    () => ({ register: setBand, path: pathname }),
    [pathname],
  );
  const crumbSlot = React.useMemo<Slot<PageCrumbs>>(
    () => ({ register: setCrumbs, path: pathname }),
    [pathname],
  );

  const onScreen = <T,>(held: Stamped<T> | undefined): T | undefined =>
    held !== undefined && held.path === pathname ? held : undefined;

  return (
    <BandSlot.Provider value={bandSlot}>
      <CrumbSlot.Provider value={crumbSlot}>
        <BandValue.Provider value={onScreen(band)}>
          <CrumbValue.Provider value={onScreen(crumbs)}>
            <ProjectTargets.Provider value={targets}>{children}</ProjectTargets.Provider>
          </CrumbValue.Provider>
        </BandValue.Provider>
      </CrumbSlot.Provider>
    </BandSlot.Provider>
  );
}

export function useCurrentCrumbs(): PageCrumbs | undefined {
  return React.useContext(CrumbValue);
}

export function usePageBand(band: PageBandContent | undefined): void {
  const slot = React.useContext(BandSlot);
  const register = slot?.register;
  const [home] = React.useState(slot?.path ?? "");

  const title = band?.title;
  const badge = band?.badge;
  const subtitle = band?.subtitle;

  React.useEffect(() => {
    if (register === undefined || title === undefined) return;
    register({ path: home, title, badge, ...(subtitle === undefined ? {} : { subtitle }) });
    return () => {
      register((current) => (current?.path === home ? undefined : current));
    };
  }, [register, home, title, badge, subtitle]);
}

export function usePageBreadcrumb(crumbs: PageCrumbs | undefined): void {
  const slot = React.useContext(CrumbSlot);
  const register = slot?.register;
  const [home] = React.useState(slot?.path ?? "");

  const rootLabel = crumbs?.rootLabel;
  const rootTo = crumbs?.rootTo;
  const leaf = crumbs?.leaf;

  React.useEffect(() => {
    if (register === undefined || rootLabel === undefined || rootTo === undefined) return;
    register({ path: home, rootLabel, rootTo, leaf: leaf ?? "" });
    return () => {
      register((current) => (current?.path === home ? undefined : current));
    };
  }, [register, home, rootLabel, rootTo, leaf]);
}

const BADGE =
  "inline-flex h-6 shrink-0 items-center rounded-full bg-muted px-2 font-mono text-xs font-medium text-secondary-foreground";

export function PageBand({ frame = "app" }: { frame?: "app" | "settings" }) {
  const band = React.useContext(BandValue);

  if (band === undefined) return null;

  return (
    <div data-slot="page-band" data-frame={frame} className="mb-6 flex shrink-0 flex-col gap-2">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="min-w-0 truncate text-title font-semibold tracking-h-sm text-foreground">{band.title}</h1>
        {band.badge === undefined ? null : <span className={BADGE}>{band.badge}</span>}
      </div>
      {band.subtitle === undefined ? null : (
        <p data-slot="page-subtitle" className="text-md text-foreground">
          {band.subtitle}
        </p>
      )}
    </div>
  );
}

export function PageHead({ frame = "app" }: { frame?: "app" | "settings" }) {
  const crumbs = React.useContext(CrumbValue);
  return (
    <>
      {crumbs === undefined ? null : (
        <div data-slot="page-crumbs" data-frame={frame} className="mb-4 flex min-h-8 items-center">
          <PageBreadcrumb />
        </div>
      )}
      <PageBand frame={frame} />
    </>
  );
}

export function PageBreadcrumb() {
  const crumbs = React.useContext(CrumbValue);
  if (crumbs === undefined) return null;
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink render={Link} to={crumbs.rootTo}>
            {crumbs.rootLabel}
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>{crumbs.leaf}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );
}

