// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GUARD_CATALOGUE_SEED } from "../src/catalogue.js";
import {
  GUARD_APP_MARKS,
  GUARD_MARK_ID_PREFIX,
  GUARD_MARK_SPECS,
  GUARD_SERVICES_WITHOUT_MARK,
  type GuardMark,
  type GuardMarkHandling,
  type GuardMarkIndex,
  type GuardMarkSpec,
} from "../src/marks-spec.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, "..");
const REPO = path.resolve(PKG, "../..");
const MARKS_DIR = path.join(PKG, "marks");

export const LIGHT_GROUNDS = ["#f2f2f2", "#e9e9e9"] as const;
export const DARK_GROUNDS = ["#222121", "#3c3c3c"] as const;
const INK = { light: "#1f1f1f", dark: "#fafafa" } as const;

const NAMED: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", gold: "#ffd700" };

export const parseColour = (raw: string): string | undefined => {
  const v = raw.trim().toLowerCase();
  if (v in NAMED) return NAMED[v];
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return `#${[...m[1]!].map((c) => c + c).join("")}`;
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v);
  if (m) return `#${m[1]}`;
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  if (m) return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
  return undefined;
};

export const luminance = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const ch = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch((n >> 16) & 255) + 0.7152 * ch((n >> 8) & 255) + 0.0722 * ch(n & 255);
};
export const ratio = (a: string, b: string): number => {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const worst = (colour: string, grounds: readonly string[]) => Math.min(...grounds.map((g) => ratio(colour, g)));
const spread = (hex: string): number => {
  const n = Number.parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...c) - Math.min(...c);
};
export const isNearBlack = (hex: string): boolean => luminance(hex) < 0.02 && spread(hex) <= 0x20;
export const isNearWhite = (hex: string): boolean => luminance(hex) > 0.9 && spread(hex) <= 0x20;
const round2 = (n: number) => Math.round(n * 100) / 100;

