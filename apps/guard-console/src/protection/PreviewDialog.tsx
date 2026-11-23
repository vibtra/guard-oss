import * as React from "react";
import { Link } from "react-router";
import { ArrowRightIcon, RefreshCwIcon, UserMinusIcon } from "lucide-react";
import { toastError } from "@vibtra/ui/react";
import type { GuardProtectionApplied, GuardProtectionPage, GuardProtectionPreview } from "@vibtra/guard-contract";
import { ConsoleApiError, refusalWords } from "../api/client";
import { guard } from "../api/guard";
import { DoorError, DoorSkeleton } from "../shell/DoorState";
import { ActionButton, CountBadge, Modal, ModalFooter, cn, useHeld } from "@/components/kit";
import { protectionDoor } from "../people/doors";
import { ModePill } from "./modes";
import {
  askWords,
  changesOf,
  effectGroups,
  keptBy,
  movedCount,
  nameOf,
  nothingToApply,
  peopleWords,
  protectionHref,
  startingToBlock,
  tlsWords,
  type Ask,
  type EffectGroup,
  type Tls,
  type Who,
} from "./model";

type Ready = { at: "ready"; preview: GuardProtectionPreview; page: GuardProtectionPage; tls: Tls; stale: boolean; applying: boolean };

type Phase =
  | { at: "loading"; stale: boolean }
  | Ready
  | { at: "unknown"; ready: Ready; checking: boolean; reread: boolean }
  | { at: "left"; leavers: Who[] }
  | { at: "error"; error: ConsoleApiError };

export type OnApplied = (result: GuardProtectionApplied, ask: Ask, preview: GuardProtectionPreview) => void;

const NAMES_SHOWN = 8;

const asApiError = (error: unknown): ConsoleApiError =>
  error instanceof ConsoleApiError
    ? error
    : new ConsoleApiError({ status: 0, code: "INTERNAL", message: "Something went wrong", detail: error instanceof Error ? error.message : String(error) });

const askKey = (ask: Ask): string => JSON.stringify(changesOf(ask));

const refusedOutright = (error: unknown): boolean => error instanceof ConsoleApiError && error.status >= 400 && error.status < 500;

export function PreviewDialog({ ask, onClose, onApplied }: { ask: Ask | undefined; onClose: () => void; onApplied: OnApplied }) {
  const held = useHeld(ask);
  if (held.value === undefined) return null;
  return <Preview key={askKey(held.value)} ask={held.value} open={held.open} onClose={onClose} onApplied={onApplied} />;
}

