// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { redactMatch } from "./events.js";
import { GUARD_SECRET_RULE_IDS, type GuardDetector, type GuardDetectorKind, type GuardSecretRuleId } from "./rules.js";

export interface DetectorMatch {
  kind: GuardDetectorKind;
  count: number;
  examples: string[];
  details?: string[];
}

const digitsOf = (s: string): number[] => s.replace(/\D/g, "").split("").map((c) => Number(c));

const TFN_WEIGHTS = [1, 4, 3, 7, 5, 8, 6, 9, 10];
export const isValidTfn = (candidate: string): boolean => {
  const d = digitsOf(candidate);
  if (d.length !== 9) return false;
  const sum = d.reduce((acc, digit, i) => acc + digit * (TFN_WEIGHTS[i] ?? 0), 0);
  return sum % 11 === 0;
};
const TFN_RE = /(?<![0-9A-Za-z_+-])(\d{3})[ -]?(\d{3})[ -]?(\d{3})(?![0-9A-Za-z_-])/g;
const tfnGrouped = (m: string): boolean => m.length === 11 && m[3] === " " && m[7] === " ";

const ABN_WEIGHTS = [10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19];
export const isValidAbn = (candidate: string): boolean => {
  const d = digitsOf(candidate);
  if (d.length !== 11) return false;
  const adjusted = [(d[0] ?? 0) - 1, ...d.slice(1)];
  const sum = adjusted.reduce((acc, digit, i) => acc + digit * (ABN_WEIGHTS[i] ?? 0), 0);
  return sum % 89 === 0;
};
const ABN_RE = /(?<![0-9A-Za-z_+-])(\d{2})[ -]?(\d{3})[ -]?(\d{3})[ -]?(\d{3})(?![0-9A-Za-z_-])/g;

const ACN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 1];
export const isValidAcn = (candidate: string): boolean => {
  const d = digitsOf(candidate);
  if (d.length !== 9) return false;
  const sum = d.slice(0, 8).reduce((acc, digit, i) => acc + digit * (ACN_WEIGHTS[i] ?? 0), 0);
  return (10 - (sum % 10)) % 10 === d[8];
};
const ACN_RE = TFN_RE;

const MEDICARE_WEIGHTS = [1, 3, 7, 9, 1, 3, 7, 9];
export const isValidMedicare = (candidate: string): boolean => {
  const d = digitsOf(candidate);
  if (d.length !== 10 && d.length !== 11) return false;
  const first = d[0] ?? 0;
  if (first < 2 || first > 6) return false;
  const sum = d.slice(0, 8).reduce((acc, digit, i) => acc + digit * (MEDICARE_WEIGHTS[i] ?? 0), 0);
  return sum % 10 === d[8];
};
const medicareGrouped = (m: string): boolean => /^\d{4}[ -]\d{5}[ -]\d(?:[ -]\d)?$/.test(m);
const MEDICARE_RE = /(?<![0-9A-Za-z_+-])([2-6]\d{3})[ -]?(\d{5})[ -]?(\d)(?:[ -]?(\d))?(?![0-9A-Za-z_-])/g;

