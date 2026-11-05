import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

export const METERS = ["session", "appbox_awake", "appbox_extra"] as const;
export type Meter = (typeof METERS)[number];
export const NOTICE_KINDS = ["cap80", "cap100", "hours80", "hours100", "quota-stop"] as const;
export type NoticeKind = (typeof NOTICE_KINDS)[number];

const ISO = z.string().min(10).max(40);
const ORG_ID = z.string().min(1).max(100);

export const UsagePeriodRow = z
  .object({
    orgId: ORG_ID,
    meter: z.enum(METERS),
    periodStart: ISO,
    periodEnd: ISO,
    plan: z.string().min(1).max(40),
    includedMinutes: z.number().int().min(0).nullable(),
    usedMinutes: z.number().int().min(0),
    reportedOverageMinutes: z.number().int().min(0),
    state: z.enum(["open", "closed"]),
    updatedAt: ISO,
  })
  .strict();
export type UsagePeriodRow = z.infer<typeof UsagePeriodRow>;

export const UsageReportRow = z
  .object({
    id: z.string().regex(/^urp_[0-9a-f]{16}$/),
    orgId: ORG_ID,
    meter: z.enum(METERS),
    periodStart: ISO,
    quantity: z.number().int().min(0),
    stripeIdentifier: z.string().min(1).max(200),
    status: z.enum(["pending", "sent", "failed"]),
    attempts: z.number().int().min(0),
    createdAt: ISO,
    sentAt: ISO.optional(),
  })
  .strict();
export type UsageReportRow = z.infer<typeof UsageReportRow>;

export const UsageNoticeRow = z
  .object({
    orgId: ORG_ID,
    periodStart: ISO,
    kind: z.enum(NOTICE_KINDS),
    at: ISO,
    stopAt: ISO.optional(),
    doneAt: ISO.optional(),
  })
  .strict();
export type UsageNoticeRow = z.infer<typeof UsageNoticeRow>;

export const APP_BOX_STATUSES = ["provisioning", "asleep", "waking", "awake", "sleeping", "parked", "restoring", "failed", "deleting", "deleted", "stopped"] as const;
export const AppBoxRow = z
  .object({
    id: z.string().regex(/^abx_[0-9a-z]{8,40}$/),
    orgId: ORG_ID,
    name: z.string().min(1).max(64),
    status: z.enum(APP_BOX_STATUSES),
    storageGb: z.number().int().min(0),
    createdAt: ISO,
    deletedAt: ISO.optional(),
  })
  .strict();
export type AppBoxRow = z.infer<typeof AppBoxRow>;

export const AppBoxIntervalRow = z
  .object({ boxId: z.string().regex(/^abx_[0-9a-z]{8,40}$/), orgId: ORG_ID, awakeFrom: ISO, awakeTo: ISO.optional() })
  .strict();
export type AppBoxIntervalRow = z.infer<typeof AppBoxIntervalRow>;

export const SpendingCapRow = z
  .object({
    orgId: ORG_ID,
    capCents: z.number().int().min(0).nullable(),
    explicitUnlimited: z.boolean(),
    setBy: z.string().min(1).max(320),
    setAt: ISO,
  })
  .strict()
  .refine((r) => r.capCents !== null || r.explicitUnlimited, { message: "no cap is only an explicit choice" });
export type SpendingCapRow = z.infer<typeof SpendingCapRow>;

export const DEFAULT_SPENDING_CAP_CENTS = 10_000;

export interface MeteringStore {
  getPeriod(orgId: string, meter: Meter, periodStart: string): Promise<UsagePeriodRow | undefined>;
  upsertPeriod(row: UsagePeriodRow): Promise<UsagePeriodRow>;
  listPeriods(filter: { orgId?: string; meter?: Meter; plan?: string; periodStart?: string; periodStartFrom?: string; periodStartBefore?: string; state?: "open" | "closed" }): Promise<UsagePeriodRow[]>;

  insertReport(row: UsageReportRow): Promise<boolean>;
  updateReport(id: string, patch: Pick<UsageReportRow, "status" | "attempts"> & { sentAt?: string }): Promise<void>;
  listReports(filter: { orgId?: string; meter?: Meter; periodStart?: string; status?: UsageReportRow["status"] }): Promise<UsageReportRow[]>;

