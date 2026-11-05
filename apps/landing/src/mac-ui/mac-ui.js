import { markSvg, markIdFor } from "../marks/index.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const px = (n) => (typeof n === "number" ? `${n}px` : n);
const sz = (w, h) => [w != null ? `width:${px(w)}` : "", h != null ? `height:${px(h)}` : ""].filter(Boolean).join(";");

const S = (vb, inner, extra = "") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${inner}</svg>`;
const SHIELD = "M12 1.6 20.6 4.8v6.4c0 5.6-3.6 9.9-8.6 11.3C7 21.1 3.4 16.8 3.4 11.2V4.8Z";
export const glyph = {
  xmarkShield: (c = "var(--mui-red)") => `<svg class="mui-sym" viewBox="0 0 24 24" aria-hidden="true"><path d="${SHIELD}" fill="${c}"/><path d="m9 9 6 6m0-6-6 6" stroke="#fff" stroke-width="2.1" stroke-linecap="round"/></svg>`,
  handShield: (c = "var(--mui-orange)") => `<svg class="mui-sym" viewBox="0 0 24 24" aria-hidden="true"><path d="${SHIELD}" fill="${c}"/><path d="M9.5 15.5v-5m2-1.5v6m2-5.5v5.5m2-3.5v3c0 1.5-1.2 2.5-3 2.5s-3.5-1-4-2.5l-.7-2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>`,
  checkShield: (c = "var(--mui-green)") => `<svg class="mui-sym" viewBox="0 0 24 24" aria-hidden="true"><path d="${SHIELD}" fill="${c}"/><path d="m8.2 12.2 2.7 2.7 5-5.4" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`,
  shieldHalf: () => S("0 0 24 24", `<path d="${SHIELD}"/><path d="M12 1.6v20.9c-5-1.4-8.6-5.7-8.6-11.3V4.8Z" fill="currentColor" stroke="none"/>`),
  waveform: () => S("0 0 24 24", `<path d="M2 12h3l2.5-7 4 14 3.5-10 2 3h5"/>`),
  checklist: () => S("0 0 24 24", `<path d="m3 6 1.6 1.6L7.5 4.6M3 15l1.6 1.6 2.9-3M11 6.5h10M11 15.5h10"/>`),
  sliders: () => S("0 0 24 24", `<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="15" cy="6" r="1.8" fill="#fff"/><circle cx="8" cy="12" r="1.8" fill="#fff"/><circle cx="17" cy="18" r="1.8" fill="#fff"/>`),
  checkCircle: () => S("0 0 24 24", `<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.8 2.7L16.2 9.6"/>`),
  hand: () => S("0 0 24 24", `<path d="M8 13V6.5a1.5 1.5 0 0 1 3 0V12m0-7a1.5 1.5 0 0 1 3 0v7m0-5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.6 7-6.5 7-2.6 0-4.3-1.3-5.5-3.6L3.4 14a1.5 1.5 0 0 1 2.6-1.5L8 15"/>`),
  personQuestion: () => S("0 0 24 24", `<circle cx="10" cy="12" r="8.5"/><circle cx="10" cy="10" r="3"/><path d="M4.6 18.2c1.4-2 3.2-3 5.4-3s4 1 5.4 3"/><circle cx="18.5" cy="6" r="4.6" fill="currentColor" stroke="none"/><path d="M17.2 5c.2-.8.8-1.2 1.4-1.2.8 0 1.4.5 1.4 1.2 0 .9-1.2 1-1.4 1.8M18.6 8.6v.1" stroke="#fff" stroke-width="1.2"/>`),
  sidebar: () => S("0 0 24 24", `<rect x="2.5" y="4" width="19" height="16" rx="3.5"/><path d="M9 4v16M5 8h1.5M5 11h1.5"/>`),
  refresh: () => S("0 0 24 24", `<path d="M20 12a8 8 0 1 1-2.4-5.7M20 4v4.5h-4.5"/>`),
  window: () => S("0 0 24 24", `<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M3 9h18"/>`),
  globe: () => S("0 0 24 24", `<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.6 2.6 3.8 5.6 3.8 9s-1.2 6.4-3.8 9c-2.6-2.6-3.8-5.6-3.8-9S9.4 5.6 12 3Z"/>`),
  terminal: () => S("0 0 24 24", `<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="m7 9.5 3 2.5-3 2.5M12 15h5"/>`),
  lock: () => S("0 0 24 24", `<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>`),
  dots: () => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>`,
  x: () => S("0 0 24 24", `<path d="M6 6l12 12M18 6 6 18"/>`, 'stroke-width="2.4"'),
  plus: () => S("0 0 24 24", `<path d="M12 4v16M4 12h16"/>`, 'stroke-width="2.2"'),
  up: () => S("0 0 24 24", `<path d="M12 19V5m-6 6 6-6 6 6"/>`, 'stroke-width="2.4"'),
  macwindow: () => S("0 0 24 24", `<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M3 9h18M6 6.8h.01M8.4 6.8h.01"/>`),
  key: () => S("0 0 24 24", `<circle cx="8" cy="12" r="4"/><path d="M12 12h9m-3 0v3m-3-3v2"/>`),
  seal: () => S("0 0 24 24", `<path d="m12 2.8 2.3 1.7 2.8-.2.9 2.7 2.3 1.6-.9 2.7.9 2.7-2.3 1.6-.9 2.7-2.8-.2L12 21.2l-2.3-1.7-2.8.2-.9-2.7-2.3-1.6.9-2.7-.9-2.7L6 8.6l.9-2.7 2.8.2Z"/><path d="m8.8 12.2 2.2 2.1 4.2-4.4"/>`),
  stop: () => S("0 0 24 24", `<circle cx="12" cy="12" r="9"/><rect x="9" y="9" width="6" height="6" rx="1"/>`),
  doc: () => S("0 0 24 24", `<path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>`),
  power: () => S("0 0 24 24", `<path d="M12 3v8M7 6.5a7 7 0 1 0 10 0"/>`),
};

