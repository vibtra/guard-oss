import * as React from "react";
import { cn } from "@vibtra/ui/react";
import { VibtraMark, VibtraMarkOutline } from "../brand/Mark";
import "./auth-frame.css";

export const AUTH_STATES = [
  "signin",
  "signin-busy",
  "signup",
  "sso",
  "refused",
  "not-allowed",
  "signed-out",
  "checking",
  "invitation-open",
  "invitation-wrong-account",
  "invitation-closed",
  "invitation-accepted",
  "invitation-error",
  "phone",
] as const;

export type AuthState = (typeof AUTH_STATES)[number];

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

export function usePrefersReducedMotion(): boolean {
  const read = () =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION).matches
      : false;
  const [reduced, setReduced] = React.useState(read);
  React.useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(REDUCED_MOTION);
    const onChange = () => setReduced(query.matches);
    query.addEventListener?.("change", onChange);
    return () => query.removeEventListener?.("change", onChange);
  }, []);
  return reduced;
}

export type AuthFrameProps = {
  state: AuthState;
  layout?: "column" | "split";
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  mark?: "solid" | "outline" | "none";
  nav?: React.ReactNode;
  aside?: React.ReactNode;
  prompt?: React.ReactNode;
  postscript?: React.ReactNode;
  footer?: React.ReactNode;
  detail?: string;
  children?: React.ReactNode;
};

export function AuthFrame({
  state,
  layout = "column",
  title,
  subtitle,
  mark = "solid",
  nav,
  aside,
  prompt,
  postscript,
  footer,
  detail,
  children,
}: AuthFrameProps) {
  const reduced = usePrefersReducedMotion();

  return (
    <div
      data-slot="auth-frame"
      data-auth-state={state}
      data-auth-layout={layout}
      data-motion={reduced ? "reduce" : "full"}
      {...(detail === undefined ? {} : { "data-auth-detail": detail })}
      className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-background text-foreground"
    >
      <div
        aria-hidden
        data-slot="auth-ground"
        className={cn(
          "vibtra-auth-ground pointer-events-none absolute inset-0 -z-10",
          reduced ? undefined : "vibtra-auth-ground-in",
        )}
      />

      <header data-slot="auth-nav" className="flex h-[88px] shrink-0 items-center justify-between px-6 md:px-16">
        {layout === "split" ? (
          <VibtraMark className="size-7 text-foreground" />
        ) : (
          <span />
        )}
        {nav === undefined ? null : <div className="text-sm font-semibold text-foreground">{nav}</div>}
      </header>

      {layout === "split" ? (
        <main
          data-slot="auth-main"
          className="mx-auto flex w-full max-w-[1312px] flex-1 flex-col items-center gap-12 px-6 pt-4 pb-24 md:flex-row md:items-start md:gap-24 md:px-16 md:pt-16"
        >
          <div data-slot="auth-aside" className="min-w-0 flex-1 text-left">
            {aside}
          </div>
          <div className="flex w-full max-w-[510px] shrink-0 flex-col items-center">
            <div
              data-slot="auth-card"
              className="w-full overflow-hidden rounded-xl rounded-b-2xl border border-b-[6px] border-border bg-card [border-bottom-color:var(--v-accent)]"
            >
              <div className="flex min-h-[500px] flex-col justify-center px-8 py-12 md:px-[100px]">
                {title === undefined && subtitle === undefined ? null : (
                  <div className="mb-8 text-center">
                    {title === undefined ? null : (
                      <h1 className="text-[18px] leading-6 font-normal text-foreground [&_strong]:font-bold">
                        {title}
                      </h1>
                    )}
                    {subtitle === undefined ? null : (
                      <p className="mt-2 text-sm leading-para text-muted-foreground">{subtitle}</p>
                    )}
                  </div>
                )}
                {children}
              </div>
            </div>
            {prompt === undefined ? null : (
              <div className="mt-10 text-center text-sm font-medium text-foreground">{prompt}</div>
            )}
          </div>
        </main>
      ) : (
        <main
          data-slot="auth-main"
          className="mx-auto flex w-full max-w-[450px] flex-1 flex-col items-center justify-center px-6 pt-16 pb-24 text-center"
        >
          {mark === "solid" ? (
            <VibtraMark className="size-7 text-foreground" />
          ) : mark === "outline" ? (
            <VibtraMarkOutline className="size-7 text-foreground" />
          ) : null}
          {title === undefined ? null : (
            <h1 className="mt-8 text-[22px] leading-7 font-bold tracking-[-0.03em] text-foreground">{title}</h1>
          )}
          {subtitle === undefined ? null : (
            <p className="mt-2 max-w-[360px] text-sm leading-para text-muted-foreground">{subtitle}</p>
          )}
          {children === undefined || children === null ? null : <div className="mt-8 w-full">{children}</div>}
          {prompt === undefined ? null : (
            <div className="mt-2 pt-8 text-sm font-medium text-foreground">{prompt}</div>
          )}
          {postscript === undefined || postscript === null ? null : (
            <div data-slot="auth-postscript" className="mt-3 w-full">
              {postscript}
            </div>
          )}
        </main>
      )}

      {footer === undefined ? null : (
        <footer
          data-slot="auth-footer"
          className="px-6 py-4 text-center font-mono text-[11px] leading-[1.4] text-foreground opacity-55 md:fixed md:inset-x-0 md:bottom-0"
        >
          {footer}
        </footer>
      )}
    </div>
  );
}

export function AuthDoors({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div data-slot="auth-doors" className={cn("mx-auto flex w-full max-w-[240px] flex-col items-stretch gap-2.5", className)}>
      {children}
    </div>
  );
}

export const authRevealClass = "vibtra-auth-reveal";

export const authPillClass =
  "focus-knox inline-flex h-11 w-full items-center justify-center gap-3 whitespace-nowrap rounded-full border border-border bg-card px-5 text-sm font-[550] tracking-[-0.01em] text-foreground transition-colors duration-[120ms] hover:bg-muted disabled:pointer-events-none disabled:opacity-60 active:not-disabled:translate-y-px";

export const authSolidPillClass =
  "focus-knox inline-flex h-11 w-full items-center justify-center gap-3 rounded-full bg-primary px-5 text-sm font-[550] tracking-[-0.01em] text-primary-foreground transition-opacity duration-[120ms] hover:opacity-90 disabled:pointer-events-none disabled:opacity-60 active:not-disabled:translate-y-px";

export function AuthDivider({ children = "or" }: { children?: React.ReactNode }) {
  return (
    <div
      data-slot="auth-divider"
      role="separator"
      className="my-5 flex items-center gap-4 text-sm text-muted-foreground before:flex-1 before:border-t before:border-dotted before:border-border after:flex-1 after:border-t after:border-dotted after:border-border"
    >
      <span>{children}</span>
    </div>
  );
}

export const authLinkClass =
  "focus-knox rounded-sm font-bold underline decoration-dotted underline-offset-2";

export function AuthNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return <p className={cn("mt-5 text-center text-sm leading-para text-muted-foreground", className)}>{children}</p>;
}