  getNotice(orgId: string, periodStart: string, kind: NoticeKind): Promise<UsageNoticeRow | undefined>;
  insertNotice(row: UsageNoticeRow): Promise<boolean>;
  updateNotice(orgId: string, periodStart: string, kind: NoticeKind, patch: { doneAt?: string; stopAt?: string }): Promise<void>;
  deleteNotice(orgId: string, periodStart: string, kind: NoticeKind): Promise<void>;
  listNotices(filter: { orgId?: string; kind?: NoticeKind; open?: boolean }): Promise<UsageNoticeRow[]>;

  insertBox(row: AppBoxRow): Promise<void>;
  getBox(id: string): Promise<AppBoxRow | undefined>;
  updateBox(id: string, patch: Partial<Pick<AppBoxRow, "status" | "deletedAt" | "storageGb" | "name">>): Promise<AppBoxRow | undefined>;
  listBoxes(orgId: string, options?: { includeDeleted?: boolean }): Promise<AppBoxRow[]>;
  openBoxInterval(row: AppBoxIntervalRow): Promise<void>;
  closeBoxInterval(boxId: string, at: string): Promise<boolean>;
  listBoxIntervals(orgId: string, from: string, to: string): Promise<AppBoxIntervalRow[]>;

  getCap(orgId: string): Promise<SpendingCapRow | undefined>;
  setCap(row: SpendingCapRow): Promise<void>;
}

interface FileShape {
  periods: UsagePeriodRow[];
  reports: UsageReportRow[];
  notices: UsageNoticeRow[];
  boxes: AppBoxRow[];
  boxIntervals: AppBoxIntervalRow[];
  caps: Record<string, SpendingCapRow>;
}

const empty = (): FileShape => ({ periods: [], reports: [], notices: [], boxes: [], boxIntervals: [], caps: {} });

const sameInstant = (a: string, b: string): boolean => Date.parse(a) === Date.parse(b);
const overlaps = (from: string, to: string | undefined, a: string, b: string): boolean =>
  Date.parse(from) < Date.parse(b) && (to === undefined || Date.parse(to) > Date.parse(a));

export const createFileMeteringStore = async (file: string): Promise<MeteringStore> => {
  let state: FileShape;
  try {
    state = { ...empty(), ...(JSON.parse(await readFile(file, "utf8")) as Partial<FileShape>) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    state = empty();
  }
  let chain: Promise<void> = Promise.resolve();
  const save = (): Promise<void> => {
    chain = chain.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, file);
    });
    return chain;
  };
  return createMeteringStoreOver(() => state, save);
};

export const createMemoryMeteringStore = (): MeteringStore => {
  const state = empty();
  return createMeteringStoreOver(() => state, async () => undefined);
};

