#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MARKS } from "../src/marks/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

export const PILOT = "mailto:sam@vibtra.app?subject=Guard%2030-day%20pilot&amp;body=Hi%20Sam%2C%20we%27d%20like%20to%20discuss%20a%20Guard%20pilot.%0ACompany%3A%20%0AMac%20users%3A%20%0AAI%20tools%3A%20%0APolicy%20to%20test%3A%20";
export const DEMO = "mailto:sam@vibtra.app?subject=Guard%20demo";
export const CONTACT = "mailto:sam@vibtra.app?subject=Guard";

export const ICON = {
  see: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  rules: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6L12 3Z"/><path d="M8.5 12h7M8.5 15h4.5"/></svg>`,
  switches: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="6" rx="3"/><circle cx="18" cy="8" r="1.6"/><rect x="3" y="13" width="18" height="6" rx="3"/><circle cx="6" cy="16" r="1.6"/></svg>`,
  explain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z"/><path d="M12 8.5v3M12 13.4v.1"/></svg>`,
};
const caret = `<svg class="nv-caret" viewBox="0 0 10 10" aria-hidden="true"><path d="m2 3.5 3 3 3-3"/></svg>`;

export const PRODUCT = [
  ["see", "See AI use", "Services, apps and what was blocked."],
  ["rules", "Content rules", "Card numbers, TFNs and keys, stopped."],
  ["switches", "App and website switches", "Claude and ChatGPT, web and Mac."],
  ["explain", "Blocks that explain", "The rule, the reason, the next step."],
];

const PREVIEW = {
  see: "nav-activity.webp",
  rules: "nav-rules-content.webp",
  switches: "nav-switches.webp",
  explain: "nav-block-detail.webp",
};
const preview = (id) => `<img src="/renders/${PREVIEW[id]}" width="880" height="880" alt="" loading="lazy" decoding="async" />`;

const ftMark = (id) => MARKS[id].svg.replace(/\bid="([^"]+)"/g, `id="$1-ft-${id}"`).replace(/url\(#([^)]+)\)/g, `url(#$1-ft-${id})`);
const COVERED = [["claude", "Claude"], ["openai", "ChatGPT"], ["codex", "Codex"], ["google-chrome", "Google Chrome"]];

const header = ({ home, faq }) => `<a class="skip" href="#main">Skip to content</a>
<header data-section="nav" class="nv" data-sheet="false">
  <div class="nv-bg" aria-hidden="true"></div>
  <div class="ct nv-row">
    <a class="nv-logo" href="${home}#top" aria-label="Guard by Vibtra, home">
      <span class="mark-ink" aria-hidden="true"></span>
      <span class="nv-word" aria-hidden="true"><b>Guard</b><small>by Vibtra</small></span>
    </a>
    <nav class="nv-menu" aria-label="Main">
      <ul class="nv-links">
        <li class="nv-dd">
          <button class="nv-link nv-trig" type="button" aria-expanded="false" aria-controls="nv-drop">Product${caret}</button>
          <div class="nv-drop" id="nv-drop" data-open="false">
            <div class="nv-drop-in">
              <ul class="nv-rows">
${PRODUCT.map(([id, t, d], i) => `                <li><a class="nv-row-a" href="${home}#${id}" data-pv="${i}"><span class="nv-ic">${ICON[id]}</span><span class="nv-rt">${t}</span><span class="nv-rd">${d}</span></a></li>`).join("\n")}
              </ul>
              <div class="nv-prev" aria-hidden="true">
${PRODUCT.map(([id], i) => `                <div class="nv-pv" data-pv="${i}"${i === 0 ? ' data-on="true"' : ""}>${preview(id)}</div>`).join("\n")}
              </div>
            </div>
          </div>
        </li>
        <li><a class="nv-link" href="${home}#how">How it works</a></li>
        <li><a class="nv-link" href="${faq}">FAQ</a></li>
      </ul>
    </nav>
    <div class="nv-cta">
      <a class="nv-text" href="/login">Sign in</a>
      <a class="btn-acc nv-btn" href="${PILOT}">Request a pilot</a>
    </div>
    <button class="nv-burger" type="button" aria-expanded="false" aria-controls="nv-sheet"><span class="nv-bars" aria-hidden="true"><i></i><i></i><i></i></span><span class="sr-only">Menu</span></button>
  </div>
  <div class="nv-sheet" id="nv-sheet" data-open="false">
    <div class="ct">
      <ul class="nv-sheet-list">
        <li>
          <button class="nv-sheet-item nv-acc" type="button" aria-expanded="false" aria-controls="nv-acc-list">Product${caret}</button>
          <ul class="nv-acc-list" id="nv-acc-list">
${PRODUCT.map(([id, t, d]) => `            <li><a class="nv-acc-a" href="${home}#${id}"><span class="nv-ic">${ICON[id]}</span><span class="nv-rt">${t}</span><span class="nv-rd">${d}</span></a></li>`).join("\n")}
          </ul>
        </li>
        <li><a class="nv-sheet-item" href="${home}#how">How it works</a></li>
        <li><a class="nv-sheet-item" href="${faq}">FAQ</a></li>
        <li><a class="nv-sheet-item" href="/login">Sign in</a></li>
      </ul>
      <a class="nv-sheet-btn" href="${PILOT}">Request a pilot</a>
    </div>
  </div>
  <div class="nv-veil" aria-hidden="true"></div>
</header>`;