export const vibtraMark = () => `<svg viewBox="0 0 64 64" aria-hidden="true"><path fill="currentColor" d="M14.15 0.09L19.98 0.16L21.48 0.53L22.86 1.03L24.36 1.91L25.49 2.79L26.93 4.35L28.05 6.11L28.56 7.23L29.18 9.74L29.31 18.76L29.43 18.88L29.68 20.88L30.43 23.01L31.94 25.64L33.82 28.15L37.01 31.22L39.64 32.97L41.77 33.97L43.77 34.6L45.4 34.72L45.53 34.85L54.29 34.85L56.55 35.35L59.43 36.85L61.5 38.79L62.25 39.8L63.37 42.05L64 45.06L64 53.95L63.37 56.7L62.37 58.71L61.37 60.09L59.18 62.03L56.8 63.28L55.67 63.66L54.29 63.78L54.17 63.91L44.27 63.91L44.15 63.78L42.77 63.66L41.27 63.15L39.77 62.4L37.57 60.59L36.45 59.21L35.44 57.46L34.69 54.83L34.69 41.55L34.57 40.92L34.07 39.17L33.06 37.04L31.69 35.04L29.75 32.97L26.86 30.84L25.11 29.96L22.98 29.34L22.11 29.34L21.98 29.21L9.46 29.34L7.58 28.96L5.32 27.96L4.57 27.46L1.88 24.77L0.75 22.76L0.25 21.26L0.13 20.01L0 19.88L0 10.24L0.13 10.11L0.25 8.74L0.88 6.86L1.63 5.48L2.63 4.1L4.2 2.54L5.82 1.41L7.45 0.66L9.46 0.16ZM44.09 0.22L54.54 0.16L56.17 0.53L58.43 1.53L59.55 2.29L61.5 4.23L62.75 6.11L63.62 8.36L63.87 9.49L63.87 10.36L64 10.49L64 19.51L63.87 19.63L63.87 20.38L63.25 22.51L62 24.77L60.05 26.83L58.93 27.71L56.55 28.84L54.54 29.34L44.02 29.34L43.9 29.21L43.27 29.21L40.77 28.34L38.64 26.96L37.32 25.64L35.95 23.64L35.19 21.89L34.69 19.51L34.69 10.99L34.82 10.86L34.82 9.36L35.44 7.11L36.95 4.48L38.51 2.79L39.64 1.91L41.14 1.03L42.9 0.41ZM9.77 34.79L19.35 34.72L21.23 35.1L22.73 35.6L24.49 36.6L26.68 38.54L28.05 40.55L28.56 41.55L29.31 44.81L29.31 54.2L29.18 54.32L29.06 55.7L28.05 58.21L26.93 59.84L25.24 61.53L23.98 62.4L22.48 63.15L19.48 63.91L9.71 63.91L7.83 63.53L5.45 62.53L3.57 61.15L1.75 59.08L0.75 57.33L0 54.7L0 44.31L0.75 41.55L2.25 39.05L4.2 37.1L5.45 36.23L6.95 35.48L8.95 34.85Z"/></svg>`;

export function markTile(nameOrId, size = 18, fallback = "globe") {
  const id = markSvg(nameOrId) ? nameOrId : markIdFor(nameOrId);
  const svg = id ? markSvg(id) : "";
  const style = `width:${size}px;height:${size}px;border-radius:${size / 4}px`;
  if (svg) return `<span class="mui-tile" style="${style}">${svg}</span>`;
  return `<span class="mui-tile is-glyph" style="${style}">${(glyph[fallback] || glyph.globe)()}</span>`;
}

