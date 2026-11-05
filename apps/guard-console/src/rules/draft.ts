import {
  GUARD_STARTER_CONTENT_RULES,
  GuardDetector,
  GuardRulesUpdate,
  type GuardAudience,
  type GuardContentAction,
  type GuardFlowAction,
  type GuardRulesDocument,
  type GuardSurfaceBlocks,
} from "@vibtra/guard-contract";

export interface DraftServiceRule {
  key: string;
  ruleId?: string;
  serviceId: string;
  audience: GuardAudience;
  action: GuardFlowAction;
  enabled: boolean;
  note?: string;
}

export interface DraftContentRule {
  key: string;
  ruleId?: string;
  name: string;
  detector: GuardDetector;
  services: "*" | string[];
  audience: GuardAudience;
  action: GuardContentAction;
  enabled: boolean;
  note?: string;
}

export interface Draft {
  defaultAction: GuardFlowAction;
  surfaceBlocks?: GuardSurfaceBlocks;
  serviceRules: DraftServiceRule[];
  contentRules: DraftContentRule[];
}

let counter = 0;
export const newKey = (prefix: string): string => {
  counter += 1;
  return `${prefix}-new-${counter}`;
};

export const draftOf = (document: GuardRulesDocument): Draft => ({
  defaultAction: document.defaultAction,
  ...(document.surfaceBlocks === undefined ? {} : { surfaceBlocks: { ...document.surfaceBlocks } }),
  serviceRules: document.serviceRules.map((r) => ({
    key: r.ruleId,
    ruleId: r.ruleId,
    serviceId: r.serviceId,
    audience: r.audience,
    action: r.action,
    enabled: r.enabled,
    ...(r.note === undefined ? {} : { note: r.note }),
  })),
  contentRules: document.contentRules.map((r) => ({
    key: r.ruleId,
    ruleId: r.ruleId,
    name: r.name,
    detector: r.detector,
    services: r.services === "*" ? "*" : [...r.services],
    audience: r.audience,
    action: r.action,
    enabled: r.enabled,
    ...(r.note === undefined ? {} : { note: r.note }),
  })),
});

const withoutKey = <T extends { key: string }>(row: T): Omit<T, "key"> => {
  const { key: _key, ...rest } = row;
  return rest;
};

export const updateOf = (baseVersion: number, draft: Draft) =>
  GuardRulesUpdate.safeParse({
    baseVersion,
    document: {
      defaultAction: draft.defaultAction,
      ...(draft.surfaceBlocks === undefined ? {} : { surfaceBlocks: draft.surfaceBlocks }),
      serviceRules: draft.serviceRules.map(withoutKey),
      contentRules: draft.contentRules.map(withoutKey),
    },
  });

export const sameDraft = (a: Draft, b: Draft): boolean => {
  const strip = (d: Draft) => JSON.stringify({ defaultAction: d.defaultAction, surfaceBlocks: d.surfaceBlocks, serviceRules: d.serviceRules.map(withoutKey), contentRules: d.contentRules.map(withoutKey) });
  return strip(a) === strip(b);
};

export const startersFor = (draft: Draft): DraftContentRule[] => {
  const have = new Set(draft.contentRules.map((r) => r.name.toLowerCase()));
  return GUARD_STARTER_CONTENT_RULES.filter((s) => !have.has(s.name.toLowerCase())).map((s) => ({
    key: newKey("gcr"),
    name: s.name,
    detector: GuardDetector.parse(s.detector),
    services: "*",
    audience: { kind: "org" },
    action: s.action,
    enabled: true,
    ...(s.note === undefined ? {} : { note: s.note }),
  }));
};

export const emailLooksRight = (email: string): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

export const emailsOf = (text: string): string[] => [...new Set(text.split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter((e) => e !== ""))];

export type ServiceStatus = GuardFlowAction | "off";

export interface ExceptionDraft {
  key: string;
  ruleId?: string;
  who: string;
  emails: string;
  action: GuardFlowAction;
  enabled: boolean;
  note?: string;
}

export interface ServiceSheetDraft {
  serviceId: string;
  base?: { key: string; ruleId?: string; action: GuardFlowAction; enabled: boolean; note?: string };
  exceptions: ExceptionDraft[];
  note: string;
}

export const statusOf = (row: { action: GuardFlowAction; enabled: boolean }): ServiceStatus => (row.enabled ? row.action : "off");

