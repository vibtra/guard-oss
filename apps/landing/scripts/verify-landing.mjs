#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import http from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const LANDING = resolve(HERE, "..");
const ROOT = resolve(LANDING, "..", "..");
const DIST = join(LANDING, "dist");
const OUT = process.env.SHOTS || join(tmpdir(), "guard-landing-shots");

let pw;
try {
  const req = createRequire(join(LANDING, "package.json"));
  const mod = await import(pathToFileURL(req.resolve("playwright")).href);
  pw = mod.chromium ? mod : mod.default;
} catch (e) {
  console.error("verify:landing needs playwright, installed by apps/landing.\n" + String(e?.message ?? e));
  process.exit(2);
}

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".svg": "image/svg+xml", ".webp": "image/webp" };
const srv = http.createServer(async (req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  else if (p.startsWith("/landing/")) p = p.slice("/landing".length);
  else if (p === "/pricing") { res.writeHead(302, { location: "/#faq-pilot" }); res.end(); return; }
  else if (["/privacy", "/terms"].includes(p)) p += ".html";
  try { const b = await readFile(join(DIST, p)); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end(); }
});
const DEPLOYED = process.env.LANDING_URL;
if (!DEPLOYED) await new Promise((r) => srv.listen(0, r));
const BASE_URL = DEPLOYED ? DEPLOYED.replace(/\/?$/, "/") : `http://localhost:${srv.address().port}/`;
const get = BASE_URL.startsWith("https:") ? (await import("node:https")).get : http.get;
await mkdir(OUT, { recursive: true });