const createMeteringStoreOver = (get: () => FileShape, save: () => Promise<void>): MeteringStore => ({
  async getPeriod(orgId, meter, periodStart) {
    const row = get().periods.find((p) => p.orgId === orgId && p.meter === meter && sameInstant(p.periodStart, periodStart));
    return row ? structuredClone(row) : undefined;
  },
  async upsertPeriod(row) {
    const parsed = UsagePeriodRow.parse(row);
    const state = get();
    const at = state.periods.findIndex((p) => p.orgId === parsed.orgId && p.meter === parsed.meter && sameInstant(p.periodStart, parsed.periodStart));
    if (at >= 0) {
      parsed.reportedOverageMinutes = Math.max(parsed.reportedOverageMinutes, state.periods[at]!.reportedOverageMinutes);
      parsed.plan = state.periods[at]!.plan;
      state.periods[at] = parsed;
    } else state.periods.push(parsed);
    await save();
    return structuredClone(parsed);
  },
  async listPeriods(filter) {
    return get()
      .periods.filter(
        (p) =>
          (filter.orgId === undefined || p.orgId === filter.orgId) &&
          (filter.meter === undefined || p.meter === filter.meter) &&
          (filter.plan === undefined || p.plan === filter.plan) &&
          (filter.periodStart === undefined || sameInstant(p.periodStart, filter.periodStart)) &&
          (filter.periodStartFrom === undefined || Date.parse(p.periodStart) >= Date.parse(filter.periodStartFrom)) &&
          (filter.periodStartBefore === undefined || Date.parse(p.periodStart) < Date.parse(filter.periodStartBefore)) &&
          (filter.state === undefined || p.state === filter.state),
      )
      .map((p) => structuredClone(p));
  },
  async insertReport(row) {
    const parsed = UsageReportRow.parse(row);
    if (get().reports.some((r) => r.stripeIdentifier === parsed.stripeIdentifier)) return false;
    get().reports.push(parsed);
    await save();
    return true;
  },
  async updateReport(id, patch) {
    const row = get().reports.find((r) => r.id === id);
    if (!row) return;
    row.status = patch.status;
    row.attempts = patch.attempts;
    if (patch.sentAt !== undefined) row.sentAt = patch.sentAt;
    await save();
  },
  async listReports(filter) {
    return get()
      .reports.filter(
        (r) =>
          (filter.orgId === undefined || r.orgId === filter.orgId) &&
          (filter.meter === undefined || r.meter === filter.meter) &&
          (filter.periodStart === undefined || sameInstant(r.periodStart, filter.periodStart)) &&
          (filter.status === undefined || r.status === filter.status),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((r) => structuredClone(r));
  },
  async getNotice(orgId, periodStart, kind) {
    const row = get().notices.find((n) => n.orgId === orgId && sameInstant(n.periodStart, periodStart) && n.kind === kind);
    return row ? structuredClone(row) : undefined;
  },
  async insertNotice(row) {
    const parsed = UsageNoticeRow.parse(row);
    if (get().notices.some((n) => n.orgId === parsed.orgId && sameInstant(n.periodStart, parsed.periodStart) && n.kind === parsed.kind)) return false;
    get().notices.push(parsed);
    await save();
    return true;
  },
  async updateNotice(orgId, periodStart, kind, patch) {
    const row = get().notices.find((n) => n.orgId === orgId && sameInstant(n.periodStart, periodStart) && n.kind === kind);
    if (!row) return;
    if (patch.doneAt !== undefined) row.doneAt = patch.doneAt;
    if (patch.stopAt !== undefined) row.stopAt = patch.stopAt;
    await save();
  },
  async deleteNotice(orgId, periodStart, kind) {
    const state = get();
    state.notices = state.notices.filter((n) => !(n.orgId === orgId && sameInstant(n.periodStart, periodStart) && n.kind === kind));
    await save();
  },
  async listNotices(filter) {
    return get()
      .notices.filter((n) => (filter.orgId === undefined || n.orgId === filter.orgId) && (filter.kind === undefined || n.kind === filter.kind) && (filter.open === undefined || (n.doneAt === undefined) === filter.open))
      .map((n) => structuredClone(n));
  },
  async insertBox(row) {
    const parsed = AppBoxRow.parse(row);
    if (get().boxes.some((b) => b.id === parsed.id)) return;
    get().boxes.push(parsed);
    await save();
  },
  async getBox(id) {
    const row = get().boxes.find((b) => b.id === id);
    return row ? structuredClone(row) : undefined;
  },
  async updateBox(id, patch) {
    const state = get();
    const at = state.boxes.findIndex((b) => b.id === id);
    if (at < 0) return undefined;
    state.boxes[at] = AppBoxRow.parse({ ...state.boxes[at]!, ...patch });
    await save();
    return structuredClone(state.boxes[at]!);
  },
  async listBoxes(orgId, options = {}) {
    return get()
      .boxes.filter((b) => b.orgId === orgId && (options.includeDeleted === true || b.status !== "deleted"))
      .map((b) => structuredClone(b));
  },
  async openBoxInterval(row) {
    const parsed = AppBoxIntervalRow.parse(row);
    if (get().boxIntervals.some((i) => i.boxId === parsed.boxId && i.awakeTo === undefined)) return;
    get().boxIntervals.push(parsed);
    await save();
  },
  async closeBoxInterval(boxId, at) {
    const row = get().boxIntervals.find((i) => i.boxId === boxId && i.awakeTo === undefined);
    if (!row) return false;
    row.awakeTo = at;
    await save();
    return true;
  },
  async listBoxIntervals(orgId, from, to) {
    return get()
      .boxIntervals.filter((i) => i.orgId === orgId && overlaps(i.awakeFrom, i.awakeTo, from, to))
      .map((i) => structuredClone(i));
  },
  async getCap(orgId) {
    const row = get().caps[orgId];
    return row ? structuredClone(row) : undefined;
  },
  async setCap(row) {
    get().caps[row.orgId] = SpendingCapRow.parse(row);
    await save();
  },
});