export function macWindow({ title = "", body = "", width, height, active = true, toolbar = false, bare = false, titlebarExtra = "", leading = "", className = "", label } = {}) {
  const cls = ["mui", "mui-window", active ? "" : "is-inactive", toolbar ? "" : "is-plain", className].filter(Boolean).join(" ");
  const bar = ["mui-titlebar", toolbar ? "is-toolbar" : "", bare ? "is-bare" : ""].filter(Boolean).join(" ");
  return `<div class="${cls}" style="${sz(width, height)}" role="img" aria-label="${esc(label ?? title)}">`
    + `<div class="${bar}"><span class="mui-lights"><i></i><i></i><i></i></span>${leading}`
    + `<span class="mui-title">${esc(title)}</span>${titlebarExtra}</div>`
    + `<div class="mui-body">${body}</div></div>`;
}

const MATCH_WORDS = { "au-tfn": "a tax file number", "au-abn": "an ABN", "au-acn": "an ACN", "au-medicare": "a Medicare number", "card-number": "a card number", secret: "a secret or API key", "email-bulk": "many email addresses", "phone-bulk": "many phone numbers", keyword: "a blocked keyword", "file-type": "a blocked file type" };

export function blockedWindow({ service = "ChatGPT", rule = "Surface block: chatgpt-web", ruleName, matchType, matchCount, example, app = "com.google.Chrome.helper", asked = false, active = false, width = 460, requestAccess = false } = {}) {
  const headline = ruleName && matchType
    ? `Your organisation's rule “${ruleName}” stops this from being sent to ${service}.`
    : `Your organisation does not allow ${service} on this Mac.`;
  const fact = (k, v, mark = "") => `<div class="mui-fact"><span class="mui-fact-k">${esc(k)}</span>${mark}<span class="mui-fact-v">${esc(v)}</span></div>`;
  const found = matchType ? fact("Found", `${MATCH_WORDS[matchType] ?? matchType}${matchCount ? ` · ${matchCount} occurrence(s)` : ""}`) : "";
  const body = `<div class="mui-blocked-head">${asked ? glyph.handShield() : glyph.xmarkShield()}<div>`
    + `<div class="mui-blocked-title">${asked ? "This needs IT's OK" : "Blocked"}</div>`
    + `<div class="mui-blocked-line">${esc(headline)}</div></div></div>`
    + `<div class="mui-facts-wrap"><div class="mui-facts">`
    + fact("Service", service, markTile(service, 18, "globe"))
    + fact("Rule", ruleName ?? rule)
    + found
    + (example ? fact("Example", example) : "")
    + (app ? fact("App", app, markTile(app, 18, "macwindow")) : "")
    + `</div><span class="mui-link">Open the full details</span></div>`
    + (requestAccess ? `<div class="mui-req"><div style="font-size:12px;font-weight:500;margin-bottom:8px">Why you need it (optional)</div><div style="height:22px;border-radius:6px;box-shadow:inset 0 0 0 0.5px rgba(0,0,0,.2);background:#fff;padding:3px 7px;font-size:13px;color:var(--mui-tertiary)">IT sees this line</div></div>` : "")
    + `<div class="mui-blocked-foot"><span class="mui-btn">Close</span>${requestAccess ? `<span class="mui-btn is-primary">Request access</span>` : ""}</div>`;
  return macWindow({ title: asked ? "Needs IT's OK" : "Blocked by Vibtra Guard", body, width, active, className: "mui-blocked", label: `Vibtra Guard: ${asked ? "needs IT's OK" : "blocked"}. ${headline}` });
}