const fails = [];
const lines = [];
const fail = (id, why) => fails.push(`${id}: ${why}`);
const ok = (id, line) => lines.push(`${id}: ${line}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawnSync(process.execPath, [join(HERE, "chrome.mjs"), "--check"], { encoding: "utf8" });
if (chrome.status === 0) ok("C", "shared chrome current on 3 documents"); else fail("C", chrome.stdout + chrome.stderr);

const html = await readFile(join(DIST, "index.html"), "utf8");
for (const re of [/<title>Guard by Vibtra/, /name="description" content="Guard by Vibtra/, /property="og:title" content="Guard by Vibtra/, /name="twitter:title" content="Guard by Vibtra/, /property="og:image" content="https:\/\/vibtra\.app\/landing\/og\.png"/]) {
  if (!re.test(html)) fail("M", `index.html lacks ${re}`);
}
const boot = async (f) => (await readFile(join(LANDING, f), "utf8")).match(/<script>\s*\(function \(\) \{[\s\S]*?<\/script>/)?.[0];
const boots = await Promise.all(["index.html", "privacy.html", "terms.html"].map(boot));
if (!boots[0] || boots.some((b) => b !== boots[0])) fail("M", "the theme boot script differs between the three documents");
if (!fails.some((f) => f.startsWith("M"))) ok("M", "title, description, og and twitter name Guard by Vibtra; boot script identical in 3 documents");

const browser = await pw.chromium.launch({ channel: "chrome" }).catch(() => pw.chromium.launch());
const ORDER = ["nav", "hero", "trust", "stats", "controls", "how", "cta", "faq", "footer"];
const WIDTHS = { 1920: { nav: 67, root: 15, h1: 2 }, 1440: { nav: 67, root: 15, h1: 2 }, 1280: { nav: 63, root: 14, h1: 2 }, 768: { nav: 60, root: 12, h1: 2 }, 390: { nav: 70, root: 13.77, h1: 4 } };

for (const [w, want] of Object.entries(WIDTHS).map(([k, v]) => [Number(k), v])) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text()); });
  await page.goto(BASE_URL, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const m = await page.evaluate(() => {
    const h1 = document.querySelector(".hero-h1");
    return {
      order: [...document.querySelectorAll("[data-section]")].map((s) => s.dataset.section),
      root: parseFloat(getComputedStyle(document.documentElement).fontSize),
      nav: document.querySelector(".nv").getBoundingClientRect().height,
      h1: Math.round(h1.getBoundingClientRect().height / parseFloat(getComputedStyle(h1).lineHeight)),
      over: document.documentElement.scrollWidth > innerWidth,
      noAlt: document.querySelectorAll("img:not([alt])").length,
      tiny: [...document.querySelectorAll("body *")].filter((el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && el.getClientRects().length && getComputedStyle(el).visibility !== "hidden" && parseFloat(getComputedStyle(el).fontSize) < 11.95 && !el.closest("[aria-hidden=true], .mk, svg")).map((el) => `${el.className || el.tagName} ${parseFloat(getComputedStyle(el).fontSize).toFixed(1)}px`).slice(0, 5),
      text: document.querySelector("main").innerText,
      title: document.title,
      chipOut: window.innerWidth < 768 ? [] : [...document.querySelectorAll(".trust-r")].flatMap((r) => {
        const b = r.getBoundingClientRect();
        return [...r.querySelectorAll(".trust-chips li")].filter((li) => { const c = li.getBoundingClientRect(); return c.left < b.left - .5 || c.right > b.right + .5 || c.top < b.top - .5 || c.bottom > b.bottom + .5; }).map((li) => li.textContent);
      }),
    };
  });
  const id = `R@${w}`;
  if (w === 1440) {
    if (JSON.stringify(m.order) !== JSON.stringify(ORDER)) fail("S", `order ${m.order.join(",")}`); else ok("S", ORDER.join(" > "));
    if (/\$\d/.test(m.text)) fail("X", "a price appears in the home page copy");
    if (/—/.test(m.text + m.title)) fail("X", "an em dash appears in the home page copy or title");
    const g = await page.evaluate(() => ({
      text: document.body.textContent,
      pricingLinks: document.querySelectorAll('a[href*="pricing"]').length,
      mail: [...document.querySelectorAll('a[href^="mailto:"]')].map((a) => a.getAttribute("href")).filter((h) => !/^mailto:sam@vibtra\.app\?subject=/.test(h)),
      ctas: [...document.querySelectorAll(".hero .btn-acc, .nv-btn, .cta .btn-acc, .nv-sheet-btn")].map((a) => a.textContent.trim()),
    }));
    const BANNED = /\$\s?\d|\bpricing\b|\bper seat\b|free (plan|tier)|\bApache\b|\bAGPL\b|open[- ]source|self[- ]host|\blicen[cs]e[ds]?\b|\bWindows\b|\bworkbox|\bapp box/i;
    const hit = g.text.match(BANNED);
    if (hit) fail("G", `banned claim on the page: "${hit[0]}"`);
    if (g.pricingLinks) fail("G", `${g.pricingLinks} link(s) to /pricing`);
    if (g.mail.length) fail("G", `mailto not to sam@vibtra.app: ${g.mail[0]}`);
    if (g.ctas.length !== 4 || g.ctas.some((t) => t !== "Request a pilot")) fail("G", `calls to action ${JSON.stringify(g.ctas)}`);
    const ed = await page.evaluate(() => document.getElementById("faq-editions")?.textContent ?? "");
    const EDITION_SURFACES = ["Community Edition", "the Claude website", "Claude for macOS", "the ChatGPT website", "ChatGPT for macOS", "same day", "no limit on Macs, people or usage", "New apps and sites", "are paid"];
    const missing = EDITION_SURFACES.filter((t) => !ed.includes(t));
    if (missing.length) fail("E", `the editions row lacks ${JSON.stringify(missing)}`); else ok("E", "editions row names the Community Edition's four surfaces, same-day fixes, no limits and what is paid, with no price");
    if (!fails.some((f) => f.startsWith("G"))) ok("G", "no price, plan, licence, open-source, self-host or Windows claim; no /pricing link; every mailto to sam@vibtra.app; 4 x Request a pilot");
  }
  if (!near(m.root, want.root, .15)) fail(id, `root ${m.root} want ${want.root}`);
  if (!near(m.nav, want.nav, 4)) fail(id, `nav ${m.nav} want ${want.nav}`);
  if (m.h1 !== want.h1) fail(id, `h1 on ${m.h1} lines want ${want.h1}`);
  if (m.over) fail(id, "horizontal scroll");
  if (m.tiny.length) fail(id, `text under 12px: ${m.tiny.join("; ")}`);
  if (m.chipOut.length) fail(id, `trust chip outside its slot: ${m.chipOut.join(", ")}`);
  if (m.noAlt) fail(id, `${m.noAlt} <img> without alt`);
  if (errs.length) fail(id, `console: ${errs[0]}`);
  ok(id, `root ${m.root.toFixed(2)} nav ${Math.round(m.nav)} h1 ${m.h1} lines`);

  const box0 = await page.locator(".nv").boundingBox();
  await page.evaluate(() => scrollTo(0, 1500)); await sleep(150);
  const box1 = await page.locator(".nv").boundingBox();
  if (!near(box0.height, box1.height, .5) || box1.y !== 0) fail(`N@${w}`, `nav changed on scroll (${box0.height} -> ${box1.height}, y ${box1.y})`);
  await page.evaluate(() => scrollTo(0, 0)); await sleep(100);
  if (w >= 992) {
    await page.hover(".nv-trig"); await sleep(450);
    const open = await page.evaluate(() => { const d = document.querySelector(".nv-drop"); return d.dataset.open === "true" && getComputedStyle(d).opacity === "1"; });
    await page.hover('.nv-row-a[data-pv="2"]'); await sleep(300);
    const pv = await page.evaluate(() => document.querySelector('.nv-pv[data-on="true"]')?.dataset.pv);
    if (w === 1440) await page.screenshot({ path: join(OUT, "menu-1440.png") });
    await page.keyboard.press("Escape"); await sleep(350);
    const closed = await page.evaluate(() => document.querySelector(".nv-drop").dataset.open === "false");
    if (!open || pv !== "2" || !closed) fail(`N@${w}`, `dropdown open ${open} preview ${pv} closed ${closed}`); else ok(`N@${w}`, "one state; dropdown opens on hover, swaps preview, Escape closes");
    if (await page.locator(".nv-burger").isVisible()) fail(`N@${w}`, "burger visible on desktop");
  } else {
    await page.evaluate(() => window.scrollTo(0, 2000)); await sleep(200);
    await page.click(".nv-burger"); await sleep(550);
    const s = await page.evaluate(() => ({ open: document.querySelector(".nv-sheet").dataset.open, lock: document.documentElement.style.overflow, y: document.querySelector(".nv-sheet").getBoundingClientRect().top, head: document.querySelector("header.nv").getBoundingClientRect().bottom }));
    await page.click(".nv-acc"); await sleep(400);
    const acc = await page.evaluate(() => document.querySelector(".nv-acc-list").getBoundingClientRect().height);
    await page.screenshot({ path: join(OUT, `menu-${w}.png`) });
    await page.keyboard.press("Escape"); await sleep(450);
    const closed = await page.evaluate(() => document.querySelector(".nv-sheet").dataset.open === "false" && document.documentElement.style.overflow === "");
    await page.evaluate(() => window.scrollTo(0, 0));
    if (s.open !== "true" || s.lock !== "hidden" || Math.abs(s.y - s.head) > 1 || acc < 100 || !closed) fail(`N@${w}`, `sheet ${JSON.stringify(s)} accordion ${acc} closed ${closed}`); else ok(`N@${w}`, "one state; burger panel under the sticky header when scrolled, page lock, Product accordion, Escape closes");
  }

  await page.locator("label.bc-2").scrollIntoViewIfNeeded();
  await page.click("label.bc-2"); await sleep(450);
  const b = await page.evaluate(() => ({ bg: getComputedStyle(document.querySelector(".bc-2")).backgroundColor, card: getComputedStyle(document.querySelector(".bc-0")).backgroundColor, pill: getComputedStyle(document.querySelector('.bv-v[data-i="2"]')).opacity, win: !!document.querySelector('.bv-v[data-i="2"] .mui-blocked') }));
  if (b.bg === b.card || b.pill !== "1" || !b.win) fail(`B@${w}`, JSON.stringify(b)); else ok(`B@${w}`, "click whitens the card and shows its Mac window");

  const tabsShown = await page.locator(".tabs").isVisible();
  if (w < 480) { if (tabsShown) fail(`T@${w}`, "tab bar visible below 480"); else ok(`T@${w}`, "tab bar hidden"); }
  else {
    const y = await page.evaluate(() => document.getElementById("switches").getBoundingClientRect().top + scrollY - 160);
    await page.evaluate((v) => scrollTo(0, v), y); await sleep(250);
    const t = await page.evaluate(() => ({ cur: document.querySelector('.tab[aria-current="true"]')?.dataset.tab, top: document.querySelector(".tabs").getBoundingClientRect().top }));
    if (t.cur !== "switches" || t.top > 140) fail(`T@${w}`, JSON.stringify(t)); else ok(`T@${w}`, `sticky at ${Math.round(t.top)}px, current ${t.cur}`);
  }

  await page.locator("#faq-cover summary").click(); await sleep(450);
  if (!(await page.evaluate(() => document.getElementById("faq-cover").open))) fail(`F@${w}`, "row did not open"); else ok(`F@${w}`, "row opens");

  const gone = await page.evaluate(() => !document.querySelector("[data-player], .pip, #lightbox, #demo"));
  if (!gone) fail(`P@${w}`, "a walkthrough, pip or lightbox is still on the page"); else ok(`P@${w}`, "no walkthrough, pip or lightbox");

  await page.evaluate(() => scrollTo(0, 0)); await sleep(300);
  const h = await page.evaluate(() => {
    const r = (el) => { const b = el?.getBoundingClientRect(); return b ? { w: Math.round(b.width), h: Math.round(b.height) } : null; };
    const v = document.querySelector("[data-ard] .ard-video");
    const chips = [...document.querySelectorAll('[data-section="trust"] .trust-chips li')];
    return {
      frame: r(document.querySelector("[data-ard]")), screen: r(document.querySelector("[data-ard] .ard-screen")),
      src: v?.querySelector("source")?.getAttribute("src") ?? "", poster: !!v?.poster, paused: v?.paused,
      tabs: chips.map((li) => li.getAttribute("role") === "tab" && !!li.querySelector(".tm svg")),
      selected: chips.map((li) => li.getAttribute("aria-selected")).join(),
    };
  });
  const cut = w >= 992 ? /claude-web-w[-.]/ : w >= 600 ? /claude-web(-[A-Za-z0-9_]{8})?\.webm/ : /claude-web-m[-.]/;
  const geo = w !== 1440 || (Math.abs(h.frame.w - 1200) <= 2 && Math.abs(h.screen.w - 1140) <= 2 && Math.abs(h.screen.h - 493) <= 2);
  if (!cut.test(h.src) || !h.poster || !h.paused || h.tabs.length !== 4 || h.tabs.some((x) => !x) || h.selected !== "true,false,false,false" || !geo) fail(`H@${w}`, JSON.stringify({ ...h, cut: String(cut) }));
  else ok(`H@${w}`, `demo player ${h.screen.w}x${h.screen.h} (${h.src.split("/").pop()}), poster under reduced motion, 4 trust surfaces as tabs with marks`);
  await page.click('[data-section="trust"] .trust-chips li:nth-child(2)', { force: true }).catch(() => {});
  await sleep(300);
  const sw = await page.evaluate(() => ({ src: document.querySelector("[data-ard] .ard-video source")?.getAttribute("src") ?? "", sel: [...document.querySelectorAll('[data-section="trust"] .trust-chips li')].map((li) => li.getAttribute("aria-selected")).join() }));
  if (!sw.src.includes("chatgpt-web") || sw.sel !== "false,true,false,false") fail(`HS@${w}`, JSON.stringify(sw));
  else ok(`HS@${w}`, "clicking a covered surface plays its clip");

  const v = await page.evaluate(() => document.querySelectorAll('.mui-chrome, .mui-chat, .mui-composer, .mui-app-claude, .mui-app-chatgpt, [aria-label^="Google Chrome:"]').length);
  if (v) fail(`V@${w}`, `${v} browser or chat-app window element(s) on the page`); else ok(`V@${w}`, "no browser or chat-app window drawn");

  const a = await page.evaluate(() => {
    const GREEN = ["rgb(76, 192, 43)", "rgb(42, 117, 26)", "rgb(122, 216, 92)", "rgb(0, 163, 112)", "rgb(228, 238, 231)", "rgb(6, 159, 0)"];
    const greens = [...document.querySelectorAll("body *")].filter((el) => { const c = getComputedStyle(el); return [c.color, c.backgroundColor, c.borderTopColor, c.outlineColor].some((v) => GREEN.includes(v)); }).length;
    return {
      btn: getComputedStyle(document.querySelector(".hero .btn-acc")).backgroundColor,
      greens,
      chipsNoMark: [...document.querySelectorAll(".trust-chips li")].filter((li) => !li.querySelector(".tm svg")).length,
      src: [...document.querySelectorAll(".stats-row li")].map((li) => {
        const h = li.querySelector(".stat-src")?.getAttribute("href") ?? "";
        return h.startsWith("https://") || (h.startsWith("#faq-") && !!document.getElementById(h.slice(1)));
      }),
    };
  });
  if (a.btn !== "rgb(13, 13, 23)" || a.greens || a.chipsNoMark || a.src.length !== 3 || a.src.some((x) => !x)) fail(`A@${w}`, JSON.stringify(a));
  else ok(`A@${w}`, "accent black, no green, every trust chip has its mark, 3 sourced stats");

  await page.locator(".bento-head").scrollIntoViewIfNeeded(); await sleep(200);
  await page.click("label.bc-0"); await sleep(450);
  const k = await page.evaluate(() => {
    const m = document.querySelector(".bento-mark"), ink = m?.querySelector(".mark-ink");
    const mb = m?.getBoundingClientRect(), sb = ink?.getBoundingClientRect();
    const hit = mb ? document.elementFromPoint(mb.left + mb.width / 2, mb.top + mb.height * .85) : null;
    const v0 = document.querySelector('.bv-v[data-i="0"]');
    return {
      whole: !!(mb && sb && sb.height > 0 && Math.abs(sb.height - sb.width) < 1 && Math.abs(sb.height - mb.height) < 1 && getComputedStyle(m).overflow === "visible"),
      onTop: !!(hit && m.contains(hit)),
      shot: v0?.querySelector("img")?.getAttribute("src") ?? "", shown: v0 ? getComputedStyle(v0).opacity : "", overview: !!v0?.querySelector(".mui-desk"),
    };
  });
  if (!k.whole || !k.onTop || !/console-activity/.test(k.shot) || k.shown !== "1" || k.overview) fail(`K@${w}`, JSON.stringify(k));
  else ok(`K@${w}`, "bento mark whole and on top; See AI use shows the Activity render");

  const wv = await page.evaluate(() => {
    const p = document.querySelector(".cta-panel").getBoundingClientRect(), f = document.querySelector('[data-section="faq"]').getBoundingClientRect();
    return { gap: Math.round(f.top - p.bottom), left: Math.round(p.left), width: Math.round(p.width), vw: document.documentElement.clientWidth };
  });
  if (wv.gap !== 0 || wv.left !== 0 || wv.width !== wv.vw) fail(`W@${w}`, JSON.stringify(wv)); else ok(`W@${w}`, "CTA full bleed, straight into the FAQ");

  await page.screenshot({ path: join(OUT, `full-${w}.png`), fullPage: w >= 1280 });
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark", reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: "load" });
  const l = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, stored: (() => { try { return localStorage.getItem("theme"); } catch { return "x"; } })(), bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }));
  await page.click('.ftoggle [data-theme-set="dark"]'); await sleep(800);
  const d = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor }));
  await page.reload({ waitUntil: "load" });
  const kept = await page.evaluate(() => document.documentElement.dataset.theme);
  if (l.theme !== "light" || l.stored !== null || l.bg !== "rgb(255, 255, 255)" || /dark/.test(l.scheme) || d.theme !== "dark" || d.bg === l.bg || kept !== "dark") fail("L", JSON.stringify({ l, d, kept }));
  else ok("L", "system dark + no stored choice renders light; the toggle switches to dark and is remembered");
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: "load" });
  const measure = () => page.evaluate(() => {
    const cv = document.createElement("canvas"); cv.width = cv.height = 1; const cx = cv.getContext("2d", { willReadFrequently: true });
    const rgba = (c) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = "#000"; cx.fillStyle = c; cx.fillRect(0, 0, 1, 1); const [r, g, b] = cx.getImageData(0, 0, 1, 1).data; const a = (c.match(/\/\s*([\d.]+)\s*\)|rgba\([^)]*,\s*([\d.]+)\)/) || []).slice(1).find(Boolean); return [r, g, b, a === undefined ? 1 : +a]; };
    const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }; return .2126 * f(r) + .7152 * f(g) + .0722 * f(b); };
    const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = getComputedStyle(n).backgroundColor; const v = rgba(c); if (v[3] > .99 && !/transparent|rgba\(0, 0, 0, 0\)/.test(c)) return v; } return rgba(getComputedStyle(document.body).backgroundColor); };
    return [".micro", ".tab:not([aria-current=\"true\"])", ".honest"].map((sel) => {
      const el = document.querySelector(sel); if (!el) return { sel, ratio: 0 };
      const fg = rgba(getComputedStyle(el).color), bg = bgOf(el);
      const L1 = lum(fg), L2 = lum(bg);
      return { sel, ratio: Math.round(((Math.max(L1, L2) + .05) / (Math.min(L1, L2) + .05)) * 100) / 100 };
    });
  });
  const light = await measure();
  await page.click('.ftoggle [data-theme-set="dark"]'); await sleep(800);
  const dark = await measure();
  const low = [...light.map((x) => ({ ...x, theme: "light" })), ...dark.map((x) => ({ ...x, theme: "dark" }))].filter((x) => x.ratio < 4.5);
  if (low.length) fail("CC", JSON.stringify(low));
  else ok("CC", `small grey text >= 4.5:1 in both themes: light ${light.map((x) => x.ratio).join("/")}, dark ${dark.map((x) => x.ratio).join("/")}`);
  await ctx.close();
}

{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (msg) => { if (msg.type() === "error") errs.push(msg.text()); });
  await page.goto(BASE_URL, { waitUntil: "load" });
  await sleep(2500);
  const m = await page.evaluate(() => { const v = document.querySelector("[data-ard] .ard-video"); return { t: v.currentTime, paused: v.paused, src: v.currentSrc }; });
  if (m.paused || m.t <= 0.5 || !/claude-web-w[-.]/.test(m.src)) fail("HM@1440", JSON.stringify(m)); else ok("HM@1440", `the demo plays on its own (${m.t.toFixed(1)}s into the wide cut)`);
  const pauseShown = await page.locator(".ard-pause").isVisible();
  await page.click(".ard-pause"); await sleep(1200);
  const held = await page.evaluate(() => ({ paused: document.querySelector("[data-ard] .ard-video").paused, label: document.querySelector(".ard-pause").textContent.trim() }));
  await page.click(".ard-pause"); await sleep(600);
  const resumed = await page.evaluate(() => !document.querySelector("[data-ard] .ard-video").paused);
  if (!pauseShown || !held.paused || held.label !== "Play demo" || !resumed) fail("HP@1440", JSON.stringify({ pauseShown, held, resumed })); else ok("HP@1440", "Pause holds the demo, Play resumes it");
  const total = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < total; y += 500) { await page.evaluate((v) => scrollTo(0, v), y); await sleep(60); }
  await sleep(500);
  const rv = await page.evaluate(() => ({ on: document.documentElement.classList.contains("rv"), n: document.querySelectorAll("[data-rv]").length, hidden: document.querySelectorAll("[data-rv]:not(.rv-in)").length }));
  if (!rv.on || rv.n < 10 || rv.hidden) fail("RV@1440", JSON.stringify(rv)); else ok("RV@1440", `${rv.n} reveals, all shown after a scroll through`);
  if (errs.length) fail("HM@1440", `console: ${errs[0]}`);
  await ctx.close();
}
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(BASE_URL, { waitUntil: "load" });
  const r = await page.evaluate(() => ({ rv: document.documentElement.classList.contains("rv"), pause: !document.querySelector(".ard-pause").hidden }));
  if (r.rv || r.pause) fail("RV", JSON.stringify(r)); else ok("RV", "reduced motion: no reveal hides anything, posters and Play instead of Pause");
  await ctx.close();
}

{
  const r = await new Promise((res) => get(BASE_URL + "pricing", (x) => { res({ status: x.statusCode, loc: x.headers.location }); x.resume(); }));
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(BASE_URL + "pricing", { waitUntil: "load" }); await sleep(300);
  const open = await page.evaluate(() => document.getElementById("faq-pilot")?.open === true);
  if (r.status !== 302 || r.loc !== "/#faq-pilot" || !open) fail("G", `/pricing ${JSON.stringify(r)} pilot row open ${open}`); else ok("G", "/pricing answers 302 to /#faq-pilot, and the row opens");
  await page.close();
}
for (const path of ["privacy", "terms"]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(BASE_URL + path, { waitUntil: "load" });
  const has = await page.evaluate(() => !!document.querySelector("header.nv") && !!document.querySelector("footer.ft") && !!document.getElementById("main"));
  if (!has || errs.length) fail("X", `/${path}: chrome ${has} errors ${errs[0] ?? 0}`); else ok("X", `/${path} renders in the shared chrome`);
  await page.close();
}

await browser.close();
srv.close();
console.log(lines.join("\n"));
console.log(`shots: ${OUT}`);
if (fails.length) { console.error(`\nFAIL (${fails.length})\n` + fails.join("\n")); process.exit(1); }
console.log("\nverify:landing passed");
