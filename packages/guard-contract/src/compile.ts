// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { GUARD_SURFACE_IDS, hasGuardSurfaceBlocks } from "./rules.js";
import { GuardBundle, type GuardBundleContentRule, type GuardBundleServiceDecision, type GuardException, type GuardSettings } from "./bundle.js";
import { type GuardCatalogue, type GuardFlowAction, type GuardService, serviceForFlow } from "./catalogue.js";
import { runDetector, type DetectorMatch } from "./detectors.js";
import { GUARD_PROTOCOL_VERSION, GUARD_SNIPPET_MAX } from "./ids.js";
import type { GuardAudience, GuardContentAction, GuardContentRule, GuardRulesDocument, GuardServiceRule } from "./rules.js";

export interface GuardPerson {
  userId: string;
  email: string;
  groupIds: readonly string[];
}

export interface GuardGrantLike {
  id: string;
  scope: "org" | "user";
  userId?: string | undefined;
  subject: { serviceId: string; ruleId?: string | undefined };
  expiresAt?: string | undefined;
  revokedAt?: string | undefined;
}

const normaliseEmail = (e: string): string => e.trim().toLowerCase();

export const audienceAdmits = (audience: GuardAudience, person: GuardPerson): boolean => {
  switch (audience.kind) {
    case "org":
      return true;
    case "groups":
      return audience.groupIds.some((g) => person.groupIds.includes(g));
    case "people": {
      const me = normaliseEmail(person.email);
      return audience.emails.some((e) => normaliseEmail(e) === me);
    }
  }
};

const audienceSpecificity = (audience: GuardAudience): number => (audience.kind === "people" ? 2 : audience.kind === "groups" ? 1 : 0);

export const exceptionsFor = (grants: readonly GuardGrantLike[], person: Pick<GuardPerson, "userId">, now: Date): GuardException[] =>
  grants
    .filter((g) => g.revokedAt === undefined)
    .filter((g) => g.expiresAt === undefined || new Date(g.expiresAt).getTime() > now.getTime())
    .filter((g) => g.scope === "org" || g.userId === person.userId)
    .map((g) => ({
      grantId: g.id,
      scope: g.scope,
      serviceId: g.subject.serviceId,
      ...(g.subject.ruleId === undefined ? {} : { ruleId: g.subject.ruleId }),
      ...(g.expiresAt === undefined ? {} : { expiresAt: g.expiresAt }),
    }));

export interface CompileInput {
  document: GuardRulesDocument;
  catalogue: GuardCatalogue;
  person: GuardPerson;
  settings: GuardSettings;
  grants: readonly GuardGrantLike[];
  orgId: string;
  deviceId: string;
  now: Date;
}

export const compileGuardBundle = (input: CompileInput): GuardBundle => {
  const { document, catalogue, person, settings } = input;
  const enabled = catalogue.services.filter((s) => s.enabled);

  const applicable: Array<{ rule: GuardServiceRule; index: number }> = document.serviceRules
    .map((rule, index) => ({ rule, index }))
    .filter(({ rule }) => rule.enabled && audienceAdmits(rule.audience, person));
  const services: Record<string, GuardBundleServiceDecision> = {};
  for (const service of enabled) {
    let best: { rule: GuardServiceRule; index: number; score: number } | undefined;
    for (const { rule, index } of applicable) {
      if (rule.serviceId !== "*" && rule.serviceId !== service.serviceId) continue;
      const score = (rule.serviceId === "*" ? 0 : 10) + audienceSpecificity(rule.audience);
      if (best === undefined || score > best.score || (score === best.score && index > best.index)) best = { rule, index, score };
    }
    if (best !== undefined) {
      services[service.serviceId] = { action: best.rule.action, ruleId: best.rule.ruleId, ...(best.rule.note === undefined ? {} : { note: best.rule.note }) };
    } else if (service.defaultAction !== undefined && service.defaultAction !== document.defaultAction) {
      services[service.serviceId] = { action: service.defaultAction };
    }
  }

  const contentRules: GuardBundleContentRule[] = document.contentRules
    .filter((rule) => rule.enabled && audienceAdmits(rule.audience, person))
    .map((rule: GuardContentRule) => ({
      ruleId: rule.ruleId,
      name: rule.name,
      detector: rule.detector,
      services: rule.services === "*" ? ("*" as const) : rule.services.filter((id) => enabled.some((s) => s.serviceId === id)),
      action: rule.action,
      ...(rule.note === undefined ? {} : { note: rule.note }),
    }))
    .filter((rule) => rule.services === "*" || rule.services.length > 0);

  return GuardBundle.parse({
    protocol: GUARD_PROTOCOL_VERSION,
    orgId: input.orgId,
    deviceId: input.deviceId,
    bundleVersion: document.version,
    catalogueVersion: catalogue.version,
    generatedAt: input.now.toISOString(),
    person: { userId: person.userId, email: normaliseEmail(person.email) },
    clientMode: settings.clientMode,
    defaultAction: document.defaultAction,
    services,
    contentRules,
    ...(hasGuardSurfaceBlocks(document.surfaceBlocks) ? { surfaceBlocks: Object.fromEntries(GUARD_SURFACE_IDS.filter((id) => document.surfaceBlocks?.[id] === true).map((id) => [id, true])) } : {}),
    exceptions: exceptionsFor(input.grants, person, input.now),
    settings: {
      requestsEnabled: settings.requestsEnabled,
      unreproducibleTls: settings.clientMode === "enforce" ? "block" : settings.unreproducibleTls,
      workspaceRedirect: { enabled: settings.workspaceRedirect.enabled, ...(settings.workspaceRedirect.url === undefined ? {} : { url: settings.workspaceRedirect.url }) },
      snippetPolicy: settings.snippetPolicy,
      snippetMax: GUARD_SNIPPET_MAX,
    },
  });
};

