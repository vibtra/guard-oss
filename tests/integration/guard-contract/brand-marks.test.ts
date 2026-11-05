import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GUARD_APP_MARKS, GUARD_CATALOGUE_SEED, GUARD_MARKS, GUARD_MARK_SPECS, GUARD_SERVICES_WITHOUT_MARK, markForApp, markForService, markMarkup } from "@vibtra/guard-contract";
import { PACKAGE_DIR, REPO_ROOT, runProcess } from "./support.js";

const MARKS_DIR = path.join(PACKAGE_DIR, "marks");
const MAC_MARKS = path.join(REPO_ROOT, "guard/mac/VibtraGuard/Marks.xcassets");

const NAMED_COLOURS: Record<string, string> = { black: "#000000", white: "#ffffff", red: "#ff0000", gold: "#ffd700" };
const hexOf = (raw: string): string | undefined => {
  const v = raw.trim().toLowerCase();
  const named = NAMED_COLOURS[v];
  if (named !== undefined) return named;
  const short = /^#([0-9a-f]{3})$/.exec(v)?.[1];
  if (short !== undefined) return `#${[...short].map((c) => c + c).join("")}`;
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(v)?.[1];
  if (long !== undefined) return `#${long}`;
  const rgb = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/.exec(v);
  return rgb === null ? undefined : `#${rgb.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
};
const paintedColours = (svg: string): Set<string> =>
  new Set([...svg.matchAll(/\b(?:fill|stroke|stop-color)="([^"]+)"/g)].flatMap((m) => hexOf(m[1] ?? "") ?? []));
type MarkSpec = (typeof GUARD_MARK_SPECS)[number];
const vendorFile = (spec: MarkSpec): string => readFileSync(path.join(MARKS_DIR, spec.file), "utf8").replace(/<!--[\s\S]*?-->/g, "");
const vendorColours = (spec: MarkSpec): Set<string> => {
  const declared = [...vendorFile(spec).matchAll(/(?:fill|stroke|stop-color|flood-color)\s*[:=]\s*["']?\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|[a-zA-Z]+)/g)].map((m) => m[1] ?? "");
  return new Set([...declared, spec.hex ?? "", spec.extract?.fill ?? ""].flatMap((raw) => hexOf(raw) ?? []));
};
const DRAWS_PART_OF_VENDOR_FILE: Record<string, string> = {
  "you-com": "draws only the symbol's two paths of the vendor lockup and fills them with currentColor, so the lockup's own colours are not painted",
};
const vendorInks = (spec: MarkSpec): boolean => /currentcolor/i.test(`${vendorFile(spec)} ${spec.extract?.fill ?? ""}`);
const channels = (hex: string): [number, number, number] => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const linearSrgb = (channel: number): number => (channel / 255 <= 0.04045 ? channel / 255 / 12.92 : ((channel / 255 + 0.055) / 1.055) ** 2.4);
const relativeLuminance = (hex: string): number => {
  const [r, g, b] = channels(hex);
  return 0.2126 * linearSrgb(r) + 0.7152 * linearSrgb(g) + 0.0722 * linearSrgb(b);
};
const neutral = (hex: string): boolean => Math.max(...channels(hex)) - Math.min(...channels(hex)) <= 0x20;
const nearBlack = (hex: string): boolean => relativeLuminance(hex) < 0.02 && neutral(hex);
const nearWhite = (hex: string): boolean => relativeLuminance(hex) > 0.9 && neutral(hex);

const ARC_PATH_TOKEN = /^(?:[MmZzLlHhVvCcSsQqTtAa]|[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)$/;
const arcFlagsSpelledApart = (d: string): boolean => {
  const tokens = d.split(" ");
  if (!tokens.every((t) => ARC_PATH_TOKEN.test(t))) return false;
  const segments: Array<{ command: string; args: string[] }> = [];
  for (const t of tokens) {
    if (/^[A-Za-z]$/.test(t)) segments.push({ command: t, args: [] });
    else segments.at(-1)?.args.push(t);
  }
  return segments.every(({ command, args }) => command.toLowerCase() !== "a" || (args.length % 7 === 0 && args.every((a, i) => (i % 7 !== 3 && i % 7 !== 4) || a === "0" || a === "1")));
};

describe("the brand marks (the icon sweep)", () => {
  it("gives every seed service a sourced mark, or names why it has none", () => {
    for (const s of GUARD_CATALOGUE_SEED) {
      if (s.markId === undefined) expect(GUARD_SERVICES_WITHOUT_MARK[s.serviceId], s.serviceId).toBeTruthy();
      else expect(GUARD_MARKS[s.markId], `${s.serviceId} → ${s.markId}`).toBeDefined();
    }
    expect(Object.keys(GUARD_SERVICES_WITHOUT_MARK).every((id) => GUARD_CATALOGUE_SEED.some((s) => s.serviceId === id && s.markId === undefined))).toBe(true);
  });

  it("gives every named app a mark, or a written reason", () => {
    for (const a of GUARD_APP_MARKS) {
      if (a.markId === null) expect(a.reason, a.names[0]).toBeTruthy();
      else expect(GUARD_MARKS[a.markId], a.names[0]).toBeDefined();
    }
  });

  it("reads every mark from a vendored file, under a recorded licence, with unique ids", () => {
    const ids = GUARD_MARK_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of GUARD_MARK_SPECS) {
      expect(existsSync(path.join(MARKS_DIR, s.file)), s.file).toBe(true);
      expect(s.license).toMatch(/^(CC0-1\.0|MIT|Apache-2\.0|BSD-3-Clause|LicenseRef-Nominative-Use)$/);
      if (s.source === "simple-icons") expect(s.hex).toMatch(/^#[0-9A-F]{6}$/);
    }
    expect(readFileSync(path.join(MARKS_DIR, "SOURCES.md"), "utf8")).toContain("| `slack` |");
  });

  it("draws every mark in its vendor's colours in both themes; only near-black turns to ink, and only in dark", () => {
    for (const spec of GUARD_MARK_SPECS) {
      const m = GUARD_MARKS[spec.id];
      expect(m, spec.id).toBeDefined();
      if (m === undefined) continue;
      const vendor = vendorColours(spec);
      const light = paintedColours(m.light);
      const dark = paintedColours(m.dark ?? m.light);
      const brand = DRAWS_PART_OF_VENDOR_FILE[spec.id] === undefined ? vendor : light;
      for (const c of light) expect(vendor.has(c), `${m.id} light paints ${c}, which its vendor file does not`).toBe(true);
      for (const c of brand) expect(light.has(c), `${m.id} light keeps ${c}`).toBe(true);
      expect(m.handling.light, `${m.id} light`).toBe(brand.size === 0 ? "ink" : "brand");
      expect(/currentcolor/i.test(m.light), `${m.id} light inks only what the vendor inks`).toBe(vendorInks(spec));
      expect(m.handling.dark, `${m.id} dark`).not.toBe("light-tile");
      const hasBlack = [...brand].some(nearBlack);
      for (const c of brand) {
        if (nearBlack(c)) expect(dark.has(c), `${m.id} dark inks ${c}`).toBe(false);
        else if (!(nearWhite(c) && hasBlack)) expect(dark.has(c), `${m.id} dark keeps ${c}`).toBe(true);
      }
      if (m.dark !== undefined) expect(hasBlack, `${m.id} has a dark variant only to ink its black`).toBe(true);
    }
  });

  it("leaves a vendor colour out of the light mark only where the mark draws part of the vendor file in ink", () => {
    for (const [id, why] of Object.entries(DRAWS_PART_OF_VENDOR_FILE)) {
      const spec = GUARD_MARK_SPECS.find((s) => s.id === id);
      expect(spec?.extract?.fill, `${id}: ${why}`).toBe("currentColor");
      if (spec === undefined) continue;
      const light = paintedColours(GUARD_MARKS[id]?.light ?? "");
      expect([...vendorColours(spec)].filter((c) => !light.has(c)).length, `${id}: ${why}`).toBeGreaterThan(0);
    }
  });

  it("uses the vendor's colour file for multi-colour brands, and inks the black ones in dark", () => {
    for (const id of ["google-gemini", "mistral", "meta-ai", "hugging-face", "brave", "qwen", "microsoft-copilot", "google-chrome", "firefox", "microsoft-edge", "opera", "slack"]) {
      expect(GUARD_MARK_SPECS.find((s) => s.id === id)?.file, id).toMatch(/-color\.svg$|^vendor\//);
      expect(GUARD_MARKS[id]?.handling, id).toEqual({ light: "brand", dark: "brand" });
    }
    expect(GUARD_MARKS.claude?.light).toContain('fill="#D97757"');
    expect(GUARD_MARKS.claude?.dark).toBeUndefined();
    for (const id of ["openai", "github-copilot", "cursor", "grok", "notebooklm", "windsurf"]) {
      expect(GUARD_MARKS[id]?.handling.dark, id).toBe("ink");
      expect(GUARD_MARKS[id]?.dark ?? GUARD_MARKS[id]?.light, id).toContain("currentColor");
    }
  });

  it("writes markup that draws no text and loads nothing", () => {
    for (const m of Object.values(GUARD_MARKS)) {
      for (const svg of [m.light, m.dark ?? ""]) {
        expect(svg, m.id).not.toMatch(/<text\b|<image\b|<script\b|https?:\/\/(?!www\.w3\.org)/);
        expect(svg, m.id).not.toMatch(/\bid="(?!gmid_)/);
      }
    }
  });

  it("flags the wordmarks wide, and the Mac copies spell every arc's flags apart for CoreSVG", () => {
    expect(Object.values(GUARD_MARKS).filter((m) => m.wide === true).map((m) => m.id).sort()).toEqual(["jasper", "otter-ai"]);
    const arcs = readdirSync(MAC_MARKS)
      .filter((set) => set.endsWith(".imageset"))
      .flatMap((set) => ["light.svg", "dark.svg"].map((file) => path.join(MAC_MARKS, set, file)))
      .flatMap((file) => [...readFileSync(file, "utf8").matchAll(/\bd="([^"]*[Aa][^"]*)"/g)].map((m) => ({ file, d: m[1] ?? "" })));
    expect(arcs.length).toBeGreaterThan(0);
    for (const { file, d } of arcs) expect(arcFlagsSpelledApart(d), `${path.relative(REPO_ROOT, file)}: ${d.slice(0, 80)}`).toBe(true);
    const runOn = Object.values(GUARD_MARKS).flatMap((m) => [...m.light.matchAll(/\bd="([^"]*[Aa][^"]*)"/g)].map((x) => x[1] ?? ""));
    expect(runOn.some((d) => !arcFlagsSpelledApart(d))).toBe(true);
  });

  it("the Mac copies keep every path's numbers as the console copy writes them", () => {
    const sets = readdirSync(MAC_MARKS).filter((set) => set.endsWith(".imageset"));
    expect(sets.map((set) => set.replace(/^mark-|\.imageset$/g, "")).sort()).toEqual(Object.keys(GUARD_MARKS).sort());
    const pathData = (svg: string): string[] => [...svg.matchAll(/\bd="([^"]*)"/g)].map((x) => (x[1] ?? "").replace(/[\s,]+/g, ""));
    for (const m of Object.values(GUARD_MARKS)) {
      const consoleCopies = { "light.svg": m.light, "dark.svg": m.handling.dark === "light-tile" ? m.light : (m.dark ?? m.light) };
      for (const [file, svg] of Object.entries(consoleCopies)) {
        const mac = readFileSync(path.join(MAC_MARKS, `mark-${m.id}.imageset`, file), "utf8");
        expect(pathData(mac), `${m.id} ${file}`).toEqual(pathData(svg));
      }
    }
  });

  it("every generated surface is current with the vendored files (marks:check)", async () => {
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    const check = await runProcess(process.execPath, [tsx, path.join(PACKAGE_DIR, "scripts/build-marks.ts"), "--check"], { cwd: PACKAGE_DIR });
    expect(check.stderr).toBe("");
    expect(check.stdout).toContain("[marks] every output is current");
    expect(check.code).toBe(0);
  });

  it("resolves services and apps the way the agent and the Mac app do", () => {
    expect(markForService({ serviceId: "openai-chatgpt" }).mark?.id).toBe("openai");
    expect(markForService({ serviceId: "custom-acme" }).glyph).toBe("service");
    expect(markForService({ serviceId: "quillbot" }).glyph).toBe("service");
    expect(markForApp({ name: "Google Chrome", bundleId: "com.google.Chrome" }).mark?.id).toBe("google-chrome");
    expect(markForApp({ name: "Microsoft Edge" }).mark?.id).toBe("microsoft-edge");
    expect(markForApp({ bundleId: "com.todesktop.230313mzl4w4u92", name: "Cursor" }).mark?.id).toBe("cursor");
    expect(markForApp({ cli: "claude" }).mark?.id).toBe("claude");
    expect(markForApp({ name: "claude-cli" }).mark?.id).toBe("claude");
    expect(markForApp({ name: "Chromium (headless)" }).mark?.id).toBe("chromium");
    expect(markForApp({ bundleId: "com.apple.Terminal", name: "Terminal" }).glyph).toBe("cli");
    expect(markForApp({ name: "curl" }).glyph).toBe("cli");
    expect(markForApp({ name: "Some App" }).glyph).toBe("app");
    expect(markForApp(undefined).glyph).toBe("app");
  });

  it("makes an instance's ids unique", () => {
    const markup = markMarkup(GUARD_MARKS["amazon-q"]?.light ?? "", ":r1:");
    expect(markup).toContain('id="r1_0"');
    expect(markup).not.toContain("gmid_");
  });
});