const ATTR = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const attrsOf = (tag: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const m of tag.matchAll(ATTR)) out.set(m[1]!, m[2] ?? m[3] ?? "");
  return out;
};
const KEEP_ROOT = ["fill", "fill-rule", "clip-rule", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin"];
const STYLE_PROPS = new Set(["fill", "stroke", "stop-color", "stop-opacity", "fill-opacity", "stroke-opacity", "opacity", "fill-rule", "clip-rule", "stroke-width"]);

type Parsed = { viewBox: string; rootAttrs: Map<string, string>; inner: string };

export const parseSvg = (text: string, spec: GuardMarkSpec): Parsed => {
  let t = text.replace(/<\?xml[\s\S]*?\?>/g, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<!DOCTYPE[^>]*>/gi, "");
  const open = /<svg\b[^>]*>/.exec(t);
  const close = t.lastIndexOf("</svg>");
  if (open === null || close === -1) throw new Error(`${spec.file}: not an <svg>`);
  const root = attrsOf(open[0]);
  let inner = t.slice(open.index + open[0].length, close);
  let viewBox = root.get("viewBox") ?? `0 0 ${Number.parseFloat(root.get("width") ?? "24")} ${Number.parseFloat(root.get("height") ?? "24")}`;
  if (spec.extract !== undefined) {
    const paths = [...inner.matchAll(/<path\b[^>]*?(?:\/>|>[\s\S]*?<\/path>)/g)].map((m) => m[0]);
    inner = spec.extract.paths.map((i) => paths[i] ?? "").join("");
    viewBox = spec.extract.viewBox;
  }
  t = inner.replace(/<title>[\s\S]*?<\/title>/g, "").replace(/<desc>[\s\S]*?<\/desc>/g, "");
  const rules = new Map<string, Array<[string, string]>>();
  t = t.replace(/<style[^>]*>([\s\S]*?)<\/style>/g, (_all, css: string) => {
    for (const r of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      const decls = r[2]!.split(";").map((d) => d.split(":").map((s) => s.trim())).filter((d): d is [string, string] => d.length === 2 && d[0] !== "");
      for (const sel of r[1]!.split(",").map((s) => s.trim())) {
        const cls = /^\.([\w-]+)$/.exec(sel)?.[1];
        if (cls !== undefined) rules.set(cls, [...(rules.get(cls) ?? []), ...decls]);
      }
    }
    return "";
  });
  t = t.replace(/<([a-zA-Z]+)\b([^>]*?)(\/?)>/g, (_all, name: string, rawAttrs: string, selfClose: string) => {
    const a = attrsOf(rawAttrs);
    const classes = (a.get("class") ?? "").split(/\s+/).filter(Boolean);
    a.delete("class");
    a.delete("data-name");
    for (const c of classes) for (const [k, v] of rules.get(c) ?? []) if (!a.has(k)) a.set(k, v);
    const style = a.get("style");
    if (style !== undefined) {
      const rest: string[] = [];
      for (const d of style.split(";")) {
        const [k, v] = d.split(":").map((s) => s?.trim());
        if (k === undefined || v === undefined || k === "") continue;
        if (STYLE_PROPS.has(k)) a.set(k, v);
        else rest.push(`${k}:${v}`);
      }
      if (rest.length > 0) a.set("style", rest.join(";"));
      else a.delete("style");
    }
    const attrs = [...a].map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
    return `<${name}${attrs}${selfClose}>`;
  });
  t = resolveRefs(t, spec);
  const ids = [...new Set([...t.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!))];
  ids.forEach((id, n) => {
    const to = `${GUARD_MARK_ID_PREFIX}${n}`;
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    t = t
      .replace(new RegExp(`\\bid="${esc}"`, "g"), `id="${to}"`)
      .replace(new RegExp(`url\\(#${esc}\\)`, "g"), `url(#${to})`)
      .replace(new RegExp(`href="#${esc}"`, "g"), `href="#${to}"`);
  });
  const rootAttrs = new Map<string, string>();
  for (const k of KEEP_ROOT) {
    const v = root.get(k);
    if (v !== undefined) rootAttrs.set(k, v);
  }
  if (spec.source === "simple-icons") rootAttrs.set("fill", spec.hex ?? "#000000");
  if (spec.extract !== undefined) rootAttrs.set("fill", spec.extract.fill);
  return { viewBox, rootAttrs, inner: t.replace(/>\s+</g, "><").trim() };
};

const HREF = /\s(?:[\w-]+:)?href="#([^"]+)"/;
const resolveRefs = (input: string, spec: GuardMarkSpec): string => {
  let t = input;
  const elementById = (id: string): { whole: string; name: string; attrs: string; body: string } | undefined => {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`<(\\w+)\\b([^>]*\\bid="${esc}"[^>]*?)(?:/>|>([\\s\\S]*?)</\\1>)`).exec(t);
    return m === null ? undefined : { whole: m[0], name: m[1]!, attrs: m[2]!, body: m[3] ?? "" };
  };
  const strip = (attrs: string, keys: string[]) => {
    const a = attrsOf(attrs);
    for (const k of [...a.keys()]) if (keys.includes(k) || /(^|:)href$/.test(k)) a.delete(k);
    return a;
  };
  const dropped = new Set<string>();
  for (let guard = 0; guard < 8; guard += 1) {
    const g = /<(linearGradient|radialGradient)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
    let changed = false;
    t = t.replace(g, (all, name: string, attrs: string, _end: string, body: string | undefined) => {
      const ref = HREF.exec(attrs)?.[1];
      if (ref === undefined) return all;
      const target = elementById(ref);
      if (target === undefined) throw new Error(`${spec.file}: gradient href #${ref} not found`);
      const own = strip(attrs, []);
      for (const [k, v] of strip(target.attrs, ["id"])) if (!own.has(k)) own.set(k, v);
      const stops = body !== undefined && /<stop\b/.test(body) ? body : target.body;
      dropped.add(ref);
      changed = true;
      const at = [...own].map(([k, v]) => ` ${k}="${v}"`).join("");
      return stops === "" ? `<${name}${at}/>` : `<${name}${at}>${stops}</${name}>`;
    });
    if (!changed) break;
  }
  const used = new Set<string>();
  t = t.replace(/<use\b([^>]*?)(?:\/>|><\/use>)/g, (_all, attrs: string) => {
    const ref = HREF.exec(attrs)?.[1];
    const target = ref === undefined ? undefined : elementById(ref);
    if (ref === undefined || target === undefined) throw new Error(`${spec.file}: <use> without a resolvable href`);
    const own = strip(attrs, []);
    for (const k of ["x", "y"]) if ((own.get(k) ?? "0") !== "0") throw new Error(`${spec.file}: <use ${k}> offset not supported`);
    own.delete("x");
    own.delete("y");
    const merged = strip(target.attrs, ["id"]);
    for (const [k, v] of own) merged.set(k, v);
    used.add(ref);
    const at = [...merged].map(([k, v]) => ` ${k}="${v}"`).join("");
    return target.body === "" ? `<${target.name}${at}/>` : `<${target.name}${at}>${target.body}</${target.name}>`;
  });
  for (const id of [...dropped, ...used]) {
    const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`url\\(#${esc}\\)|href="#${esc}"`).test(t)) continue;
    const el = elementById(id);
    if (el !== undefined) t = t.replace(el.whole, "");
  }
  return t;
};