function Preview({
  ask: asked,
  open,
  onClose,
  onApplied,
}: {
  ask: Ask;
  open: boolean;
  onClose: () => void;
  onApplied: OnApplied;
}) {
  const [ask, setAsk] = React.useState(asked);
  const [phase, setPhase] = React.useState<Phase>({ at: "loading", stale: false });
  const live = React.useRef(true);
  React.useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const refused = React.useCallback(async (from: Ask, error: unknown) => {
    const apiError = asApiError(error);
    if (apiError.status === 422 && from.kind === "people") {
      const fresh = await protectionDoor.page().catch(() => undefined);
      const members = new Set(fresh?.people.map((person) => person.userId) ?? []);
      const leavers = fresh === undefined ? [] : from.people.filter((who) => !members.has(who.userId));
      if (!live.current) return;
      setPhase(leavers.length > 0 ? { at: "left", leavers } : { at: "error", error: apiError });
      return;
    }
    if (live.current) setPhase({ at: "error", error: apiError });
  }, []);

  const preview = React.useCallback(
    async (current: Ask, stale: boolean) => {
      setPhase({ at: "loading", stale });
      try {
        const [next, page, settings] = await Promise.all([protectionDoor.preview(changesOf(current)), protectionDoor.page(), guard.settings()]);
        if (live.current) setPhase({ at: "ready", preview: next, page, tls: settings.settings.unreproducibleTls, stale, applying: false });
      } catch (error) {
        await refused(current, error);
      }
    },
    [refused],
  );

  React.useEffect(() => {
    void preview(ask, false);
  }, [ask, preview]);

  const check = async (ready: Ready) => {
    setPhase({ at: "unknown", ready, checking: true, reread: false });
    const fresh = await protectionDoor.page().catch(() => undefined);
    if (!live.current) return;
    if (fresh !== undefined && nothingToApply(ask, fresh)) {
      const applied = movedCount(ask, ready.page, ready.preview);
      onApplied({ revision: fresh.revision, applied, unchanged: ready.preview.people.length - applied }, ask, ready.preview);
      return;
    }
    setPhase({ at: "unknown", ready, checking: false, reread: fresh !== undefined });
  };

  const apply = async (ready: Ready) => {
    const previewed = ready.preview;
    setPhase({ ...ready, applying: true });
    try {
      const result = await protectionDoor.apply(changesOf(ask), previewed.revision, previewed.peopleDigest);
      if (live.current) onApplied(result, ask, previewed);
    } catch (error) {
      if (!live.current) return;
      if (error instanceof ConsoleApiError && error.status === 409) {
        await preview(ask, true);
        return;
      }
      if (error instanceof ConsoleApiError && error.status === 422) {
        await refused(ask, error);
        return;
      }
      if (refusedOutright(error)) {
        toastError("Nothing changed", refusalWords(error));
        setPhase({ ...ready, applying: false });
        return;
      }
      await check(ready);
    }
  };

  const shown = phase.at === "ready" ? phase : phase.at === "unknown" ? phase.ready : undefined;
  const words = askWords(ask, shown?.page.defaultMode);
  const remaining = phase.at === "left" && ask.kind === "people" ? ask.people.filter((who) => !phase.leavers.some((left) => left.userId === who.userId)) : [];
  const idle = phase.at === "ready" && nothingToApply(ask, phase.page);

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!(phase.at === "ready" && phase.applying)) onClose();
      }}
      size="list"
      role="dialog"
      title={words.title}
      description={shown === undefined ? undefined : <span data-testid="preview-summary">{shown.preview.summary}</span>}
      footer={
        <ModalFooter>
          <ActionButton static onClick={onClose} aria-disabled={(phase.at === "ready" && phase.applying) || undefined}>
            Cancel
          </ActionButton>
          {phase.at === "left" ? (
            remaining.length === 0 ? null : (
              <ActionButton variant="primary" icon={RefreshCwIcon} onClick={() => ask.kind === "people" && setAsk({ ...ask, people: remaining })}>
                Preview without them
              </ActionButton>
            )
          ) : phase.at === "unknown" ? (
            <ActionButton variant="primary" icon={RefreshCwIcon} loading={phase.checking} onClick={() => void check(phase.ready)}>
              Check again
            </ActionButton>
          ) : (
            <ActionButton
              variant={words.danger ? "danger" : "primary"}
              loading={phase.at === "ready" && phase.applying}
              disabled={phase.at !== "ready" || idle}
              onClick={() => phase.at === "ready" && void apply(phase)}
              data-testid="preview-confirm"
            >
              {words.confirm}
            </ActionButton>
          )}
        </ModalFooter>
      }
    >
      <div data-testid="protection-preview" className="flex flex-col gap-4">
        {(phase.at === "loading" || phase.at === "ready") && phase.stale ? (
          <p role="status" data-testid="preview-stale" className="rounded-g-card border border-g-pill-warn-line bg-g-pill-warn-bg px-4 py-3 text-14 text-g-pill-warn-ink">
            Someone changed protection after this preview was made, so nothing was applied. This is a fresh preview: check it, then confirm again.
          </p>
        ) : null}
        {phase.at === "unknown" ? (
          <p role="alert" data-testid="preview-unknown" className="rounded-g-card border border-g-pill-warn-line bg-g-pill-warn-bg px-4 py-3 text-14 text-g-pill-warn-ink">
            {phase.checking
              ? "The registry did not answer. Checking whether this was saved…"
              : `The registry did not answer, so it is not known whether this was saved. ${phase.reread ? "It does not show as saved yet; check again in a moment." : "Check again when the connection is back."}`}
          </p>
        ) : null}
        {phase.at === "loading" ? (
          <DoorSkeleton rows={3} />
        ) : phase.at === "error" ? (
          <DoorError error={phase.error} onRetry={() => void preview(ask, false)} />
        ) : phase.at === "left" ? (
          <Leavers leavers={phase.leavers} remaining={remaining.length} />
        ) : shown === undefined ? null : (
          <Effects preview={shown.preview} ask={ask} page={shown.page} tls={shown.tls} idle={idle} onLeave={onClose} />
        )}
      </div>
    </Modal>
  );
}

