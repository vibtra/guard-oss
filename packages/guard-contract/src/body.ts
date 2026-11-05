// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import type { DetectorInput, DetectorSpan } from "./detectors.js";

export interface ExtractedBody extends DetectorInput {
  text: string;
  spans: DetectorSpan[];
  filenames: string[];
  joined: string[];
}
const essenceOf = (ct: string | null | undefined): string => (ct ?? "").toLowerCase().split(";")[0]!.trim();
export const inspectableBody = (ct: string | null | undefined): boolean => {
  const e = essenceOf(ct);
  return e === "" || e === "application/json" || e.endsWith("+json") || e === "application/x-www-form-urlencoded" || e === "multipart/form-data" || e.startsWith("text/");
};
const nested = (value: string): unknown => {
  if (!/^[\s]*[\[{]/.test(value)) return undefined;
  try { const v: unknown = JSON.parse(value); return v !== null && typeof v === "object" ? v : undefined; } catch { return undefined; }
};
const messagePartsPath = /^\.(?:"messages"\[[0-9]+\]\."content"(?:\."parts")?|"contents"\[[0-9]+\]\."parts"|"input"\[[0-9]+\]\."content")$/;
const fragment = (value: unknown): string | undefined => {
  if (typeof value === "string") return nested(value) === undefined ? value : undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (v.type !== undefined && !["text", "input_text", "output_text"].includes(String(v.type))) return undefined;
  return typeof v.text === "string" && nested(v.text) === undefined ? v.text : undefined;
};

export const extractBody = (ct: string | null | undefined, body: string): ExtractedBody => {
  const out: ExtractedBody = { text: "", spans: [], joined: [], filenames: [] };
  const add = (text: string, label = ""): void => {
    out.text += `${text}\n`;
    out.spans.push({ text, ...(label ? { label } : {}) });
  };
  const walk = (value: unknown, path: string, label: string, depth: number): void => {
    if (depth > 64) return;
    if (typeof value === "string") {
      const inner = nested(value);
      if (inner !== undefined) walk(inner, `${path}{}`, label, depth + 1);
      else add(value, label);
    } else if (typeof value === "number") add(String(value), label);
    else if (Array.isArray(value)) {
      if (messagePartsPath.test(path)) {
        let pieces: string[] = [];
        const flush = (): void => { if (pieces.length > 1) out.joined.push(pieces.join("")); pieces = []; };
        for (const item of value) { const text = fragment(item); if (text === undefined) flush(); else pieces.push(text); }
        flush();
      }
      value.forEach((item, i) => walk(item, `${path}[${i}]`, label, depth + 1));
    } else if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      Object.keys(record).sort().forEach((key) => walk(record[key], `${path}.${JSON.stringify(key)}`, key, depth + 1));
    }
  };
  const e = essenceOf(ct);
  if (e === "application/json" || e.endsWith("+json")) {
    try { walk(JSON.parse(body), "", "", 0); } catch { add(body); }
  } else if (e === "application/x-www-form-urlencoded") {
    for (const pair of body.split("&")) {
      const at = pair.indexOf("=");
      if (at < 0) continue;
      const decode = (s: string): string => { try { return decodeURIComponent(s.replaceAll("+", " ")); } catch { return s; } };
      const label = decode(pair.slice(0, at));
      walk(decode(pair.slice(at + 1)), `form.${label}`, label, 0);
    }
  } else if (e === "multipart/form-data") {
    const boundary = /boundary="?([^";]+)"?/i.exec(ct ?? "")?.[1];
    if (!boundary) return out;
    for (const part of body.split(`--${boundary}`).slice(1)) {
      if (part.startsWith("--")) break;
      const p = part.replace(/^\r?\n/, ""), at = p.indexOf("\r\n\r\n");
      if (at < 0) continue;
      const head = p.slice(0, at), content = p.slice(at + 4).replace(/\r?\n$/, "");
      const filename = /(?:^|[;\s])filename="([^"]*)"/i.exec(head)?.[1];
      const name = /(?:^|[;\s])name="([^"]*)"/i.exec(head)?.[1] ?? "";
      const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim().toLowerCase() ?? "";
      if (filename) out.filenames.push(filename);
      const text = type.startsWith("text/") || type.startsWith("application/json");
      if (text || !filename && type === "") walk(content, `multipart.${name}`, name, 0);
    }
  } else if (inspectableBody(ct)) {
    const object = nested(body);
    const lines = body.trim().split("\n").filter(line => line.trim());
    const objects = lines.map(nested);
    if (object !== undefined) walk(object, "", "", 0);
    else if (lines.length > 1 && objects.every(item => item !== undefined)) objects.forEach(item => walk(item, "", "", 0));
    else add(body);
  }
  return out;
};