const svgOf = (p: Parsed, rootAttrs: Map<string, string>, inner: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${p.viewBox}"${[...rootAttrs].map(([k, v]) => ` ${k}="${v}"`).join("")} aria-hidden="true" focusable="false">${inner}</svg>`;

const coloursOf = (p: Parsed): { concrete: Set<string>; current: boolean; raw: Map<string, string> } => {
  const concrete = new Set<string>();
  const raw = new Map<string, string>();
  let current = false;
  const see = (v: string) => {
    if (/currentcolor/i.test(v)) current = true;
    const c = parseColour(v);
    if (c !== undefined) {
      concrete.add(c);
      raw.set(v, c);
    }
  };
  for (const v of p.rootAttrs.values()) see(v);
  for (const m of p.inner.matchAll(/\b(?:fill|stroke|stop-color|flood-color)="([^"]+)"/g)) see(m[1]!);
  const rootFill = p.rootAttrs.get("fill");
  if (rootFill === undefined && !/<g\b[^>]*\bfill=/.test(p.inner) && /<(?:path|circle|rect|polygon|ellipse)\b(?![^>]*\bfill=)[^>]*>/.test(p.inner)) concrete.add("#000000");
  return { concrete, current, raw };
};

const recolour = (p: Parsed, to: Map<string, string>): { rootAttrs: Map<string, string>; inner: string } => {
  const rootAttrs = new Map(p.rootAttrs);
  for (const [k, v] of rootAttrs) {
    const c = parseColour(v);
    if (c !== undefined && to.has(c)) rootAttrs.set(k, to.get(c)!);
  }
  const inner = p.inner.replace(/\b(fill|stroke|stop-color)="([^"]+)"/g, (all, k: string, v: string) => {
    const c = parseColour(v);
    return c !== undefined && to.has(c) ? `${k}="${to.get(c)!}"` : all;
  });
  if (!rootAttrs.has("fill") && to.has("#000000")) rootAttrs.set("fill", to.get("#000000")!);
  return { rootAttrs, inner };
};

export const buildMark = (spec: GuardMarkSpec, text: string): GuardMark => {
  const p = parseSvg(text, spec);
  const { concrete, current } = coloursOf(p);
  const visible = new Set([...concrete].filter((c) => {
    const outside = p.inner.replace(/<(mask|clipPath)\b[\s\S]*?<\/\1>/g, "");
    return [...outside.matchAll(/\b(?:fill|stroke|stop-color)="([^"]+)"/g)].some((m) => parseColour(m[1]!) === c) || [...p.rootAttrs.values()].some((v) => parseColour(v) === c) || (c === "#000000" && !p.rootAttrs.has("fill"));
  }));
  const base = svgOf(p, p.rootAttrs, p.inner);
  const measure = (grounds: readonly string[], colours: Iterable<string>, inked: boolean, ink: string): [number, number] => {
    const r = [...colours, ...(inked ? [ink] : [])].map((c) => worst(c, grounds));
    return r.length === 0 ? [0, 0] : [round2(Math.min(...r)), round2(Math.max(...r))];
  };
  const light = {
    handling: (visible.size === 0 ? "ink" : "brand") as GuardMarkHandling,
    svg: base,
    contrast: measure(LIGHT_GROUNDS, visible, current || visible.size === 0, INK.light),
  };
  const dark = (() => {
    const black = [...visible].filter(isNearBlack);
    if (visible.size === 0 || black.length === 0)
      return { handling: light.handling, svg: base, contrast: measure(DARK_GROUNDS, visible, current || visible.size === 0, INK.dark) };
    const to = new Map<string, string>(black.map((c) => [c, "currentColor"]));
    for (const c of visible) if (isNearWhite(c)) to.set(c, INK.light);
    const rest = [...visible].filter((c) => !to.has(c));
    const swapped = recolour(p, to);
    return {
      handling: (rest.length === 0 ? "ink" : "brand-ink") as GuardMarkHandling,
      svg: svgOf(p, swapped.rootAttrs, swapped.inner),
      contrast: measure(DARK_GROUNDS, rest, true, INK.dark),
    };
  })();
  const [, , vw, vh] = p.viewBox.trim().split(/[\s,]+/).map(Number);
  const wide = vw !== undefined && vh !== undefined && vh > 0 && vw / vh >= 2;
  return {
    id: spec.id,
    title: spec.title,
    source: spec.source,
    license: spec.license,
    light: light.svg,
    ...(dark.svg === light.svg ? {} : { dark: dark.svg }),
    handling: { light: light.handling, dark: dark.handling },
    ...(wide ? { wide: true as const } : {}),
    contrast: { light: light.contrast, dark: dark.contrast },
  };
};

