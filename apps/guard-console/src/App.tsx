import * as React from "react";
import { Route, Routes, useLocation } from "react-router";
import { SearchXIcon } from "lucide-react";
import { Toaster } from "@vibtra/ui/react";
import { SessionProvider } from "./api/session";
import { RequireAuth, RequireRole } from "./auth/AuthGate";
import { SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/sidebar-05/app-sidebar";
import { EmptyState } from "@/components/kit/EmptyState";
import { PagePrimaryProvider } from "./shell/page-primary";
import { ShellCountsProvider } from "./shell/counts";
import { TopBar } from "./shell/TopBar";
import { motionMs } from "./shell/useClosingState";
import { cn } from "@/components/kit/cn";
import { Overview } from "./pages/Overview";
import { Activity } from "./pages/Activity";
import { Rules } from "./pages/Rules";
import { Requests } from "./pages/Requests";
import { Devices } from "./pages/Devices";
import { People } from "./pages/People";
import { Services } from "./pages/Services";
import { Settings } from "./pages/Settings";

export function App() {
  return (
    <RequireAuth>
      <SessionProvider>
        <Shell />
      </SessionProvider>
    </RequireAuth>
  );
}

export function Shell() {
  return (
    <SidebarProvider className="h-dvh overflow-hidden bg-g-page">
      <PagePrimaryProvider>
        <ShellCountsProvider>
          <a
            href="#main"
            className="sr-only z-50 rounded-lg border border-g-line bg-g-surface px-3 py-2 text-14 text-g-ink focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus-visible:focus-knox"
          >
            Skip to content
          </a>
          <AppSidebar />
          <div data-slot="main-column" className="flex min-h-0 min-w-0 flex-1 flex-col">
            <TopBar />
            <MainFrame>
              <RequireRole>
                <GuardRoutes />
              </RequireRole>
            </MainFrame>
          </div>
        </ShellCountsProvider>
      </PagePrimaryProvider>
      <Toaster closeButton />
    </SidebarProvider>
  );
}

function MainFrame({ children }: { children: React.ReactNode }) {
  const { isMobile } = useSidebar();
  useRouteFade();
  return (
    <main
      id="main"
      tabIndex={-1}
      data-slot="content-card"
      className={cn(
        "scrollbar-knox relative mb-(--g-gutter) me-(--g-gutter) flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable] rounded-g-shell border border-g-line bg-g-surface outline-hidden",
        isMobile && "ms-(--g-gutter)",
      )}
    >
      <div data-slot="content-column" className={cn("flex w-full min-w-0 flex-1 flex-col pt-6 pb-6", isMobile ? "px-4" : "px-6")}>
        {children}
      </div>
    </main>
  );
}

function useRouteFade() {
  const { pathname } = useLocation();
  const first = React.useRef(true);
  React.useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const main = document.querySelector<HTMLElement>("[data-slot='content-card']");
    if (main !== null && typeof main.scrollTo === "function") main.scrollTo({ top: 0 });
    document.querySelector<HTMLElement>("[data-slot='topbar'] h1")?.focus({ preventScroll: true });
    const column = main?.querySelector<HTMLElement>("[data-slot='content-column']");
    if (column === null || column === undefined || typeof column.animate !== "function") return;
    const ease = getComputedStyle(document.documentElement).getPropertyValue("--g-ease").trim() || "cubic-bezier(.22, 1, .36, 1)";
    column.animate([{ opacity: 0 }, { opacity: 1 }], { duration: motionMs("--g-dur", column), easing: ease });
  }, [pathname]);
}

export function GuardRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Overview />} />
      <Route path="/activity" element={<Activity />} />
      <Route path="/rules" element={<Rules />} />
      <Route path="/requests" element={<Requests />} />
      <Route path="/devices" element={<Devices />} />
      <Route path="/people" element={<People />} />
      <Route path="/services" element={<Services />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

function NotFound() {
  return (
    <div data-testid="not-found" className="rounded-g-card border border-g-line">
      <EmptyState icon={SearchXIcon} title="There is nothing at this address" description="Pick a page from the sidebar." />
    </div>
  );
}
