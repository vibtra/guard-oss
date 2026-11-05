import * as React from "react";
import { ArrowUpRightIcon, CheckIcon, ChevronDownIcon, LogOutIcon, MoonIcon, SunIcon } from "lucide-react";
import { cn } from "@/components/kit/cn";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CONSOLE_LOGIN_PATH, consolePathFor } from "@vibtra/console-api";
import { useAccount, useSession } from "../api/session";
import { authClient } from "../auth/client";
import { useTheme } from "../theme";

export const orgInitials = (given: string | undefined): string => {
  const name = given ?? "";
  const parts = name.split(/[\s._-]+/).filter((p) => p !== "");
  const two = parts.length >= 2 ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}` : name.slice(0, 2);
  return two.toUpperCase();
};

export function OrgAvatar({ name, size = 32, className }: { name: string; size?: 24 | 32; className?: string }) {
  return (
    <span
      aria-hidden
      data-slot="org-avatar"
      className={cn(
        "inline-flex shrink-0 items-center justify-center bg-g-accent font-[600] text-g-on-solid",
        size === 24 ? "size-6 rounded-md text-10" : "size-8 rounded-g-control text-11",
        className,
      )}
    >
      {orgInitials(name)}
    </span>
  );
}

export function AccountMenu() {
  const account = useAccount();
  const session = useSession();
  const [, toggleTheme, resolved] = useTheme();
  const [signingOut, setSigningOut] = React.useState(false);
  const signOut = () => {
    setSigningOut(true);
    void authClient.signOut().finally(() => {
      window.location.assign(`${CONSOLE_LOGIN_PATH}?signed-out=1`);
    });
  };
  const label = `${session.orgName}, ${account.name}, account menu`;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="account-trigger"
        className="focus-knox inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-g-control outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-tint data-popup-open:bg-g-tint"
        aria-label={label}
      >
        <OrgAvatar name={session.orgName} size={24} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom" sideOffset={6} data-slot="account-menu" className="w-[240px] min-w-[240px]">
        <div className="truncate px-2 pt-1.5 pb-2 text-12 text-g-muted">
          <span className="block truncate text-13 font-medium text-g-ink">{account.name}</span>
          {account.email}
        </div>
        <DropdownMenuSeparator className="mx-0 my-1" />
        <DropdownMenuGroup>
          <DropdownMenuItem onClick={toggleTheme}>
            {resolved === "dark" ? <SunIcon aria-hidden /> : <MoonIcon aria-hidden />}
            {resolved === "dark" ? "Light mode" : "Dark mode"}
          </DropdownMenuItem>
          <DropdownMenuItem render={<a href={consolePathFor(session.handle)} />}>
            <ArrowUpRightIcon aria-hidden />
            Open the Vibtra console
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator className="mx-0 my-1" />
        <DropdownMenuItem disabled={signingOut} onClick={signOut}>
          <LogOutIcon aria-hidden />
          {signingOut ? "Signing out…" : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function WorkspaceMenu({ variant = "block" }: { variant?: "block" | "rail" }) {
  const session = useSession();
  const label = `${session.orgName}, organisation`;
  return (
    <DropdownMenu>
      {variant === "rail" ? (
        <DropdownMenuTrigger
          data-slot="workspace-trigger"
          data-variant="rail"
          aria-label={label}
          className="focus-knox inline-flex size-8 items-center justify-center rounded-g-control outline-hidden"
        >
          <OrgAvatar name={session.orgName} />
        </DropdownMenuTrigger>
      ) : (
        <DropdownMenuTrigger
          data-slot="workspace-trigger"
          data-variant="block"
          aria-label={label}
          className="focus-knox flex h-9 w-full min-w-0 cursor-pointer items-center gap-2 rounded-g-control border border-g-line bg-g-surface py-1 ps-1.5 pe-2.5 text-start outline-hidden transition-[background-color] duration-(--g-dur) ease-g hover:bg-g-hover data-popup-open:bg-g-hover"
        >
          <OrgAvatar name={session.orgName} size={24} />
          <span className="min-w-0 flex-1 truncate text-14 font-medium text-g-ink">{session.orgName}</span>
          <ChevronDownIcon aria-hidden className="size-4 shrink-0 text-g-muted transition-[rotate] duration-(--g-dur) ease-g in-data-popup-open:rotate-180" />
        </DropdownMenuTrigger>
      )}
      <DropdownMenuContent align="start" sideOffset={4} data-slot="workspace-menu" className="w-[254px]">
        <div className="px-2 pt-1 pb-1 text-12 font-medium text-g-muted">Organisation</div>
        <div data-slot="workspace-current" className="flex h-10 items-center gap-2.5 px-2 text-14 text-g-ink">
          <OrgAvatar name={session.orgName} size={24} />
          <span className="min-w-0 flex-1 truncate">{session.orgName}</span>
          <CheckIcon aria-label="Current organisation" className="size-4 text-g-ink" />
        </div>
        <DropdownMenuSeparator className="mx-0 my-1" />
        <DropdownMenuItem render={<a href={consolePathFor(session.handle)} />}>
          <ArrowUpRightIcon aria-hidden />
          Switch in the Vibtra console
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