export const ruledServices = (draft: Draft): string[] => {
  const ids = [...new Set(draft.serviceRules.map((r) => r.serviceId))];
  return [...ids.filter((id) => id === "*"), ...ids.filter((id) => id !== "*")];
};

export const baseRuleOf = (draft: Draft, serviceId: string): DraftServiceRule | undefined =>
  draft.serviceRules.filter((r) => r.serviceId === serviceId && r.audience.kind === "org").at(-1);

export const serviceSheetOf = (draft: Draft, serviceId: string): ServiceSheetDraft => {
  const rows = draft.serviceRules.filter((r) => r.serviceId === serviceId);
  const base = baseRuleOf(draft, serviceId);
  const exceptions: ExceptionDraft[] = [];
  for (const r of rows) {
    if (r === base) continue;
    const common = { action: r.action, enabled: r.enabled, ...(r.note === undefined ? {} : { note: r.note }) };
    if (r.audience.kind === "groups") {
      r.audience.groupIds.forEach((id, i) =>
        exceptions.push({ key: i === 0 ? r.key : `${r.key}-${i}`, ...(i === 0 && r.ruleId !== undefined ? { ruleId: r.ruleId } : {}), who: `group:${id}`, emails: "", ...common }),
      );
    } else if (r.audience.kind === "people") {
      exceptions.push({ key: r.key, ...(r.ruleId === undefined ? {} : { ruleId: r.ruleId }), who: "people", emails: r.audience.emails.join("\n"), ...common });
    } else {
      exceptions.push({ key: r.key, ...(r.ruleId === undefined ? {} : { ruleId: r.ruleId }), who: "org", emails: "", ...common });
    }
  }
  return {
    serviceId,
    ...(base === undefined
      ? {}
      : { base: { key: base.key, ...(base.ruleId === undefined ? {} : { ruleId: base.ruleId }), action: base.action, enabled: base.enabled, ...(base.note === undefined ? {} : { note: base.note }) } }),
    exceptions,
    note: base?.note ?? rows.find((r) => r.note !== undefined)?.note ?? "",
  };
};

export const rulesOfServiceSheet = (
  sheet: ServiceSheetDraft,
  noteChanged: boolean,
): { rules: DraftServiceRule[] } | { problem: string; index: number } => {
  const note = sheet.note.trim();
  const noteFor = (own: string | undefined) => {
    const value = noteChanged ? note : (own ?? "");
    return value === "" ? {} : { note: value };
  };
  const rules: DraftServiceRule[] = [];
  if (sheet.base !== undefined) {
    rules.push({ key: sheet.base.key, ...(sheet.base.ruleId === undefined ? {} : { ruleId: sheet.base.ruleId }), serviceId: sheet.serviceId, audience: { kind: "org" }, action: sheet.base.action, enabled: sheet.base.enabled, ...noteFor(sheet.base.note) });
  }
  for (const [index, x] of sheet.exceptions.entries()) {
    let audience: GuardAudience;
    if (x.who === "") return { problem: "Pick a group for each exception, or remove the empty one.", index };
    if (x.who === "org") audience = { kind: "org" };
    else if (x.who.startsWith("group:")) audience = { kind: "groups", groupIds: [x.who.slice("group:".length)] };
    else {
      const emails = emailsOf(x.emails);
      if (emails.length === 0) return { problem: "Name at least one person by email address.", index };
      const wrong = emails.filter((e) => !emailLooksRight(e));
      if (wrong.length > 0) return { problem: `Not an email address: ${wrong.join(", ")}`, index };
      audience = { kind: "people", emails };
    }
    rules.push({ key: x.key, ...(x.ruleId === undefined ? {} : { ruleId: x.ruleId }), serviceId: sheet.serviceId, audience, action: x.action, enabled: x.enabled, ...noteFor(x.note) });
  }
  return { rules };
};

export const withServiceRules = (draft: Draft, serviceId: string, rules: DraftServiceRule[]): Draft => {
  const at = draft.serviceRules.findIndex((r) => r.serviceId === serviceId);
  const rest = draft.serviceRules.filter((r) => r.serviceId !== serviceId);
  const index = at === -1 ? rest.length : draft.serviceRules.slice(0, at).filter((r) => r.serviceId !== serviceId).length;
  return { ...draft, serviceRules: [...rest.slice(0, index), ...rules, ...rest.slice(index)] };
};