const NUM = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
export const normaliseArcPath = (d: string): string => {
  const out: string[] = [];
  let i = 0;
  let cmd = "";
  let argN = 0;
  const skip = () => {
    while (i < d.length && /[\s,]/.test(d[i]!)) i += 1;
  };
  for (skip(); i < d.length; skip()) {
    const ch = d[i]!;
    if (/[MmZzLlHhVvCcSsQqTtAa]/.test(ch)) {
      cmd = ch;
      argN = 0;
      out.push(ch);
      i += 1;
      continue;
    }
    if ((cmd === "a" || cmd === "A") && (argN % 7 === 3 || argN % 7 === 4) && (ch === "0" || ch === "1")) {
      out.push(ch);
      i += 1;
      argN += 1;
      continue;
    }
    const m = NUM.exec(d.slice(i));
    if (m === null) return d;
    out.push(m[0]);
    i += m[0].length;
    argN += 1;
  }
  return out.join(" ");
};
export const normaliseArcFlags = (svg: string): string => svg.replace(/\bd="([^"]*[Aa][^"]*)"/g, (_all, d: string) => `d="${normaliseArcPath(d)}"`);


export const buildIndex = (): GuardMarkIndex => {
  const index: GuardMarkIndex = { byBundleId: {}, byName: {}, byCli: {}, byService: {} };
  for (const s of GUARD_CATALOGUE_SEED) {
    if (s.markId === undefined) continue;
    index.byService[s.serviceId] = s.markId;
    for (const b of s.bundleIds ?? []) index.byBundleId[b] ??= s.markId;
    for (const c of s.cliNames ?? []) index.byCli[c] ??= s.markId;
  }
  for (const row of GUARD_APP_MARKS) {
    for (const b of row.bundleIds) index.byBundleId[b] = row.markId ?? "";
    for (const n of row.names) index.byName[n.toLowerCase()] = row.markId ?? "";
  }
  for (const s of GUARD_CATALOGUE_SEED) {
    if (s.markId === undefined) continue;
    for (const n of [s.name, s.name.replace(/ (AI|AI Assistant)$/, "")]) index.byName[n.toLowerCase()] ??= s.markId;
  }
  const sort = (r: Record<string, string>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  return { byBundleId: sort(index.byBundleId), byName: sort(index.byName), byCli: sort(index.byCli), byService: sort(index.byService) };
};

const HEADER_TS = `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
//
// THE CODE in this file is Apache-2.0. THE ARTWORK in it is NOT: each mark's \`license\` field names the licence of
// the file it came from (CC0-1.0 Simple Icons, MIT Lobe Icons, a vendor's own file), ../marks/SOURCES.md records the
// source of every one, and ../marks/licenses/ holds the texts. Every mark is its owner's trademark; it is shown only to
// identify the service or app a row names (nominative use).
`;

export const buildOutputs = (): Map<string, string> => {
  const out = new Map<string, string>();
  const marks: GuardMark[] = GUARD_MARK_SPECS.map((spec) =>
    buildMark(spec, readFileSync(path.join(MARKS_DIR, spec.file), "utf8")),
  );
  const byId = Object.fromEntries(marks.map((m) => [m.id, m]));
  const index = buildIndex();

  out.set(
    "packages/guard-contract/src/marks.generated.ts",
    `${HEADER_TS}import type { GuardMark, GuardMarkIndex } from "./marks-spec.js";\n\nexport const GUARD_MARKS: Readonly<Record<string, GuardMark>> = ${JSON.stringify(byId, null, 2)};\n\nexport const GUARD_MARK_INDEX: GuardMarkIndex = ${JSON.stringify(index, null, 2)};\n`,
  );

  const agent = {
    note: "GENERATED by packages/guard-contract/scripts/build-marks.ts — do not edit. Artwork licences: packages/guard-contract/marks/SOURCES.md.",
    marks: Object.fromEntries(marks.map((m) => [m.id, { title: m.title, light: m.light, dark: m.dark ?? null, lightTileOnDark: m.handling.dark === "light-tile", wide: m.wide === true }])),
    index,
  };
  out.set("guard/agent/src/marks.generated.json", `${JSON.stringify(agent, null, 1)}\n`);

  const XC = "guard/mac/VibtraGuard/Marks.xcassets";
  out.set(`${XC}/Contents.json`, `${JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2)}\n`);
  for (const m of marks) {
    const set = `${XC}/mark-${m.id}.imageset`;
    const box = (() => {
      const [, , vw, vh] = (/viewBox="([^"]+)"/.exec(m.light)?.[1] ?? "0 0 24 24").trim().split(/[\s,]+/).map(Number);
      const k = 64 / Math.max(vw ?? 24, vh ?? 24);
      return ` width="${round2((vw ?? 24) * k)}" height="${round2((vh ?? 24) * k)}"`;
    })();
    const ink = (svg: string, colour: string) =>
      normaliseArcFlags(svg.replace(/currentColor/g, colour).replaceAll(GUARD_MARK_ID_PREFIX, `m_${m.id.replace(/-/g, "_")}_`)).replace(/^<svg /, `<svg${box} `);
    out.set(`${set}/light.svg`, `${ink(m.light, INK.light)}\n`);
    out.set(`${set}/dark.svg`, `${ink(m.handling.dark === "light-tile" ? m.light : (m.dark ?? m.light), m.handling.dark === "light-tile" ? INK.light : INK.dark)}\n`);
    out.set(
      `${set}/Contents.json`,
      `${JSON.stringify(
        {
          images: [
            { filename: "light.svg", idiom: "universal" },
            { appearances: [{ appearance: "luminosity", value: "dark" }], filename: "dark.svg", idiom: "universal" },
          ],
          info: { author: "xcode", version: 1 },
          properties: { "preserves-vector-representation": true },
        },
        null,
        2,
      )}\n`,
    );
  }
  const swiftDict = (r: Record<string, string>) => `[\n${Object.entries(r).map(([k, v]) => `        ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n    ]`;
  out.set(
    "guard/mac/VibtraGuard/GuardMarks.generated.swift",
    `// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