function Leavers({ leavers, remaining }: { leavers: readonly Who[]; remaining: number }) {
  return (
    <div role="alert" data-testid="preview-left" className="flex flex-col gap-3">
      <p className="flex items-start gap-3 text-14 text-g-ink">
        <UserMinusIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-g-muted" />
        <span>
          {leavers.map(nameOf).join(", ")} {leavers.length === 1 ? "is" : "are"} no longer in the organisation, so nothing changed.{" "}
          {remaining === 0 ? "Nobody else was picked." : `Preview the change again for the other ${peopleWords(remaining)}.`}
        </span>
      </p>
    </div>
  );
}

function Effects({ preview, ask, page, tls, idle, onLeave }: { preview: GuardProtectionPreview; ask: Ask; page: GuardProtectionPage; tls: Tls; idle: boolean; onLeave: () => void }) {
  const groups = effectGroups(preview.people);
  const kept = keptBy(ask, page);
  const newlyBlocked = startingToBlock(preview.people, tls);
  const tlsLine = tlsWords(preview.people, tls);
  return (
    <>
      {groups.length === 0 ? (
        <p className="text-14 text-g-muted">Nobody is on the default, so changing it moves no one now. People who join later start on the new default.</p>
      ) : (
        <ul aria-label="What changes for each person" className="flex flex-col gap-3">
          {groups.map((group) => (
            <EffectRow key={group.key} group={group} />
          ))}
        </ul>
      )}
      {tlsLine === undefined ? null : (
        <p data-testid="preview-tls" className="text-14 text-g-ink">
          {tlsLine}
        </p>
      )}
      {kept.length === 0 ? null : (
        <ul data-testid="preview-kept" aria-label="People this does not move" className="flex flex-col gap-2 rounded-g-card border border-g-line bg-g-header px-4 py-3">
          {kept.map((k) => (
            <li key={k.mode} data-mode={k.mode} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-14 text-g-ink">
              <span>{k.words}</span>
              <Link to={protectionHref({ mode: k.mode, source: "set" })} onClick={onLeave} className="focus-knox shrink-0 rounded-sm font-medium underline underline-offset-4 outline-hidden">
                Show them
              </Link>
            </li>
          ))}
        </ul>
      )}
      {idle ? <p className="text-14 text-g-muted">Everyone here is already as asked. There is nothing to apply.</p> : null}
      {newlyBlocked === 0 ? null : (
        <p data-testid="preview-notice" className="text-14 text-g-ink">
          Guard starts blocking for {peopleWords(newlyBlocked)}. Make sure they have had the{" "}
          <Link to="/settings?sheet=notice" onClick={onLeave} className="focus-knox rounded-sm font-medium underline underline-offset-4 outline-hidden">
            staff notice
          </Link>
          .
        </p>
      )}
      <p className="text-13 text-g-muted">Macs that are awake switch within seconds. The others switch when they next check in. Nobody is told; the Guard panel on each Mac shows its mode.</p>
    </>
  );
}

function EffectRow({ group }: { group: EffectGroup }) {
  const [all, setAll] = React.useState(false);
  const moves = group.from !== group.to;
  const shown = all ? group.people : group.people.slice(0, NAMES_SHOWN);
  const hidden = group.people.length - shown.length;
  return (
    <li data-testid="effect" data-from={group.from} data-to={group.to} className="flex flex-col gap-2 rounded-g-card border border-g-line px-4 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <span data-testid="effect-words" className={cn("min-w-0 flex-1 text-14 font-medium text-pretty", moves ? "text-g-ink-strong" : "text-g-muted")}>
          {group.effect}
        </span>
        <span className="shrink-0">
          <CountBadge count={group.people.length} />
          <span className="sr-only"> {group.people.length === 1 ? "person" : "people"}</span>
        </span>
      </div>
      <span className="flex flex-wrap items-center gap-1.5">
        {moves ? (
          <>
            <ModePill mode={group.from} />
            <ArrowRightIcon aria-hidden className="size-3.5 text-g-muted rtl:-scale-x-100" />
            <span className="sr-only">to</span>
          </>
        ) : null}
        <ModePill mode={group.to} />
      </span>
      <p data-testid="effect-people" className="text-13 text-pretty text-g-muted">
        {shown.map(nameOf).join(", ")}
        {hidden > 0 ? (
          <>
            {", "}
            <button type="button" onClick={() => setAll(true)} className="focus-knox cursor-pointer rounded-sm font-medium text-g-ink underline underline-offset-4 outline-hidden">
              and {hidden} more
            </button>
          </>
        ) : null}
      </p>
    </li>
  );
}
