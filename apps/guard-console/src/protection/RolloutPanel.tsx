import * as React from "react";
import { ChevronRightIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { guard } from "../api/guard";
import { useDoor } from "../api/useDoor";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { When } from "../guard/words";
import { ActionButton, Pill, SheetList, cn } from "@/components/kit";
import { protectionDoor } from "../people/doors";
import { nameOf, rolloutView, type RolloutScope, type RolloutView } from "./model";

const FAST_FOR_MS = 60_000;
const FAST_MS = 2_000;
const SLOW_MS = 10_000;
const STOP_AFTER_MS = 10 * 60_000;
const PENDING_SHOWN = 50;

export function RolloutPanel({
  revision,
  scope,
  arrived,
  onDismiss,
}: {
  revision: number;
  scope: RolloutScope | undefined;
  arrived: boolean;
  onDismiss: () => void;
}) {
  const heading = React.useRef<HTMLHeadingElement>(null);
  React.useEffect(() => {
    if (arrived) heading.current?.focus();
  }, [arrived]);
  const door = useDoor(() => Promise.all([protectionDoor.rollout(revision), guard.settings()]), [revision]);
  const { reload } = door;
  const started = React.useRef(Date.now());
  const [tick, setTick] = React.useState(0);
  const [stopped, setStopped] = React.useState(false);
  const known = scope?.revision === revision ? scope : undefined;
  const view = door.state.status === "ready" ? rolloutView(door.state.data[0], Date.now(), known, door.state.data[1].settings.unreproducibleTls) : undefined;
  const done = view?.done === true;
  const empty = view === undefined || (view.lines.length === 0 && view.olderWords === undefined && !view.replacedAll);

  React.useEffect(() => {
    if (door.state.status !== "ready" || done || stopped) return undefined;
    const age = Date.now() - started.current;
    if (age > STOP_AFTER_MS) {
      setStopped(true);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      if (document.visibilityState === "hidden") setTick((n) => n + 1);
      else reload();
    }, age < FAST_FOR_MS ? FAST_MS : SLOW_MS);
    return () => window.clearTimeout(timer);
  }, [reload, door.state, done, stopped, tick]);

  const refresh = () => {
    started.current = Date.now();
    setStopped(false);
    reload();
  };

  return (
    <section data-testid="rollout" aria-labelledby="rollout-title" className="g-enter mb-6 rounded-g-card border border-g-line bg-g-surface px-5 py-4 max-md:px-4">
      <div className="flex items-start gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 ref={heading} id="rollout-title" tabIndex={-1} className="focus-knox rounded-sm text-14 font-medium text-pretty text-g-ink-strong outline-hidden">
              Rollout
              {known === undefined ? null : <span className="font-normal text-g-muted"> · {known.label}</span>}
            </h2>
            {empty ? null : view.replacedAll ? (
              <Pill tone="neutral" data-testid="rollout-state">
                Replaced by a later change
              </Pill>
            ) : done && view.olderWords !== undefined ? (
              <Pill tone="warn" data-testid="rollout-state">
                Needs a Guard update
              </Pill>
            ) : done ? (
              <Pill tone="ok" dot="ok" data-testid="rollout-state">
                Every Mac has it
              </Pill>
            ) : (
              <Pill tone="neutral" data-testid="rollout-state">
                {stopped ? "Still pending" : "In progress"}
              </Pill>
            )}
          </div>
          {door.state.status === "loading" ? (
            <DoorSkeleton rows={2} />
          ) : door.state.status === "error" ? (
            <DoorError error={door.state.error} onRetry={door.reload} />
          ) : view === undefined ? null : (
            <>
              {known === undefined ? <p className="text-13 text-g-muted">This counts every Mac given a new policy since this change, which can include people it did not move.</p> : null}
              <RolloutBody view={view} stopped={stopped} onRefresh={refresh} />
            </>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Close the rollout"
          className="focus-knox -me-2 -mt-1 inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-g-control text-g-muted outline-hidden transition-[background-color,color] duration-(--g-dur) ease-g hover:bg-g-tint hover:text-g-ink"
        >
          <XIcon aria-hidden className="size-4" />
        </button>
      </div>
    </section>
  );
}

function RolloutBody({ view, stopped, onRefresh }: { view: RolloutView; stopped: boolean; onRefresh: () => void }) {
  const [open, setOpen] = React.useState(false);
  const shown = view.pending.slice(0, PENDING_SHOWN);
  return (
    <>
      {view.lines.length === 0 ? (
        view.olderWords === undefined && !view.replacedAll ? <p className="text-14 text-g-muted">None of the people in this change has a Mac yet.</p> : null
      ) : (
        <ul aria-live="polite" className="flex flex-col gap-3">
          {view.lines.map((line) => (
            <li key={line.mode} data-testid="rollout-line" data-mode={line.mode} className="flex flex-col gap-2">
              <span className="text-18 font-medium text-pretty text-g-ink-strong tabular-nums">{line.words}</span>
              <Meter applied={line.applied} total={line.macs} />
            </li>
          ))}
        </ul>
      )}
      {view.pendingWords === undefined ? null : (
        <p data-testid="rollout-pending" className="text-14 text-g-ink tabular-nums">
          {view.pendingWords}.{" "}
          <span className="text-g-muted">A Mac switches when it checks in; asleep or offline Macs switch when they wake.</span>
        </p>
      )}
      {view.olderWords === undefined ? null : (
        <p data-testid="rollout-older" className="text-14 text-g-ink tabular-nums">
          {view.olderWords}
        </p>
      )}
      {view.replacedWords === undefined ? null : (
        <p data-testid="rollout-replaced" className="text-14 text-g-ink">
          {view.replacedWords}
        </p>
      )}
      {view.withoutMacWords === undefined ? null : (
        <p data-testid="rollout-no-mac" className="text-14 text-g-muted">
          {view.withoutMacWords}
        </p>
      )}
      {view.pending.length === 0 && !stopped ? null : (
        <div className="flex flex-wrap items-center gap-2">
          {view.pending.length === 0 ? null : (
            <ActionButton variant="ghost" onClick={() => setOpen((was) => !was)} aria-expanded={open} aria-controls="rollout-pending-macs" className="-ms-3">
              <ChevronRightIcon aria-hidden className={cn("transition-[rotate] duration-(--g-dur) ease-g rtl:-scale-x-100", open && "rotate-90 rtl:-rotate-90")} />
              {open ? "Hide the pending Macs" : "Show the pending Macs"}
            </ActionButton>
          )}
          {stopped ? (
            <ActionButton variant="ghost" icon={RefreshCwIcon} onClick={onRefresh}>
              Check again
            </ActionButton>
          ) : null}
        </div>
      )}
      {open && view.pending.length > 0 ? (
        <div id="rollout-pending-macs" className="flex flex-col gap-2">
          <SheetList
            label="Pending Macs"
            items={shown}
            itemKey={(mac) => mac.device.deviceId}
            render={(mac) => (
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 px-4 py-2.5">
                <span className="flex min-w-[10rem] flex-1 flex-col">
                  <span className="truncate text-14 font-medium text-g-ink">{mac.device.hostname}</span>
                  <span className="truncate text-13 text-g-muted">{nameOf(mac.person)}</span>
                </span>
                <span className="shrink-0 text-13 text-g-muted">
                  {mac.device.lastSeenAt === undefined ? "Never checked in" : <When iso={mac.device.lastSeenAt} prefix="Last seen" />}
                </span>
              </div>
            )}
          />
          {view.pending.length > shown.length ? <p className="text-13 text-g-muted">The {shown.length} seen longest ago, of {view.pending.length}.</p> : null}
        </div>
      ) : null}
    </>
  );
}

function Meter({ applied, total }: { applied: number; total: number }) {
  const share = total === 0 ? 0 : applied / total;
  return (
    <span aria-hidden data-slot="rollout-meter" className="flex h-1.5 w-full max-w-[480px] gap-0.5">
      {applied === 0 ? null : <span className="h-full rounded-full bg-g-ink transition-[flex-grow] duration-(--g-dur) ease-g" style={{ flexGrow: share }} />}
      {applied === total ? null : <span className="h-full rounded-full bg-g-tint transition-[flex-grow] duration-(--g-dur) ease-g" style={{ flexGrow: 1 - share }} />}
    </span>
  );
}
