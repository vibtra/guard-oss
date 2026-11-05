import * as React from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  MousePointer2Icon,
  RotateCwIcon,
  SmartphoneIcon,
} from "lucide-react";
import { cn } from "../lib/cn";

const ROUND =
  "focus-knox inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-foreground [&_svg]:size-3";

export interface ChromeControl {
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
}

export function BrowserChrome({
  address,
  back = { disabled: true },
  forward = { disabled: true },
  reload = { disabled: true },
  inspect = { disabled: true },
  linkActions,
  mobile,
  onMobileChange,
  className,
  children,
}: {
  address: string;
  back?: ChromeControl;
  forward?: ChromeControl;
  reload?: ChromeControl;
  inspect?: ChromeControl;
  linkActions?: React.ReactNode;
  mobile?: boolean;
  onMobileChange?: (mobile: boolean) => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const control = (label: string, glyph: React.ReactNode, c: ChromeControl) => (
    <button
      type="button"
      aria-label={label}
      title={c.title ?? label}
      disabled={c.disabled}
      onClick={c.onClick}
      className={ROUND}
    >
      {glyph}
    </button>
  );
  return (
    <div data-slot="browser-chrome" className={cn("flex min-h-0 flex-1 flex-col", className)}>
      <div className="flex h-10 shrink-0 items-center gap-1 p-2 hairline-b">
        {control("Back", <ArrowLeftIcon aria-hidden />, back)}
        {control("Forward", <ArrowRightIcon aria-hidden />, forward)}
        {control("Reload", <RotateCwIcon aria-hidden />, reload)}
        <div className="flex min-w-0 flex-1 items-center">
          <span
            data-slot="browser-address"
            title={address}
            className={cn(
              "flex h-6 min-w-0 flex-1 items-center justify-center truncate rounded-full bg-accent px-2.5",
              "text-xs font-medium tracking-h-xs text-muted-foreground",
              linkActions !== undefined && "rounded-r-none",
            )}
          >
            <span className="truncate">{address}</span>
          </span>
          {linkActions === undefined ? null : (
            <span className="flex h-6 items-center rounded-r-full bg-accent pr-0.5">{linkActions}</span>
          )}
        </div>
        {onMobileChange === undefined ? null : (
          <button
            type="button"
            aria-label="Phone width"
            title="Phone width"
            aria-pressed={mobile === true}
            onClick={() => onMobileChange(!(mobile === true))}
            className={ROUND}
          >
            <SmartphoneIcon aria-hidden />
          </button>
        )}
        <button
          type="button"
          disabled={inspect.disabled}
          title={inspect.title ?? "Inspect"}
          onClick={inspect.onClick}
          className="focus-knox inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2 text-xs font-medium tracking-h-xs text-foreground outline-hidden hover:bg-accent disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-3"
        >
          <MousePointer2Icon aria-hidden />
          Inspect
        </button>
      </div>
      <div
        data-slot="browser-body"
        className={cn("relative flex min-h-0 flex-1 flex-col", mobile === true && "mx-auto w-[390px] max-w-full border-x-[0.5px] border-border")}
      >
        {children}
      </div>
    </div>
  );
}