export interface FlowDecision {
  action: GuardFlowAction;
  source: "rule" | "default" | "exception";
  ruleId?: string | undefined;
  grantId?: string | undefined;
  note?: string | undefined;
}

export const decideFlow = (bundle: GuardBundle, service: Pick<GuardService, "serviceId">): FlowDecision => {
  const exception = bundle.exceptions.find((e) => e.serviceId === service.serviceId && e.ruleId === undefined);
  if (exception !== undefined) return { action: "allow", source: "exception", grantId: exception.grantId };
  const decision = bundle.services[service.serviceId];
  if (decision !== undefined) {
    return {
      action: decision.action,
      source: decision.ruleId === undefined ? "default" : "rule",
      ...(decision.ruleId === undefined ? {} : { ruleId: decision.ruleId }),
      ...(decision.note === undefined ? {} : { note: decision.note }),
    };
  }
  return { action: bundle.defaultAction, source: "default" };
};

export interface ContentMatch {
  rule: GuardBundleContentRule;
  match: DetectorMatch;
  excepted: boolean;
  grantId?: string | undefined;
}

export interface ContentDecision {
  action: GuardContentAction;
  matches: ContentMatch[];
  decidedBy?: GuardBundleContentRule | undefined;
}

const CONTENT_RANK: Record<GuardContentAction, number> = { allow: 0, ask: 1, block: 2 };

export const decideContent = (
  bundle: GuardBundle,
  service: Pick<GuardService, "serviceId">,
  input: { text?: string | undefined; filenames?: readonly string[] | undefined },
): ContentDecision => {
  const matches: ContentMatch[] = [];
  for (const rule of bundle.contentRules) {
    if (rule.services !== "*" && !rule.services.includes(service.serviceId)) continue;
    const match = runDetector(rule.detector, input);
    if (match === undefined) continue;
    const exception = bundle.exceptions.find((e) => e.serviceId === service.serviceId && e.ruleId === rule.ruleId);
    matches.push({ rule, match, excepted: exception !== undefined, grantId: exception?.grantId });
  }
  let action: GuardContentAction = "allow";
  let decidedBy: GuardBundleContentRule | undefined;
  for (const m of matches) {
    if (m.excepted) continue;
    if (CONTENT_RANK[m.rule.action] > CONTENT_RANK[action]) {
      action = m.rule.action;
      decidedBy = m.rule;
    }
  }
  return { action, matches, decidedBy };
};

export interface GuardVerdict {
  intercepted: boolean;
  service?: GuardService | undefined;
  flow?: FlowDecision | undefined;
  content?: ContentDecision | undefined;
  verdict: "allowed" | "blocked" | "asked" | "not-intercepted";
  enforced: boolean;
}

export const decideRequest = (
  bundle: GuardBundle,
  catalogue: GuardCatalogue,
  request: { host: string; bundleId?: string | undefined; cliName?: string | undefined; text?: string | undefined; filenames?: readonly string[] | undefined },
): GuardVerdict => {
  const service = serviceForFlow(catalogue, request);
  const enforced = bundle.clientMode === "enforce";
  if (service === undefined) return { intercepted: false, verdict: "not-intercepted", enforced };
  const flow = decideFlow(bundle, service);
  if (flow.action !== "allow") return { intercepted: true, service, flow, verdict: flow.action === "block" ? "blocked" : "asked", enforced };
  const content = decideContent(bundle, service, request);
  const verdict = content.action === "block" ? "blocked" : content.action === "ask" ? "asked" : "allowed";
  return { intercepted: true, service, flow, content, verdict, enforced };
};
