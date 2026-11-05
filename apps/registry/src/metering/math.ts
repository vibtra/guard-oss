export const MINUTE_MS = 60_000;
export const LOST_HOST_GRACE_MS = 2 * MINUTE_MS;

export interface HostState {
  connected: boolean;
  lastSeenAt?: string;
}

export const lostHostEnd = (nowMs: number, state: HostState): number => {
  if (state.connected || state.lastSeenAt === undefined) return nowMs;
  const last = Date.parse(state.lastSeenAt);
  return Number.isFinite(last) ? Math.min(nowMs, last + LOST_HOST_GRACE_MS) : nowMs;
};

export interface PeriodWindow {
  start: Date;
  end: Date;
}

export const utcMonth = (at: Date): PeriodWindow => {
  const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
  const end = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));
  return { start, end };
};

const DAY_MS = 24 * 60 * 60 * 1000;

const anchorIn = (year: number, month: number, day: number, msOfDay: number): Date => {
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, last)) + msOfDay);
};

export const anchoredMonth = (at: Date, anchorDay: number, msOfDay = 0): PeriodWindow => {
  const day = Math.min(31, Math.max(1, Math.trunc(anchorDay)));
  const offset = Math.min(DAY_MS - 1, Math.max(0, Math.trunc(msOfDay)));
  let start = anchorIn(at.getUTCFullYear(), at.getUTCMonth(), day, offset);
  if (start.getTime() > at.getTime()) start = anchorIn(at.getUTCFullYear(), at.getUTCMonth() - 1, day, offset);
  const end = anchorIn(start.getUTCFullYear(), start.getUTCMonth() + 1, day, offset);
  return { start, end };
};

export const periodFor = (org: { plan?: string; stripeSubscriptionId?: string; stripeCurrentPeriodEnd?: string } | undefined, at: Date): PeriodWindow => {
  if (org !== undefined && org.plan !== "free" && org.stripeSubscriptionId !== undefined && org.stripeCurrentPeriodEnd !== undefined) {
    const anchor = new Date(org.stripeCurrentPeriodEnd);
    if (!Number.isNaN(anchor.getTime())) return anchoredMonth(at, anchor.getUTCDate(), anchor.getTime() - Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), anchor.getUTCDate()));
  }
  return utcMonth(at);
};

export const resetsOn = (window: PeriodWindow): string => window.end.toISOString().slice(0, 10);

export interface MeteredInterval {
  workspaceId: string;
  startedAt: string;
  stoppedAt?: string;
}
export interface MeteredAttachment {
  workspaceId: string;
  openedAt: string;
  closedAt?: string;
}

export interface SessionUsage {
  totalMinutes: number;
  attachedMinutes: number;
  detachedMinutes: number;
  perWorkspace: Map<string, { minutes: number; attachedMinutes: number }>;
}

const ms = (iso: string): number => Date.parse(iso);

export const unionMs = (windows: ReadonlyArray<readonly [number, number]>, lo: number, hi: number): number => {
  const clipped = windows
    .map(([a, b]) => [Math.max(a, lo), Math.min(b, hi)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let total = 0;
  let curA = -Infinity;
  let curB = -Infinity;
  for (const [a, b] of clipped) {
    if (a > curB) {
      if (curB > curA) total += curB - curA;
      curA = a;
      curB = b;
    } else curB = Math.max(curB, b);
  }
  if (curB > curA) total += curB - curA;
  return total;
};

export const meterSessions = (
  intervals: readonly MeteredInterval[],
  attachments: readonly MeteredAttachment[],
  window: PeriodWindow,
  openEnd: (workspaceId: string) => number,
): SessionUsage => {
  const lo = window.start.getTime();
  const hi = window.end.getTime();
  const byWorkspace = new Map<string, Array<readonly [number, number]>>();
  for (const a of attachments) {
    const list = byWorkspace.get(a.workspaceId) ?? [];
    list.push([ms(a.openedAt), a.closedAt !== undefined ? ms(a.closedAt) : Number.POSITIVE_INFINITY]);
    byWorkspace.set(a.workspaceId, list);
  }
  const msByWorkspace = new Map<string, { ms: number; attachedMs: number }>();
  for (const i of intervals) {
    const start = Math.max(ms(i.startedAt), lo);
    const rawEnd = i.stoppedAt !== undefined ? ms(i.stoppedAt) : openEnd(i.workspaceId);
    const end = Math.min(rawEnd, hi);
    if (!(end > start)) continue;
    const row = msByWorkspace.get(i.workspaceId) ?? { ms: 0, attachedMs: 0 };
    row.ms += end - start;
    row.attachedMs += unionMs(byWorkspace.get(i.workspaceId) ?? [], start, end);
    msByWorkspace.set(i.workspaceId, row);
  }
  const perWorkspace = new Map<string, { minutes: number; attachedMinutes: number }>();
  let total = 0;
  let attached = 0;
  for (const [workspaceId, row] of msByWorkspace) {
    const minutes = Math.ceil(row.ms / MINUTE_MS);
    const attachedMinutes = Math.min(minutes, Math.ceil(row.attachedMs / MINUTE_MS));
    total += minutes;
    attached += attachedMinutes;
    perWorkspace.set(workspaceId, { minutes, attachedMinutes });
  }
  return { totalMinutes: total, attachedMinutes: attached, detachedMinutes: total - attached, perWorkspace };
};

export const meterAwake = (intervals: ReadonlyArray<{ awakeFrom: string; awakeTo?: string }>, window: PeriodWindow, openEnd: number): number => {
  let total = 0;
  for (const i of intervals) {
    const start = Math.max(ms(i.awakeFrom), window.start.getTime());
    const end = Math.min(i.awakeTo !== undefined ? ms(i.awakeTo) : openEnd, window.end.getTime());
    if (end > start) total += Math.ceil((end - start) / MINUTE_MS);
  }
  return total;
};

export const peakBoxes = (boxes: ReadonlyArray<{ createdAt: string; deletedAt?: string }>, window: PeriodWindow, now: number): number => {
  const lo = window.start.getTime();
  const hi = Math.min(window.end.getTime(), now + 1);
  const events: Array<[number, number]> = [];
  for (const b of boxes) {
    const from = Math.max(ms(b.createdAt), lo);
    const to = Math.min(b.deletedAt !== undefined ? ms(b.deletedAt) : Number.POSITIVE_INFINITY, hi);
    if (!(to > from)) continue;
    events.push([from, 1], [to, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let alive = 0;
  let peak = 0;
  for (const [, delta] of events) {
    alive += delta;
    peak = Math.max(peak, alive);
  }
  return peak;
};

export const overageMinutes = (used: number, includedHours: number | null): number => (includedHours === null ? 0 : Math.max(0, used - includedHours * 60));

export const overageCents = (minutes: number, centsPerHour: number | null): number => (centsPerHour === null || minutes <= 0 ? 0 : Math.ceil(minutes / 60) * centsPerHour);

export const hoursOf = (minutes: number): number => Math.round((minutes / 60) * 10) / 10;