export const isValidLuhn = (candidate: string): boolean => {
  const d = digitsOf(candidate);
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let double = false;
  for (let i = d.length - 1; i >= 0; i -= 1) {
    let digit = d[i] ?? 0;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
};
const CARD_RE = /(?<![0-9A-Za-z_-])(?:\d[ -]?){12,18}\d(?![0-9A-Za-z_-])/g;
export const iinAllows = (d: readonly number[]): boolean => {
  const n = d.length;
  const p = (k: number): number => d.slice(0, k).reduce((a, x) => a * 10 + x, 0);
  const [p1, p2, p3, p4] = [p(1), p(2), p(3), p(4)];
  const within = (x: number, lo: number, hi: number): boolean => x >= lo && x <= hi;
  switch (p1) {
    case 4:
      return n === 13 || n === 16 || n === 19;
    case 5:
      return (within(p2, 51, 55) && n === 16) || ([5018, 5020, 5038, 5893].includes(p4) && within(n, 12, 19));
    case 2:
      return (within(p4, 2221, 2720) && n === 16) || (within(p4, 2200, 2204) && within(n, 16, 19));
    case 3:
      return ((p2 === 34 || p2 === 37) && n === 15) || (within(p4, 3528, 3589) && within(n, 16, 19)) || ((within(p3, 300, 305) || [36, 38, 39].includes(p2)) && within(n, 14, 19));
    case 6:
      return ((p4 === 6011 || within(p3, 644, 649) || p2 === 65) && within(n, 16, 19)) || (p2 === 62 && within(n, 16, 19)) || ([6304, 6759, 6761, 6762, 6763].includes(p4) && within(n, 12, 19));
    default:
      return false;
  }
};
export const isValidCard = (candidate: string): boolean => isValidLuhn(candidate) && iinAllows(digitsOf(candidate));

export const SECRET_PATTERNS: ReadonlyArray<{ id: GuardSecretRuleId; re: RegExp; label: string }> = [
  { id: "aws-access-token", re: /\b(?:A3T[A-Z0-9]|AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g, label: "an AWS access key id" },
  { id: "github-pat", re: /\bghp_[0-9A-Za-z]{36}\b/g, label: "a GitHub personal access token" },
  { id: "github-fine-grained-pat", re: /\bgithub_pat_[0-9A-Za-z_]{82}\b/g, label: "a GitHub fine-grained token" },
  { id: "github-app-token", re: /\b(?:ghu|ghs|gho|ghr)_[0-9A-Za-z]{36}\b/g, label: "a GitHub app or OAuth token" },
  { id: "openai-api-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}\b/g, label: "an OpenAI API key" },
  { id: "anthropic-api-key", re: /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{80,}/g, label: "an Anthropic API key" },
  { id: "slack-token", re: /\bxox[baprs]-[0-9]{10,13}-[0-9A-Za-z-]{10,}/g, label: "a Slack token" },
  { id: "stripe-access-token", re: /\b(?:sk|rk)_(?:test|live|prod)_[0-9A-Za-z]{10,99}\b/g, label: "a Stripe key" },
  { id: "gcp-api-key", re: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, label: "a Google API key" },
  { id: "gcp-oauth-token", re: /\bya29\.[0-9A-Za-z_-]{20,}/g, label: "a Google OAuth access token" },
  { id: "gcp-client-secret", re: /\bGOCSPX-[0-9A-Za-z_-]{28}/g, label: "a Google OAuth client secret" },
  { id: "slack-webhook-url", re: /hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9+/]{43,56}/g, label: "a Slack webhook URL" },
  { id: "private-key", re: /-----BEGIN[ \t\r\n]+(?:(?:RSA|EC|DSA|OPENSSH|PGP|ENCRYPTED)[ \t\r\n]+)?PRIVATE[ \t\r\n]+KEY(?:[ \t\r\n]+BLOCK)?-----/g, label: "a private key" },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, label: "a JSON web token" },
  { id: "sendgrid-api-token", re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g, label: "a SendGrid key" },
];

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const SPELLED_AT_RE = /[ \t]*[[({][ \t]*at[ \t]*[\])}][ \t]*/gi;
const SPELLED_DOT_RE = /[ \t]*[[({][ \t]*dot[ \t]*[\])}][ \t]*/gi;
const unspell = (s: string): string => s.replace(SPELLED_AT_RE, "@").replace(SPELLED_DOT_RE, ".");

const PHONE_RE =
  /(?<![0-9A-Za-z+])(?:(?:(?:\+|00)61[ .\-]?|61[ .\-]?|0)4[0-9]{2}[ .\-]?[0-9]{3}[ .\-]?[0-9]{3}|(?:\(0[2378]\)[ .\-]?|0[2378][ .\-]?|(?:\+|00)61[ .\-]?\(?[2378]\)?[ .\-]?)[0-9]{4}[ .\-]?[0-9]{4}|1[38]00[ .\-]?[0-9]{3}[ .\-]?[0-9]{3})(?![0-9])/g;
const phoneSpans = (text: string): Array<[number, number]> => {
  PHONE_RE.lastIndex = 0;
  return [...text.matchAll(PHONE_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length]);
};
const canonicalPhone = (s: string): string => {
  const d = s.replace(/\D/g, "");
  if (d.startsWith("0061")) return `0${d.slice(4)}`;
  if (d.length === 11 && d.startsWith("61")) return `0${d.slice(2)}`;
  return d;
};

export interface PreparedText {
  primary: string;
  primaries: string[];
  labels: string[];
  decodedLabels: string[];
  collapsedLabels: string[];
  decoded: string[];
  joined: string[];
  collapsed: string[];
}
const PERCENT_RUN_RE = /(?:%[0-9A-Fa-f]{2})+/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const BASE64_RUN_RE = /[A-Za-z0-9+/]{24,}={0,2}/g;
const DIGIT_GAP_RE = /(?<=[0-9])(?:[ .-]{1,3}|[ \t]*\r?\n[ \t]*)(?=[0-9])/g;
const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const utf8 = (bytes: number[]): string | undefined => {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
};
const percentDecode = (s: string): string =>
  s.includes("%")
    ? s.replace(PERCENT_RUN_RE, (run) => {
        const bytes: number[] = [];
        for (let i = 0; i + 2 < run.length; i += 3) bytes.push(parseInt(run.slice(i + 1, i + 3), 16));
        return utf8(bytes) ?? run;
      })
    : s;
export const normaliseText = (s: string): string => percentDecode(s).replace(ZERO_WIDTH_RE, "").normalize("NFKC");
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const decodeBase64 = (run: string): string | undefined => {
  let body = run.replace(/=+$/, "");
  if (body.length % 4 === 1) body = body.slice(0, -1);
  const bytes: number[] = [];
  let buf = 0;
  let bits = 0;
  for (const c of body) {
    buf = ((buf << 6) | B64_ALPHABET.indexOf(c)) & 0xffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buf >> bits) & 0xff);
    }
  }
  const t = utf8(bytes);
  return t !== undefined && t.length > 0 && !CONTROL_RE.test(t) ? t : undefined;
};
const collapseDigits = (s: string): string => s.replace(DIGIT_GAP_RE, "");
const isTokenChar = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z0-9_-]$/.test(c);
const unwrapLines = (s: string, parity: 0 | 1): string => {
  const lines = s.split("\n");
  const bare = (l: string): string => (l.endsWith("\r") ? l.slice(0, -1) : l);
  let out = lines[0] ?? "";
  let chain: number | undefined;
  for (let i = 1; i < lines.length; i += 1) {
    const prev = bare(lines[i - 1] ?? "");
    const line = lines[i] ?? "";
    const removable = isTokenChar(Array.from(prev).at(-1)) && isTokenChar(line[0]);
    if (!removable) chain = undefined;
    else if (chain !== undefined && prev.length > 0 && Array.from(prev).every(isTokenChar)) chain += 1;
    else chain = 0;
    if (chain !== undefined && chain % 2 === parity) {
      if (out.endsWith("\r")) out = out.slice(0, -1);
    } else out += "\n";
    out += line;
  }
  return out;
};
export interface DetectorSpan { text: string; label?: string | undefined }
export const prepareText = (text: string, joined: readonly string[] = [], spans?: readonly DetectorSpan[]): PreparedText => {
  const source = spans ?? [{ text }];
  const primaries = source.map((span) => normaliseText(span.text));
  const labels = source.map((span) => span.label ?? "");
  const decoded: string[] = [], decodedLabels: string[] = [];
  primaries.forEach((primary, i) => {
    BASE64_RUN_RE.lastIndex = 0;
    for (const m of primary.matchAll(BASE64_RUN_RE)) {
      const value = decodeBase64(m[0]);
      if (value !== undefined) { decoded.push(normaliseText(value)); decodedLabels.push(labels[i] ?? ""); }
    }
  });
  const j = joined.map(normaliseText);
  const collapsed: string[] = [], collapsedLabels: string[] = [];
  const views = [...primaries, ...decoded, ...j], viewLabels = [...labels, ...decodedLabels, ...j.map(() => "")];
  views.forEach((v, i) => { const c = collapseDigits(v); if (c !== v) { collapsed.push(c); collapsedLabels.push(viewLabels[i] ?? ""); } });
  return { primary: primaries[0] ?? "", primaries, labels, decoded, decodedLabels, joined: j, collapsed, collapsedLabels };
};

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const collect = (text: string, re: RegExp, valid: (m: string) => boolean): string[] => {
  const found: string[] = [];
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) if (valid(m[0])) found.push(m[0]);
  return found;
};