export function guardDesktop({ allowed = 14, blocked = 0, asked = 0, org = "acme.example", email = "ada@acme.example", monitor = false, details = {}, width = 860, height = 640, active = true } = {}) {
  const panes = [["Overview", glyph.shieldHalf], ["Activity", glyph.waveform], ["Rules", glyph.checklist], ["Setup", glyph.sliders]];
  const d = { network: "On: AI sites go through Guard", tls: "ClientHello replay · client ALPN", cert: "Trusted on this Mac", policy: "Version 3 · 7 content rules", sync: "10 seconds ago", ...details };
  const metric = (icon, color, n, k) => `<div class="mui-group mui-metric"><span style="color:${color}">${icon()}</span><div class="mui-metric-n">${esc(Number(n).toLocaleString("en-AU"))}</div><div class="mui-metric-k">${esc(k)}</div></div>`;
  const row = (k, v) => `<div class="mui-detail-row"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
  const side = `<aside class="mui-side"><div class="mui-side-brand">${vibtraMark()}<span>Vibtra<br>Guard</span></div>`
    + `<nav class="mui-nav">${panes.map(([n, g], i) => `<div class="mui-nav-item${i === 0 ? " is-on" : ""}">${g()}<span>${n}</span></div>`).join("")}</nav>`
    + `<div class="mui-side-foot"><div class="mui-side-org">${esc(org)}</div><div class="mui-side-mail">${esc(email)}</div></div></aside>`;
  const detail = `<section class="mui-detail"><div class="mui-h1">Overview</div><div class="mui-sub">AI use and protection on this Mac.</div><div class="mui-rule"></div>`
    + `<div class="mui-stack">`
    + `<div class="mui-group mui-status">${glyph.checkShield()}<div><div class="mui-status-title">${monitor ? "Monitoring AI use" : "Network protection is on"}</div>`
    + `<div class="mui-status-text">${monitor ? "Monitor mode records what rules would block. Requests continue to the AI service." : "Guard applies your organisation's service and content rules to traffic routed through this agent."}</div>`
    + `<span class="mui-btn">Review setup</span></div></div>`
    + `<div class="mui-h2">Today on this agent</div>`
    + `<div class="mui-metrics" style="margin-top:-10px">${metric(glyph.checkCircle, "var(--mui-green)", allowed, "Allowed / observed")}${metric(glyph.hand, "var(--mui-orange)", blocked, monitor ? "Would block" : "Blocked")}${metric(glyph.personQuestion, "var(--mui-blue)", asked, monitor ? "Would ask" : "Needs approval")}</div>`
    + `<div><div class="mui-group-label">Protection details</div><div class="mui-group mui-details">${row("Network protection", d.network)}${row("Upstream TLS", d.tls)}${row("Certificate trust", d.cert)}${row("Policy", d.policy)}${row("Last sync", d.sync)}</div></div>`
    + `<div class="mui-desk-foot"><span class="mui-caption">Counts are decisions since this agent started today. Repeated page requests may be grouped.</span><span class="mui-btn">View activity</span></div>`
    + `</div></section>`;
  return macWindow({
    title: "Vibtra Guard", toolbar: true, width, height, active, className: "mui-desk",
    leading: `<span class="mui-tool" style="margin-left:14px">${glyph.sidebar()}</span>`,
    titlebarExtra: `<span class="mui-tool" style="margin-left:auto">${glyph.refresh()}</span>`,
    body: side + detail,
    label: `Vibtra Guard window: network protection is on; today ${allowed} allowed, ${blocked} blocked, ${asked} need approval`,
  });
}

export function menuBarPanel({ person = "Ada Lovelace · ada@acme.example", org = "Acme", sync = "just now", allowed = 14, blocked = 2, asked = 0, mode = "enforce", pid = 4127 } = {}) {
  const r = (k, v) => `<div class="mui-fact"><span class="mui-fact-k">${esc(k)}</span><span class="mui-fact-v">${esc(v)}</span></div>`;
  const c = (k, n, tint) => `<div class="mui-count" style="background:${tint}"><b>${esc(n)}</b><span>${esc(k)}</span></div>`;
  const m = (g, t, dim) => `<div${dim ? ' style="opacity:.35"' : ""}>${g()}<span>${esc(t)}</span></div>`;
  return `<div class="mui mui-panel" role="img" aria-label="Vibtra Guard menu-bar panel">`
    + `<div class="mui-panel-head">${vibtraMark()}<div class="mui-grow"><div class="mui-h2">Vibtra Guard</div><div class="mui-caption">agent running (pid ${esc(pid)})</div></div><span class="mui-pill"${mode === "enforce" ? "" : ' style="background:rgba(0,0,0,.08)"'}>${mode === "enforce" ? "Enforce" : "Monitor"}</span></div>`
    + `<div class="mui-sep"></div><div class="mui-panel-rows">${r("Person", person)}${r("Organisation", org)}${r("Last sync", sync)}${r("Network extension", "On: AI sites go through Guard")}</div>`
    + `<div class="mui-counts">${c("Allowed", allowed, "rgba(52,199,89,.08)")}${c("Blocked", blocked, "rgba(255,56,60,.08)")}${c("Asked", asked, "rgba(255,141,40,.08)")}</div>`
    + `<div class="mui-sep"></div><div class="mui-menu">${m(glyph.macwindow, "Open Vibtra Guard")}${m(glyph.key, "Enrol…")}${m(glyph.seal, "Trust the Guard certificate")}${m(glyph.terminal, "Trust for command-line tools…")}${m(glyph.stop, "Stop agent")}${m(glyph.hand, "Open block page", !blocked)}${m(glyph.doc, "Open agent log")}<div class="mui-sep" style="margin:4px 0;padding:0"></div>${m(glyph.power, "Quit Vibtra Guard")}</div></div>`;
}