//
// GENERATED by packages/guard-contract/scripts/build-marks.ts — do not edit. The images are Marks.xcassets
// (\`mark-<id>\`); their sources and licences are packages/guard-contract/marks/SOURCES.md.

enum GuardMarks {
    static let lightTileOnDark: Set<String> = [${marks.filter((m) => m.handling.dark === "light-tile").map((m) => JSON.stringify(m.id)).join(", ")}]
    static let titles: [String: String] = ${swiftDict(Object.fromEntries(marks.map((m) => [m.id, m.title])))}
    static let byService: [String: String] = ${swiftDict(index.byService)}
    static let byBundleId: [String: String] = ${swiftDict(index.byBundleId)}
    static let byName: [String: String] = ${swiftDict(index.byName)}
    static let byCli: [String: String] = ${swiftDict(index.byCli)}
    static let systemIconBundleId: [String: String] = ${swiftDict(Object.fromEntries(GUARD_APP_MARKS.filter((a) => a.markId === null && a.bundleIds[0] !== undefined).flatMap((a) => a.names.map((n) => [n.toLowerCase(), a.bundleIds[0]!] as const))))}
}
`,
  );

  out.set("packages/guard-contract/marks/SOURCES.md", sourcesMd(marks, index));
  out.set("REUSE.toml", withReuseBlock(readFileSync(path.join(REPO, "REUSE.toml"), "utf8"), reuseBlock()));
  return out;
};

const HANDLING_WORDS: Record<GuardMarkHandling, string> = {
  brand: "brand colours",
  ink: "ink (currentColor)",
  "brand-ink": "brand colours, near-black parts in ink",
  "light-tile": "brand colours on a light tile",
};

const sourcesMd = (marks: GuardMark[], index: GuardMarkIndex): string => {
  const specOf = new Map(GUARD_MARK_SPECS.map((s) => [s.id, s]));
  const rows = marks.map((m) => {
    const s = specOf.get(m.id)!;
    const services = GUARD_CATALOGUE_SEED.filter((r) => r.markId === m.id).map((r) => r.name);
    const apps = GUARD_APP_MARKS.filter((a) => a.markId === m.id).flatMap((a) => a.names.slice(0, 1));
    return `| \`${m.id}\` | ${m.title} | ${[...services, ...apps.map((a) => `${a} (app)`)].join(", ") || "—"} | ${s.source} | ${s.origin}${s.note === undefined ? "" : ` — ${s.note}`} | ${s.license} | ${HANDLING_WORDS[m.handling.light]} (${m.contrast.light[0]}–${m.contrast.light[1]}:1) | ${HANDLING_WORDS[m.handling.dark]} (${m.contrast.dark[0]}–${m.contrast.dark[1]}:1) |`;
  });
  const without = [
    ...Object.entries(GUARD_SERVICES_WITHOUT_MARK).map(([id, why]) => `| service \`${id}\` | ${why} |`),
    ...GUARD_APP_MARKS.filter((a) => a.markId === null).map((a) => `| app ${a.names.join(" / ")} (${a.bundleIds.join(", ")}) | ${a.reason ?? ""} |`),
  ];
  return `<!-- GENERATED by packages/guard-contract/scripts/build-marks.ts — do not edit. -->
# Vibtra Guard brand marks — sources and licences

Every catalogued AI service and every app Guard names is drawn with its owner's mark. The files in this directory are
the sources, **byte for byte** as published (\`simple-icons/\` from npm \`simple-icons@16.30.0\`, CC0-1.0; \`lobe-icons/\`
from npm \`@lobehub/icons-static-svg@1.95.1\`, MIT; \`vendor/\` from each vendor's own site or repository, or for
Chrome, Firefox, Edge and Opera from npm \`@browser-logos/*\`, whose MIT licence excludes the logos themselves). Licence texts:
\`licenses/\`. The generator (\`../scripts/build-marks.ts\`) never changes a shape: it renames ids, inlines CSS classes and
resolves \`<use>\` and gradient inheritance into plain elements. **Colour:** every mark keeps its brand colours in both
themes (logos are exempt from WCAG contrast, and the service's name is always printed beside the mark); the one change
is that a black or neutral near-black part is drawn in the theme's ink (near-white) in dark mode, with any white
knockout on it in the light theme's ink. A file that paints only \`currentColor\` is the vendor's monochrome mark and is
ink in both themes. Multi-colour marks use the vendor's colour file (Lobe's \`-color\` variant, browser-logos for the
browsers).

**Trademarks.** A file licence (CC0, MIT, BSD, Apache) licenses no trademark. Each mark is its owner's; Guard shows it
only on the row that names that owner's service or app, to identify what a laptop reached (nominative use), never as
decoration, and nothing implies endorsement. \`LicenseRef-Nominative-Use\` marks a vendor file published on the vendor's
own site (or in a package that excludes it from its licence) without a licence of its own: shown on that nominative-use claim alone. The main console's
\`apps/console/src/brand/marks/SOURCES.md\` records the published conditions of the vendors it walked (Microsoft's icon
terms among them); the founder's ratification of that sentence is still pending there and covers these marks too.

**Contrast** is recorded, not enforced: against the tile, light \`${LIGHT_GROUNDS.join("\` / \`")}\`, dark \`${DARK_GROUNDS.join("\` / \`")}\`;
the figures are the weakest and strongest colour of the mark as drawn in that theme (WCAG ratio).

| id | mark | used for | source | origin | file licence | light | dark |
|---|---|---|---|---|---|---|---|
${rows.join("\n")}

## Without a mark (a neutral glyph, never letters)

| what | why |
|---|---|
${without.join("\n")}

Uncatalogued hosts, custom services an organisation adds, and apps outside the index (${Object.keys(index.byName).length} names,
${Object.keys(index.byBundleId).length} bundle ids, ${Object.keys(index.byCli).length} CLIs) draw the neutral glyph too: a globe for a service, a window for an app,
a prompt for a CLI.
`;
};

