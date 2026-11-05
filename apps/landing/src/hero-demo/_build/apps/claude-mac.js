import { markSvg } from "../../../marks/index.js";

export const CM_PROMPT = "Tighten this incident summary for the customer status page.";
export const CM_TOAST = "This isn’t working right now. You can try again later.";
export const CM_GREETING = "Good afternoon, Alex";
const HISTORY = ["Q4 hiring plan draft", "Refactor billing webhook retries", "Summarise vendor security review", "Board update for October", "SQL for 90-day churn cohort", "Rewrite onboarding email", "Pricing page copy ideas", "Explain SOC 2 CC6 controls", "Postmortem: checkout outage", "Quarterly OKR review notes", "Kubernetes cost breakdown", "Draft RFC for feature flags", "Customer FAQ for API limits", "Interview loop scorecard", "Data retention policy outline", "Release notes for 3.2"];
const ROW_TITLE = "Draft a two-sentence welcome n…";

export const CM_GEOM = {
  sidebarRight: 288,
  composer: { x: 447, y: 340, w: 674, h: 113 },
  editor: { x: 468, y: 356, w: 640, h: 50 },
  send: { x: 1080, y: 412, w: 28, h: 28 },
  toast: { x: 903, y: 719, w: 362, h: 66 },
  greeting: { x: 575, y: 262, w: 415, h: 39 },
  newRow: { x: 8, y: 271, w: 268, h: 32 },
  chatComposer: { x: 399, y: 715, w: 770, h: 46 },
  bubble: { x: 727, y: 82, w: 425, h: 44 },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ico = (cls, x, y, w, h, body, extra = "") => `<svg class="cm-i ${cls}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px${extra}" viewBox="0 0 ${w} ${h}" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const IC = {
  plus: (x, y, s = 13) => ico("plus", x, y, s, s, `<path d="M${s / 2} .65V${s - 0.65}M.65 ${s / 2}H${s - 0.65}" stroke-width="1.3"/>`),
  search: (x, y) => ico("", x, y, 15, 15, '<circle cx="6.55" cy="6.55" r="5.9" stroke-width="1.3"/><path d="m10.9 10.9 3.45 3.45" stroke-width="1.3"/>'),
  projects: (x, y) => ico("", x, y, 15, 17, '<path d="M4.3.65h6.4M2.4 3.15h10.2" stroke-width="1.3"/><path d="M1.3 6.4a1.05 1.05 0 0 1 1.05-1.05h10.3a1.05 1.05 0 0 1 1.05 1.05l-.75 7.6a2.4 2.4 0 0 1-2.4 2.35H4.45a2.4 2.4 0 0 1-2.4-2.35Z" stroke-width="1.3"/>'),
  artifacts: (x, y) => ico("", x, y, 17, 16.5, '<path d="M6.4 3.8 7.05 2.3A1.7 1.7 0 0 1 9 1.05l5.4 1.35a1.7 1.7 0 0 1 1.25 2.05l-1.5 6.9a1.7 1.7 0 0 1-1.95 1.3" stroke-width="1.3"/><rect x="1.4" y="4.3" width="8.6" height="11.1" rx="1.7" transform="rotate(8 5.7 9.85)" stroke-width="1.3"/>'),
  code: (x, y) => ico("", x, y, 16, 14, '<path d="M4.3 3.4.75 7l3.55 3.6M11.7 3.4 15.25 7l-3.55 3.6M9.3.75 6.7 13.25" stroke-width="1.3"/>'),
  brief: (x, y) => ico("", x, y, 17, 15, '<rect x=".65" y="3.9" width="15.7" height="10.45" rx="2.1" stroke-width="1.3"/><path d="M5.6 3.9V2.1A1.45 1.45 0 0 1 7.05.65h2.9a1.45 1.45 0 0 1 1.45 1.45v1.8" stroke-width="1.3"/>'),
  tri: (x, y) => `<svg class="cm-i" style="left:${x}px;top:${y}px;width:7px;height:5px" viewBox="0 0 7 5"><path d="M.2.3h6.6L3.5 4.8Z" fill="currentColor"/></svg>`,
  filter: (x, y) => ico("", x, y, 12, 11, '<path d="M.65.65h10.7M2.65 5.5h6.7M4.4 10.35h3.2" stroke-width="1.3"/>'),
  ring: (x, y) => ico("cm-ring", x, y, 6, 6, '<circle cx="3" cy="3" r="2.5" stroke-width="1"/>'),
  hchev: (x, y, w, h, left, sw = 1.4) => ico("", x, y, w, h, left ? `<path d="M${w - sw / 2} ${sw / 2} ${sw / 2} ${h / 2} ${w - sw / 2} ${h - sw / 2}" stroke-width="${sw}"/>` : `<path d="M${sw / 2} ${sw / 2} ${w - sw / 2} ${h / 2} ${sw / 2} ${h - sw / 2}" stroke-width="${sw}"/>`),
  chev: (x, y, w, h, sw = 1.3) => ico("", x, y, w, h, `<path d="M${sw / 2} ${sw / 2} ${w / 2} ${h - sw / 2} ${w - sw / 2} ${sw / 2}" stroke-width="${sw}"/>`),
  device: (x, y) => ico("", x, y, 17, 15, '<path d="M10.2 10.85H2.6A1.95 1.95 0 0 1 .65 8.9V2.6A1.95 1.95 0 0 1 2.6.65h9.5a1.95 1.95 0 0 1 1.95 1.95v1.9" stroke-width="1.3"/><path d="M4.4 10.85v2.35M2.9 13.85h5.8" stroke-width="1.3"/><rect x="11.4" y="6.1" width="4.95" height="8.25" rx="1.4" stroke-width="1.3"/><path d="M13.85 8.1v.2" stroke-width="1.3"/>'),
  ghost: (x, y) => ico("", x, y, 15, 15, '<path d="M.75 14.25V6.7a6.75 6.75 0 0 1 13.5 0v7.55l-2.25-1.5-2.25 1.5-2.25-1.5-2.25 1.5-2.25-1.5Z" stroke-width="1.4"/><circle cx="5.2" cy="7.2" r=".9" fill="currentColor" stroke="none"/><circle cx="9.8" cy="7.2" r=".9" fill="currentColor" stroke="none"/>'),
  mic: (x, y, cls = "") => ico(cls, x, y, 15, 16.5, '<rect x="4.4" y=".65" width="6.2" height="9.6" rx="3.1" stroke-width="1.3"/><path d="M.75 7.6a6.75 6.75 0 0 0 13.5 0M7.5 14.35v1.5" stroke-width="1.3"/>'),
  wave: (x, y) => ico("", x, y, 15, 14, '<path d="M7.5.65v12.7M4.4 3.6v6.8M10.6 3.6v6.8M.75 6.4v1.2M14.25 6.4v1.2" stroke-width="1.3"/>'),
  share: (x, y) => ico("", x, y, 14.5, 14, '<path d="M7.25 9.3V.75M4 3.9 7.25.65 10.5 3.9M.75 8.4v2.85a2.1 2.1 0 0 0 2.1 2.1h8.8a2.1 2.1 0 0 0 2.1-2.1V8.4" stroke-width="1.25"/>'),
  warn: (x, y) => ico("cm-warn", x, y, 16, 14, '<path d="M6.75 1.45a1.45 1.45 0 0 1 2.5 0l6 10.35a1.45 1.45 0 0 1-1.25 2.15H2a1.45 1.45 0 0 1-1.25-2.15Z" stroke-width="1.3"/><path d="M8 5v3.4" stroke-width="1.4"/><circle cx="8" cy="10.75" r=".8" fill="currentColor" stroke="none"/>'),
  x: (x, y) => ico("", x, y, 11, 11, '<path d="m.65.65 9.7 9.7m0-9.7-9.7 9.7" stroke-width="1.3"/>'),
  side: (x, y, cls = "") => ico(cls, x, y, 16, 14, '<rect x=".65" y=".65" width="14.7" height="12.7" rx="2.6" stroke-width="1.3"/><path d="M3.9 3.9v6.2" stroke-width="1.3"/>'),
  chatbub: (x, y) => ico("", x, y, 16, 16, '<path d="M8.4 13.1H6.9A5.95 5.95 0 1 1 12.85 7" stroke-width="1.3"/><path d="M6.9 13.1.9 14.9l1.3-3.4" stroke-width="1.3"/><circle cx="12" cy="11.6" r="2.75" stroke-width="1.3"/><path d="m14 13.6 1.25 1.25" stroke-width="1.3"/>'),
};

const NAV_WEB = [["plus", "New"], ["search", "Search"], ["projects", "Projects"], ["artifacts", "Artifacts"], ["code", "Code"], ["brief", "Customize"]];
const NAV_MAC = NAV_WEB.filter((n) => n[0] !== "code");
const NAV_IC = {
  plus: (cy) => IC.plus(19.25, cy - 6.75), search: (cy) => IC.search(18.25, cy - 7.75), projects: (cy) => IC.projects(18.25, cy - 8.75),
  artifacts: (cy) => IC.artifacts(17.25, cy - 8.75), code: (cy) => IC.code(18, cy - 7), brief: (cy) => IC.brief(17.25, cy - 7.75),
};

function titleStrip(st) {
  if (st.shell === "web")
    return `${IC.side(18, 15, "cm-tog")}<span class="cm-wm">Claude</span>`;
  return `<span class="cm-lights"><i></i><i></i><i></i></span>${IC.side(88, 14, "cm-tog")}`
    + IC.hchev(121, 16, 6, 10, true).replace('class="cm-i ', 'class="cm-i cm-off ')
    + IC.hchev(148, 16, 6, 10, false).replace('class="cm-i ', 'class="cm-i cm-off ')
    + `<span class="cm-seg"><b>${IC.chatbub(7, 6)}</b><span>${IC.code(6.5, 7)}</span></span>`;
}

function sidebar(st) {
  const web = st.shell === "web", nav = web ? NAV_WEB : NAV_MAC;
  const navTop = 49, pitch = 34;
  let h = `<aside class="cm-sb">${titleStrip(st)}`;
  nav.forEach(([ic, label], i) => {
    const y = navTop + i * pitch, cy = y + 16;
    h += `<div class="cm-nav${ic === "plus" && st.newSel ? " sel" : ""}" style="top:${y}px"></div>${NAV_IC[ic](cy)}<span class="cm-t cm-navt" style="top:${y}px">${label}</span>`;
  });
  const secY = navTop + nav.length * pitch + 18;
  h += `<span class="cm-t cm-sec" style="top:${secY}px">${web ? "Chats and tasks" : "Chats"}</span>${IC.tri(web ? 126.5 : 68.5, secY + 14)}${IC.filter(254, secY + 10.5)}`;
  const rows = [...(st.newRow ? [{ title: ROW_TITLE, sel: st.newRow === "sel", op: st.newRowOp }] : []), ...HISTORY.map((title) => ({ title }))];
  const rowTop = secY + 34;
  h += `<div class="cm-rows" style="top:${rowTop}px">`;
  rows.forEach((r, i) => {
    const y = i * pitch;
    if (y > 751 - rowTop) return;
    h += `<div class="cm-row${r.sel ? " sel" : ""}" style="top:${y}px${r.op != null && r.op < 1 ? `;opacity:${r.op.toFixed(3)}` : ""}"></div>`
      + IC.ring(23, y + 13) + `<span class="cm-t cm-rowt" style="top:${y}px">${esc(r.title)}</span>`;
  });
  h += `</div><i class="cm-thumb"></i>`;
  h += `<div class="cm-foot"><span class="cm-av">AM</span><span class="cm-t cm-nm">Alex Morgan</span><span class="cm-t cm-pl">· Team</span></div>${IC.chev(176, 774, 7, 4, 1.2).replace('class="cm-i ', 'class="cm-i cm-mute ')}${IC.device(254.25, 768.25)}`;
  return h + `</aside>`;
}

function composerNew(st) {
  const txt = st.text ? `<span class="cm-tx">${esc(st.text)}</span>` : st.btn === "spin" ? "" : `<span class="cm-ph">How can I help you today?</span>`;
  const caret = st.caret ? '<i class="cm-caret"></i>' : "";
  const ed = st.text ? `${txt}${caret}` : `${caret}${txt}`;
  let btn = "";
  if (st.btn === "voice" || st.btn === "voiceFade") btn = IC.wave(1086.5, 419).replace('class="cm-i ', `class="cm-i${st.btn === "voiceFade" ? " cm-fade" : ""} `);
  else if (st.btn === "none") btn = "";
  else if (st.btn === "spin") btn = `<span class="cm-send" style="left:1080px;top:412px"><svg viewBox="0 0 28 28" class="cm-spin"><circle cx="14" cy="14" r="5.6" fill="none" stroke="rgba(255,255,255,.42)" stroke-width="1.3"/><path d="M14 8.4a5.6 5.6 0 0 1 4.6 2.4" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" transform="rotate(${(st.spinA || 0).toFixed(1)} 14 14)"/></svg></span>`;
  else btn = `<span class="cm-send" style="left:1080.75px;top:412px"><svg viewBox="0 0 28 28"><path d="M13.75 19.6V8.4M9.2 12.75l4.55-4.55 4.55 4.55" fill="none" stroke="#fff" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
  return `<div class="cm-comp"></div><div class="cm-ed">${ed}</div>${IC.plus(467.25, 419.25)}`
    + (st.shell === "web" ? `<span class="cm-modes"><b class="cm-t">Chat</b><span class="cm-t">Cowork</span></span>` : "")
    + `<span class="cm-t cm-model">Sonnet 5.5</span><span class="cm-t cm-eff">Medium</span>`
    + IC.mic(1034.25, 417.25, st.btn === "spin" ? "cm-dim" : "") + IC.chev(1062.25, 424.25, 5, 3, 1.1).replace('class="cm-i ', 'class="cm-i cm-mute ') + btn;
}

function mainNew(st) {
  const greet = st.greet === false ? "" : `<div class="cm-greet"><span class="cm-mk">${markSvg("claude")}</span><span>${CM_GREETING}</span></div>`;
  return `${IC.ghost(1250.25, 14.5)}${greet}${composerNew(st)}`;
}

function mainChat(st) {
  const c = st.chat || {};
  const bub = `<div class="cm-bub" style="opacity:${(c.bubOp ?? 1).toFixed(3)};transform:translateY(${(c.bubDy ?? 0).toFixed(2)}px) scale(${(c.bubS ?? 1).toFixed(4)})"><span class="cm-t">${esc(CM_PROMPT)}</span></div>`;
  if (c.fly) return `${IC.ghost(1250.25, 14.5)}${bub}${composerNew(st)}`;
  return `<div class="cm-hd"><span class="cm-t cm-hdt">${ROW_TITLE}</span>${IC.chev(546.75, 18.75, 10, 6, 1.3)}${IC.share(1203.5, 15).replace('class="cm-i ', 'class="cm-i cm-grey ')}<span class="cm-t cm-shr">Share</span></div>`
    + `${bub}<i class="cm-dot"></i>`
    + `<div class="cm-ccomp"></div>${IC.plus(415.5, 731.5)}<div class="cm-ced"><i class="cm-caret"></i><span class="cm-ph">Write a message...</span></div>`
    + IC.mic(1086.5, 729.5) + IC.chev(1114.5, 736.5, 5, 3, 1.1).replace('class="cm-i ', 'class="cm-i cm-mute ') + '<i class="cm-stop"></i>'
    + `<div class="cm-disc" style="opacity:${(c.discOp ?? 1).toFixed(3)}"><span class="cm-t cm-dl">Claude is AI and can make mistakes. Please double-check responses.</span><span class="cm-t cm-dm">Sonnet 5.5</span><span class="cm-t cm-de">Medium</span></div>`;
}

function toast(tt) {
  if (!tt || tt.op <= 0) return "";
  return `<div class="cm-toast" style="opacity:${tt.op.toFixed(3)};transform:translateY(${(tt.dy || 0).toFixed(2)}px)${tt.s != null && tt.s !== 1 ? ` scale(${tt.s.toFixed(4)})` : ""}">${IC.warn(18, 15)}<p class="cm-t">${CM_TOAST}</p>${IC.x(330.25, 16.25)}</div>`;
}

export function claudeMacHTML(st) {
  const main = st.page === "chat" ? mainChat(st) : mainNew(st);
  return `<div class="cm${st.shell === "web" ? " web" : ""}">${sidebar(st)}<main class="cm-main">${main}${(st.toasts || []).map(toast).join("")}</main></div>`;
}

export const CM_EVENTS = { focus: 1.205, typeA: 1.509, typeB: 4.591, send: 5.294, push: 10.858 };
export const CM_TIMING = {
  clear: 0.036,
  fly: 0.053,
  bubble: 0.2,
  chat: 0.167,
  disc: 0.17,
  back: 0.256,
  rowGone: 0.294,
  toast: 0.28,
  toastIn: 0.17,
  restore: 0.372,
  btnOn: 0.4,
  toastOut: 0.11,
};
export const CM_TIMING_PUSH = {
  clear: 0.016, fly: 0.024, bubble: 0.14, chat: 0.118, disc: 0.12, back: 0.193, rowGone: 0.207,
  toast: 0.2, toastIn: 0.13, restore: 0.245, btnOn: 0.326, toastOut: 0.11,
};

export const CM_TYPED = [[0.027,1],[0.09,2],[0.138,3],[0.189,4],[0.24,5],[0.354,7],[0.455,9],[0.508,10],[0.571,11],[0.638,12],[0.7,13],[0.772,14],[0.828,15],[0.873,16],[0.965,17],[1.004,18],[1.054,19],[1.099,20],[1.207,22],[1.244,23],[1.308,24],[1.375,25],[1.42,26],[1.471,27],[1.52,28],[1.624,30],[1.691,31],[1.764,32],[1.823,33],[1.931,35],[1.989,36],[2.055,37],[2.189,39],[2.32,41],[2.364,42],[2.43,43],[2.503,45],[2.613,46],[2.672,47],[2.739,48],[2.781,49],[2.844,50],[2.923,51],[2.981,52],[3.056,53]];
const CM_TYPED_SPAN = 3.082;
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const easeOut = (x) => 1 - Math.pow(1 - clamp01(x), 3);

export function claudeMacAt(t, ev = {}, opts = {}) {
  const e = { ...CM_EVENTS, ...ev };
  const T1 = { ...CM_TIMING, ...(opts.timing || {}) }, T2 = { ...CM_TIMING_PUSH, ...(opts.timingPush || {}) };
  const sends = (e.sends || [e.send, e.push]).filter((s) => s != null && isFinite(s)).sort((a, b) => a - b);
  const st = { shell: opts.shell || "mac", page: "new", text: "", caret: false, btn: "voice", newSel: true, newRow: null, greet: true, toasts: [] };
  const blink = (t0) => Math.floor(Math.max(0, t - t0) / 0.5) % 2 === 0;
  if (t >= e.focus) {
    const u = (t - e.typeA) * (CM_TYPED_SPAN / (e.typeB - e.typeA));
    let n = 0; for (const [kt, kn] of CM_TYPED) if (u >= kt - 1e-6) n = kn;
    n = Math.round(n * CM_PROMPT.length / CM_TYPED.at(-1)[1]);
    st.text = t < e.typeA ? "" : CM_PROMPT.slice(0, n);
    st.caret = t < e.typeA ? blink(e.focus) : t < e.typeB ? true : blink(e.typeB);
  }
  st.btn = st.text ? "send" : "voice";
  let li = -1;
  sends.forEach((s, i) => { if (t >= s) li = i; });
  sends.forEach((s, i) => {
    const D = i ? T2 : T1, t0 = s + D.toast; if (t < t0) return;
    const p = clamp01((t - t0) / D.toastIn), k = 1 - (1 - p) * (1 - p);
    const ts = { op: Math.min(1, (t - t0) / 0.012), dy: (1 - k) * 36, s: 1 };
    const next = sends[i + 1];
    if (next != null && t >= next) { const q = clamp01((t - next) / (T2.toastOut)); ts.op *= 1 - q; ts.s = 1 - 0.12 * q; }
    if (ts.op > 0) st.toasts.push(ts);
  });
  if (li < 0) return st;
  const last = sends[li], D = li ? T2 : T1, k = t - last;
  const bubble = (k) => { const p = clamp01((k - D.fly) / D.bubble), q = easeOut(p); return { bubOp: 0.27 + 0.73 * p, bubS: 0.947 + 0.053 * q, bubDy: 3.5 * (1 - q) }; };
  if (k < D.clear) return st;
  st.text = ""; st.btn = "spin"; st.spinA = (k * 360 / 0.8) % 360; st.caret = true;
  if (k < D.fly) return st;
  if (k < D.chat) {
    st.page = "chat"; st.newRow = "sel"; st.newSel = false; st.greet = false;
    st.chat = { fly: true, ...bubble(k) };
    return st;
  }
  if (k < D.back) {
    st.page = "chat"; st.newRow = "sel"; st.newSel = false;
    st.chat = { ...bubble(k), discOp: clamp01((k - D.chat) / D.disc) };
    return st;
  }
  st.btn = "voice"; st.caret = true;
  if (k < D.rowGone) { st.newRow = "on"; return st; }
  if (k < D.restore) return st;
  st.text = CM_PROMPT; st.caret = blink(last + D.restore);
  st.btn = k < D.restore + 0.004 ? "voiceFade" : k < D.btnOn ? "none" : "send";
  return st;
}
