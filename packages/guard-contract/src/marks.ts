// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { GUARD_MARKS, GUARD_MARK_INDEX } from "./marks.generated.js";
import type { GuardMark } from "./marks-spec.js";

export type { GuardMark, GuardMarkHandling, GuardMarkIndex, GuardMarkSource, GuardMarkSpec } from "./marks-spec.js";

export type GuardMarkGlyph = "service" | "app" | "cli";

export type GuardMarkLookup = { mark: GuardMark; glyph?: undefined } | { mark?: undefined; glyph: GuardMarkGlyph };

export const guardMark = (markId: string | undefined): GuardMark | undefined => (markId === undefined || markId === "" ? undefined : GUARD_MARKS[markId]);

export const markForService = (service: { serviceId?: string | undefined; markId?: string | undefined } | undefined): GuardMarkLookup => {
  const mark = guardMark(service?.markId) ?? guardMark(service?.serviceId === undefined ? undefined : GUARD_MARK_INDEX.byService[service.serviceId]);
  return mark === undefined ? { glyph: "service" } : { mark };
};

const cliCandidates = (token: string): string[] => {
  const t = token.toLowerCase();
  return [t, t.replace(/-cli$/, ""), t.replace(/_cli_rs$/, ""), t.replace(/_cli$/, ""), t.replace(/-code$/, "")];
};

export const markForApp = (app: { bundleId?: string | undefined; name?: string | undefined; cli?: string | undefined } | undefined): GuardMarkLookup => {
  if (app === undefined) return { glyph: "app" };
  const ix = GUARD_MARK_INDEX;
  const hits: Array<string | undefined> = [
    app.bundleId === undefined ? undefined : ix.byBundleId[app.bundleId],
    app.name === undefined ? undefined : ix.byName[app.name.toLowerCase()],
    app.cli === undefined ? undefined : ix.byCli[app.cli],
    ...(app.name === undefined ? [] : cliCandidates(app.name).map((c) => ix.byCli[c])),
  ];
  for (const id of hits) {
    if (id === undefined) continue;
    const mark = guardMark(id);
    return mark === undefined ? { glyph: "cli" } : { mark };
  }
  return { glyph: app.cli !== undefined || (app.bundleId === undefined && app.name !== undefined && /^[a-z0-9._-]+$/.test(app.name)) ? "cli" : "app" };
};

export const markMarkup = (svg: string, instance: string): string => svg.replaceAll("gmid_", `${instance.replace(/[^A-Za-z0-9_-]/g, "")}_`);

export { GUARD_MARKS, GUARD_MARK_INDEX };