export const REUSE_BEGIN = "# >>> guard-marks (generated by packages/guard-contract/scripts/build-marks.ts; do not edit by hand)";
export const REUSE_END = "# <<< guard-marks";
const REUSE_ANCHOR = "# >>> copied-from-upstream";
const SOURCE_DIRS = ["simple-icons", "lobe-icons", "vendor"] as const;

export const reuseBlock = (): string => {
  const groups = new Map<string, { licence: string; holder: string; paths: string[] }>();
  const add = (licence: string, holder: string, rel: string) => {
    const key = `${licence}\u0000${holder}`;
    const g = groups.get(key) ?? { licence, holder, paths: [] };
    g.paths.push(rel);
    groups.set(key, g);
  };
  const specByFile = new Map<string, GuardMarkSpec>();
  for (const spec of GUARD_MARK_SPECS) specByFile.set(spec.file, spec);
  for (const dir of SOURCE_DIRS) {
    for (const f of readdirSync(path.join(MARKS_DIR, dir)).filter((n) => n.endsWith(".svg")).sort()) {
      const spec = specByFile.get(`${dir}/${f}`);
      if (spec === undefined) throw new Error(`marks/${dir}/${f}: vendored but no spec names it — say whose it is, or delete it`);
      add(spec.license, spec.holder, `packages/guard-contract/marks/${dir}/${f}`);
    }
  }
  for (const spec of GUARD_MARK_SPECS) add(spec.license, spec.holder, `guard/mac/VibtraGuard/Marks.xcassets/mark-${spec.id}.imageset/*.svg`);
  const out = [
    REUSE_BEGIN,
    "# Vendored brand-mark artwork keeps its own file licence and holder (packages/guard-contract/marks/SOURCES.md);",
    "# the Mac app's generated copies carry the licence of the file they are drawn from. Listed after the Apache",
    "# table so the last-match rule gives them this table, not Apache-2.0 \"2026 Sam Rahmani and Tyler Stewart\". A file licence licenses no",
    "# trademark: every mark is its owner's, shown nominatively (LICENSES/LicenseRef-Nominative-Use.txt).",
  ];
  for (const g of [...groups.values()].sort((a, b) => a.licence.localeCompare(b.licence) || a.holder.localeCompare(b.holder))) {
    out.push(
      "",
      "[[annotations]]",
      `path = [${g.paths.map((p) => JSON.stringify(p)).join(", ")}]`,
      'precedence = "closest"',
      `SPDX-FileCopyrightText = ${JSON.stringify(g.holder)}`,
      `SPDX-License-Identifier = ${JSON.stringify(g.licence)}`,
    );
  }
  out.push(REUSE_END);
  return out.join("\n");
};