export const GUARD_CONTEXT_WINDOW = 60;
const TFN_CONTEXT_RE = /(?:\b|_)(?:tfn|tax[\s_-]*file)/i;
const ACN_CONTEXT_RE = /(?:\b|_)(?:acn|company[\s_-]*number)/i;
const ABN_CONTEXT_RE = /(?:\b|_)(?:abn|business[\s_-]*number)/i;
const MEDICARE_CONTEXT_RE = /(?:\b|_)medicare/i;
const CARD_CONTEXT_RE = /(?:\b|_)(?:credit|card|visa|master\s*card|cc|amex|american\s+express|discover|jcb|diners|maestro|unionpay)(?:\b|_)/i;
const CARD_EXCLUDE_RE = /(?:^|[^0-9a-z])(?:con[\s-]?note|consignment|waybill|air[\s-]?waybill|awb|sscc|pallet|parcel|shipment|tracking|imei|serial|s\/n)(?:[\s_-]*(?:no\.?|number|num|id|code|#))?\s*[:#=.-]?\s*$/i;

const nearContext = (text: string, start: number, end: number, context: RegExp): boolean => {
  const before = Array.from(text.slice(0, start)).slice(-GUARD_CONTEXT_WINDOW).join("");
  const after = Array.from(text.slice(end)).slice(0, GUARD_CONTEXT_WINDOW).join("");
  return context.test(before) || context.test(after);
};

interface NumberRule {
  re: RegExp;
  valid: (m: string) => boolean;
  context: RegExp;
  requireContext: boolean;
  grouped?: (m: string) => boolean;
  phoneGuard: boolean;
  exclude?: RegExp;
  publicTelemetryDSN?: boolean;
  spansGroups?: boolean;
}
export const GUARD_LABEL_WINDOW = 40;
const labelledAs = (text: string, start: number, label: RegExp): boolean =>
  label.test(Array.from(text.slice(0, start)).slice(-GUARD_LABEL_WINDOW).join(""));
const digitKey = (s: string): string => s.replace(/\D/g, "");
const numericFragment = (s: string, a: number, b: number): boolean =>
  a > 1 && s[a - 1] === "." && /[0-9]/.test(s[a - 2]!) || b + 1 < s.length && s[b] === "." && /[0-9]/.test(s[b + 1]!);
const groupedFragment = (s: string, a: number, b: number): boolean =>
  /(?:^|[^0-9])[0-9]{1,2}[ -]$/.test(s.slice(Math.max(0, a - 4), a)) || /^[ -][0-9]{1,2}(?:[^0-9]|$)/.test(s.slice(b, b + 4));
const publicSentryDSN = (s: string): boolean => {
  if (!/^https:\/\/[0-9a-f]{32}@[a-z0-9.-]+\.sentry\.io\/[0-9]+$/i.test(s)) return false;
  try {
    const u = new URL(s);
    return u.protocol === "https:" && /^[0-9a-f]{32}$/i.test(u.username) && u.password === "" && u.hostname.endsWith(".sentry.io") && u.port === "" && u.search === "" && u.hash === "" && /^\/[0-9]+$/.test(u.pathname);
  } catch { return false; }
};
const numberMatches = (p: PreparedText, rule: NumberRule): string[] => {
  const out: string[] = [];
  const seen = new Set<string>();
  const labels = [...p.labels, ...p.decodedLabels];
  [...p.primaries, ...p.decoded].forEach((view, i) => {
    const label = labels[i] ?? "";
    if (rule.publicTelemetryDSN && label === "dsn" && publicSentryDSN(view)) return;
    const phones = rule.phoneGuard ? phoneSpans(view) : [];
    rule.re.lastIndex = 0;
    for (const m of view.matchAll(rule.re)) {
      if (!rule.valid(m[0])) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (numericFragment(view, start, end) || (!rule.spansGroups && groupedFragment(view, start, end))) continue;
      const ctx = nearContext(view, start, end, rule.context) || rule.context.test(label);
      if (rule.requireContext && !ctx && !(rule.grouped?.(m[0]) ?? false)) continue;
      if (!ctx && phones.some(([a, b]) => a < end && start < b)) continue;
      if (!ctx && rule.exclude && (labelledAs(view, start, rule.exclude) || rule.exclude.test(label))) continue;
      const key = digitKey(m[0]);
      if (i >= p.primaries.length && seen.has(key)) continue;
      seen.add(key);
      out.push(m[0]);
    }
  });
  for (const [i, view] of [...p.joined, ...p.collapsed].entries()) {
    const label = i < p.joined.length ? "" : p.collapsedLabels[i - p.joined.length] ?? "";
    rule.re.lastIndex = 0;
    for (const m of view.matchAll(rule.re)) {
      const start = m.index ?? 0;
      if (numericFragment(view, start, start + m[0].length)) continue;
      if (!rule.valid(m[0]) || !(nearContext(view, start, start + m[0].length, rule.context) || rule.context.test(label))) continue;
      const key = digitKey(m[0]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m[0]);
    }
  }
  return out;
};

const secretKey = (id: string, m: string): string => `${id}\u0000${Array.from(m.replace(/\s/g, "")).slice(0, 16).join("")}`;
const secretViews = (p: PreparedText): string[] => {
  const base = [...p.primaries, ...p.decoded, ...p.joined];
  return [...base, ...base.flatMap((v) => ([0, 1] as const).map((parity) => [v, unwrapLines(v, parity)] as const)).filter(([v, u]) => u !== v).map(([, u]) => u)];
};

const examplesOf = (matches: string[]): string[] => [...new Set(matches.map(redactMatch))].slice(0, 3);

export interface DetectorInput {
  text?: string | undefined;
  spans?: readonly DetectorSpan[] | undefined;
  filenames?: readonly string[] | undefined;
  joined?: readonly string[] | undefined;
}

export const runDetector = (detector: GuardDetector, input: DetectorInput, prepared?: PreparedText): DetectorMatch | undefined => {
  const text = input.text ?? "";
  let cache = prepared;
  const p = (): PreparedText => (cache ??= prepareText(text, input.joined ?? [], input.spans));
  const numbers = (kind: GuardDetectorKind, rule: NumberRule): DetectorMatch | undefined => {
    const m = numberMatches(p(), rule);
    return m.length === 0 ? undefined : { kind, count: m.length, examples: examplesOf(m) };
  };
  switch (detector.kind) {
    case "au-tfn":
      return numbers("au-tfn", { re: TFN_RE, valid: isValidTfn, context: TFN_CONTEXT_RE, requireContext: detector.requireContext ?? false, grouped: tfnGrouped, phoneGuard: true });
    case "au-abn":
      return numbers("au-abn", { re: ABN_RE, valid: isValidAbn, context: ABN_CONTEXT_RE, requireContext: false, phoneGuard: false });
    case "au-acn":
      return numbers("au-acn", { re: ACN_RE, valid: isValidAcn, context: ACN_CONTEXT_RE, requireContext: detector.requireContext ?? false, grouped: tfnGrouped, phoneGuard: true });
    case "au-medicare":
      return numbers("au-medicare", { re: MEDICARE_RE, valid: isValidMedicare, context: MEDICARE_CONTEXT_RE, requireContext: detector.requireContext ?? false, grouped: medicareGrouped, phoneGuard: true });
    case "card-number":
      return numbers("card-number", { re: CARD_RE, valid: isValidCard, context: CARD_CONTEXT_RE, requireContext: false, phoneGuard: false, exclude: CARD_EXCLUDE_RE, publicTelemetryDSN: true, spansGroups: true });
    case "secret": {
      const wanted = new Set<GuardSecretRuleId>(detector.rules === undefined || detector.rules.length === 0 ? GUARD_SECRET_RULE_IDS : detector.rules);
      const views = secretViews(p());
      const fired: string[] = [];
      const examples: string[] = [];
      let count = 0;
      for (const pat of SECRET_PATTERNS) {
        if (!wanted.has(pat.id)) continue;
        const seen = new Set<string>();
        const m: string[] = [];
        views.forEach((view, i) => {
          for (const hit of collect(view, pat.re, () => true)) {
            const key = secretKey(pat.id, hit);
            if (i >= p().primaries.length && seen.has(key)) continue;
            seen.add(key);
            m.push(hit);
          }
        });
        if (m.length === 0) continue;
        count += m.length;
        fired.push(pat.id);
        if (examples.length < 3) examples.push(`${pat.label} (${Array.from(m[0] ?? "").slice(0, 6).join("")}…)`);
      }
      return count === 0 ? undefined : { kind: "secret", count, examples, details: fired };
    }
    case "identifiers":
      return undefined;
    case "email-bulk": {
      const distinct = new Set<string>();
      for (const view of [...p().primaries, ...p().decoded]) {
        for (const e of collect(view, EMAIL_RE, () => true)) distinct.add(e.toLowerCase());
        const plain = unspell(view);
        if (plain !== view) for (const e of collect(plain, EMAIL_RE, () => true)) distinct.add(e.toLowerCase());
      }
      if (distinct.size < detector.threshold) return undefined;
      return { kind: "email-bulk", count: distinct.size, examples: [`${distinct.size} distinct addresses`] };
    }
    case "phone-bulk": {
      const distinct = new Set<string>();
      for (const view of [...p().primaries, ...p().decoded]) for (const n of collect(view, PHONE_RE, () => true)) distinct.add(canonicalPhone(n));
      if (distinct.size < detector.threshold) return undefined;
      return { kind: "phone-bulk", count: distinct.size, examples: [`${distinct.size} distinct numbers`] };
    }
    case "keyword": {
      const hits: string[] = [];
      const lowers = (input.spans ?? [{ text }]).map((span) => span.text.toLowerCase());
      for (const k of detector.keywords) {
        const needle = k.toLowerCase();
        for (const lower of lowers) {
          if (detector.wholeWord) {
            const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`, "gu");
            const n = (lower.match(re) ?? []).length;
            for (let i = 0; i < n; i += 1) hits.push(k);
          } else {
            let from = 0;
            for (;;) {
              const at = lower.indexOf(needle, from);
              if (at < 0) break;
              hits.push(k);
              from = at + needle.length;
            }
          }
        }
      }
      return hits.length === 0 ? undefined : { kind: "keyword", count: hits.length, examples: [...new Set(hits)].slice(0, 3), details: [...new Set(hits)] };
    }
    case "file-type": {
      const wanted = new Set(detector.extensions);
      const hit = (input.filenames ?? []).filter((f) => {
        const dot = f.lastIndexOf(".");
        return dot > 0 && wanted.has(f.slice(dot + 1).toLowerCase());
      });
      if (hit.length === 0) return undefined;
      const exts = [...new Set(hit.map((f) => f.slice(f.lastIndexOf(".") + 1).toLowerCase()))];
      return { kind: "file-type", count: hit.length, examples: exts.slice(0, 3).map((e) => `.${e}`), details: exts };
    }
  }
};

export const runDetectors = (detectors: readonly GuardDetector[], input: DetectorInput): DetectorMatch[] => {
  let prepared: PreparedText | undefined;
  return detectors
    .map((d) => runDetector(d, input, d.kind === "keyword" || d.kind === "file-type" ? undefined : (prepared ??= prepareText(input.text ?? "", input.joined ?? [], input.spans))))
    .filter((m): m is DetectorMatch => m !== undefined);
};