const footer = ({ home, faq }) => `<footer data-section="footer" class="ft" data-surface="dark">
  <div class="ct">
    <div class="ft-row">
      <div class="ft-col ft-brand">
        <a class="ft-logo" href="${home}#top" aria-label="Guard by Vibtra, home">
          <span class="mark-ink" aria-hidden="true"></span>
          <span class="nv-word" aria-hidden="true"><b>Guard</b><small>by Vibtra</small></span>
        </a>
        <p class="ft-cover-h">Verified live, 22 October 2026</p>
        <ul class="ft-cover">
${COVERED.map(([id, name]) => `          <li><span class="ft-mk" aria-hidden="true">${ftMark(id)}</span>${name}</li>`).join("\n")}
        </ul>
      </div>
      <div class="ft-col">
        <h3>Product</h3>
        <ul>
${PRODUCT.map(([id, t]) => `          <li><a href="${home}#${id}">${id === "switches" ? "Switches" : t}</a></li>`).join("\n")}
        </ul>
      </div>
      <div class="ft-col">
        <h3>Company</h3>
        <ul>
          <li><a href="${faq}">FAQ</a></li>
          <li><a href="${CONTACT}">Contact</a></li>
          <li><a href="/login">Sign in</a></li>
          <li><a href="${PILOT}">Request a pilot</a></li>
          <li><a href="${DEMO}">Book a demo</a></li>
        </ul>
      </div>
      <div class="ft-col">
        <h3>Legal</h3>
        <ul>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/terms">Terms</a></li>
          <li><a href="${home}#notices">Trademarks</a></li>
        </ul>
      </div>
    </div>
    <div class="ft-rule" aria-hidden="true"></div>
    <div class="ft-bottom">
      <div class="ft-legal" id="notices">
        <p>&copy; 2026 Vibtra · sam@vibtra.app · Guard is in closed pilots on macOS.</p>
        <p>Vendor marks and names identify the apps and sites Guard recognises. They remain their owners&rsquo; trademarks and imply no endorsement or affiliation.</p>
        <p>Nothing on this page is a security certification.</p>
      </div>
      <div class="ft-side">
        <ul class="ft-pills">
          <li><span class="ft-pill-k">Platform</span><span class="ft-pill">macOS</span></li>
          <li><span class="ft-pill-k">Policy</span><span class="ft-pill">signed ES256</span></li>
        </ul>
        <div class="ft-theme" role="group" aria-label="Theme">
          <span class="ftoggle">
            <button type="button" data-theme-set="light" aria-label="Light mode"><svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="2.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M6 0v1.6M6 10.4V12M0 6h1.6M10.4 6H12M1.8 1.8l1.1 1.1M9.1 9.1l1.1 1.1M10.2 1.8L9.1 2.9M2.9 9.1l-1.1 1.1" stroke="currentColor" stroke-width="1.1"/></svg></button>
            <button type="button" data-theme-set="dark" aria-label="Dark mode"><svg width="14" height="14" viewBox="0 0 12 12" aria-hidden="true"><path d="M10 7.5A4.7 4.7 0 114.5 2a3.8 3.8 0 105.5 5.5z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg></button>
          </span>
        </div>
      </div>
    </div>
  </div>
</footer>`;

const PAGES = {
  "index.html": { home: "", faq: "#faq" },
  "privacy.html": { home: "/", faq: "/#faq" },
  "terms.html": { home: "/", faq: "/#faq" },
};

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const [file, opts] of Object.entries(PAGES)) {
    const path = join(root, file);
    const before = readFileSync(path, "utf8");
    let after = before;
    for (const [name, make] of [["header", header], ["footer", footer]]) {
      const re = new RegExp(`(<!-- chrome:${name} -->)[\\s\\S]*?(<!-- /chrome:${name} -->)`);
      if (!re.test(after)) { console.error(`${file}: no chrome:${name} markers`); process.exit(2); }
      after = after.replace(re, () => `<!-- chrome:${name} -->\n${make(opts)}\n<!-- /chrome:${name} -->`);
    }
    if (after !== before) {
      stale++;
      if (!check) writeFileSync(path, after);
    }
    console.log(`${file}: ${after === before ? "up to date" : check ? "STALE" : "written"}`);
  }
  if (check && stale) process.exit(1);
}