export const withReuseBlock = (toml: string, block: string): string => {
  const a = toml.indexOf(REUSE_BEGIN);
  const b = toml.indexOf(REUSE_END);
  if (a !== -1 && b !== -1) return `${toml.slice(0, a)}${block}${toml.slice(b + REUSE_END.length)}`;
  const at = toml.indexOf(REUSE_ANCHOR);
  if (at === -1) return `${toml.trimEnd()}\n\n${block}\n`;
  return `${toml.slice(0, at)}${block}\n\n${toml.slice(at)}`;
};

export const staleOutputs = (): string[] => {
  const want = buildOutputs();
  const stale = [...want].filter(([rel, text]) => !existsSync(path.join(REPO, rel)) || readFileSync(path.join(REPO, rel), "utf8") !== text).map(([rel]) => rel);
  const xc = path.join(REPO, "guard/mac/VibtraGuard/Marks.xcassets");
  if (existsSync(xc)) for (const d of readdirSync(xc)) if (d.endsWith(".imageset") && !want.has(`guard/mac/VibtraGuard/Marks.xcassets/${d}/Contents.json`)) stale.push(`guard/mac/VibtraGuard/Marks.xcassets/${d}`);
  return stale;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--check")) {
    const stale = staleOutputs();
    if (stale.length > 0) {
      console.error(`[marks] STALE — run pnpm --filter @vibtra/guard-contract marks:\n  ${stale.join("\n  ")}`);
      process.exit(1);
    }
    console.log("[marks] every output is current");
  } else {
    rmSync(path.join(REPO, "guard/mac/VibtraGuard/Marks.xcassets"), { recursive: true, force: true });
    for (const [rel, text] of buildOutputs()) {
      mkdirSync(path.dirname(path.join(REPO, rel)), { recursive: true });
      writeFileSync(path.join(REPO, rel), text);
    }
    console.log(`[marks] wrote ${GUARD_MARK_SPECS.length} marks`);
  }
}
