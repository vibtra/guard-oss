import { blockedWindow, vibtraMark } from "../../mac-ui/mac-ui.js";
import { markSvg } from "../../marks/index.js";
import { claudeWebHTML, claudeWebAt } from "./apps/claude-web.js";
import { chatgptWebHTML, chatgptWebAt } from "./apps/chatgpt-web.js";
import { claudeMacHTML, claudeMacAt } from "./apps/claude-mac.js";

const S = 0.8375;
let GUARD = { left: 640, top: 214, width: 380 }, GS = 1;

const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const lerp = (a, b, k) => a + (b - a) * k;
function track(keys, t) {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 0; i < keys.length - 1; i++) {
    const [t0, a] = keys[i], [t1, b] = keys[i + 1];
    if (t <= t1) { const k = ease((t - t0) / (t1 - t0 || 1)); const o = {}; for (const n in a) o[n] = lerp(a[n], b[n], k); return o; }
  }
  return keys[keys.length - 1][1];
}
const I = {
  back: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M13 8H3m4.5-4.5L3 8l4.5 4.5"/></svg>',
  fwd: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8h10M8.5 3.5 13 8l-4.5 4.5"/></svg>',
  reload: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3"/></svg>',
  tune: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M2.5 5h6m3 0h2M2.5 11h2m3 0h6"/><circle cx="10" cy="5" r="1.6"/><circle cx="6" cy="11" r="1.6"/></svg>',
  star: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="m8 2 1.8 3.8 4.2.5-3.1 2.9.8 4.1L8 11.3 4.3 13.3l.8-4.1L2 6.3l4.2-.5Z"/></svg>',
  puzzle: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M3 5h3V3.6a1.4 1.4 0 0 1 2.8 0V5H12v3h-1.4a1.4 1.4 0 0 0 0 2.8H12V13H3z"/></svg>',
  kebab: '<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="3.5" r="1.3"/><circle cx="8" cy="8" r="1.3"/><circle cx="8" cy="12.5" r="1.3"/></svg>',
  x: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="m5 5 6 6m0-6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M8 3v10M3 8h10"/></svg>',
  side: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.5" y="4" width="15" height="12" rx="2.5"/><path d="M7.5 4v12"/></svg>',
  wifi: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M1.8 6.2a9 9 0 0 1 12.4 0M4 8.6a6 6 0 0 1 8 0M6.2 11a3 3 0 0 1 3.6 0"/><circle cx="8" cy="13.2" r=".9" fill="currentColor"/></svg>',
  cc: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="3" width="13" height="4" rx="2"/><circle cx="12.5" cy="5" r="1.2" fill="currentColor"/><rect x="1.5" y="9" width="13" height="4" rx="2"/><circle cx="3.5" cy="11" r="1.2" fill="currentColor"/></svg>',
  pencil: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 16h3l8.5-8.5-3-3L4 13z"/></svg>',
  folder: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M2 4.5h4l1.3 1.5H14v6.5H2z"/></svg>',
  hand: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M7 10V4.8a1.2 1.2 0 0 1 2.4 0V9.5m0-.3V3.8a1.2 1.2 0 0 1 2.4 0V9.5m0-.5V5a1.2 1.2 0 0 1 2.4 0v6.5c0 3-2 5-5 5-2.3 0-3.6-1.2-4.6-3L3.3 10.4a1.2 1.2 0 0 1 2-1.3L7 11"/></svg>',
  mic: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="7.5" y="3" width="5" height="9" rx="2.5"/><path d="M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v2.5"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
  up: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3.5M4 7.5l4-4 4 4"/></svg>',
  stop: '<svg viewBox="0 0 16 16" fill="currentColor"><rect x="4.5" y="4.5" width="7" height="7" rx="1.5"/></svg>',
  term: '<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4.5c4.6 0 7.4 2.6 8.6 5.6 3.4.4 6.9 3.3 6.9 8 0 2-.6 3.6-1.6 4.9 1 1.3 1.6 3 1.6 4.8 0 4.7-3.5 7.6-6.9 8-1.2 3-4 5.7-8.6 5.7s-7.4-2.6-8.6-5.7c-3.4-.4-6.9-3.3-6.9-8 0-1.9.6-3.5 1.6-4.8-1-1.3-1.6-3-1.6-4.9 0-4.7 3.5-7.6 6.9-8C12.6 7.1 15.4 4.5 20 4.5Z"/><path d="m14.5 16.5 4 3.5-4 3.5M21 24h5"/></svg>',
  alert: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="10" cy="10" r="7.5"/><path d="M10 6v4.5l2.5 1.5"/></svg>',
  pointer: '<svg viewBox="0 0 22 30"><path d="M2 2v22.5l5.6-5.2 3.8 8.6 3.6-1.6-3.7-8.4H19Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>',
};

const menu = (app, items) => `<div class="mb"><span class="mb-apple"></span><span class="mb-app">${app}</span>${items.map((m) => `<span class="mb-m">${m}</span>`).join("")}`
  + `<span class="mb-r"><span class="mb-guard">${vibtraMark()}</span>${I.wifi}${I.cc}<span>Thu 22 Oct&nbsp; 11:15 pm</span></span></div>`;

function chromeWindow({ title, url, mark, w }) {
  return `<div class="aw" id="win" style="left:${(1280 - w) / 2}px;top:38px;width:${w}px;height:${78 + 670}px">`
    + `<div class="cr-tabs"><span class="lights"><i></i><i></i><i></i></span><div class="cr-tab"><span class="fav">${markSvg(mark)}</span><span class="tt">${title}</span><span class="x">${I.x}</span></div><span class="cr-plus">${I.plus}</span></div>`
    + `<div class="cr-bar"><span class="cr-ic">${I.back}</span><span class="cr-ic off">${I.fwd}</span><span class="cr-ic">${I.reload}</span><div class="cr-omni">${I.tune}<span>${url}</span><span style="flex:1"></span>${I.star}</div><span class="cr-ic">${I.puzzle}</span><span class="cr-ic">${I.kebab}</span></div>`
    + `<div class="content" id="content" style="top:78px;width:${w}px;height:670px">${APPROOT}</div></div>`;
}
const APPROOT = `<div id="approot" style="position:absolute;left:0;top:0;width:1280px;height:800px;transform:scale(${S});transform-origin:0 0"></div>`;
function nativeWindow(inner, titlebar) {
  return `<div class="aw" id="win" style="left:104px;top:77px;width:1072px;height:670px">`
    + `<div class="content" id="content" style="top:0;width:1072px;height:670px">${inner}</div>${titlebar}</div>`;
}

const CLIPS = {
  "claude-web": {
    label: "Claude website", kind: "cw", app: "Google Chrome",
    menus: ["File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab", "Window", "Help"],
    chrome: { title: "Claude", url: "claude.ai/new", mark: "claude" },
    dur: 11.5,
    ev: { typeA: 0.6, typeB: 3.3, send: 4.2, push: 8.1 },
    derive: (e) => ({ err: e.send + 0.283, err2: e.push + 0.208 }),
    guard: { service: "Claude", ruleName: "Tax file numbers", matchType: "au-tfn", matchCount: 1, example: "123***782", app: "com.google.Chrome.helper" },
    zoomType: [840, 396], typeZ: 1.35, endStd: [[652, 400], 1.12], endWide: [[672, 520], 1],
    cues: (e) => [
      [0, "Claude in Chrome. A tax file number goes into the prompt."],
      [e.send, "Send. Guard's content rule stops it on the Mac, and its window names the rule."],
      [e.err + 1.5, "Claude shows its own error. Guard's window stays up with the rule."],
      [e.push - 0.4, "Send again, within 10 seconds: blocked again. One Guard notice, no popup storm."],
    ],
  },
  "chatgpt-web": {
    label: "ChatGPT website", kind: "gw", app: "Google Chrome",
    menus: ["File", "Edit", "View", "History", "Bookmarks", "Profiles", "Tab", "Window", "Help"],
    chrome: { title: "ChatGPT", url: "chatgpt.com", mark: "openai" },
    dur: 14.8,
    ev: { focus: 0.25, typeA: 0.5, typeB: 2.95, send: 3.85, retry: 8.1, push: 10.8 },
    derive: (e) => ({ err: e.send + 0.585, newchat: e.retry + 0.237, err2: e.push + 0.084 }),
    guard: { service: "ChatGPT", rule: "Surface block: chatgpt-web", app: "com.google.Chrome.helper" },
    zoomType: [867, 362], typeZ: 1.45, zoomEnd: [867, 260],
    cues: (e) => [
      [0, "ChatGPT in Chrome. The admin has switched the ChatGPT website off."],
      [e.send, "Send. Guard refuses it on the Mac, and its window names the switch that blocked it."],
      [e.err + 1.5, "ChatGPT shows the refusal as an error in the chat."],
      [e.retry - 0.3, "Retry puts the prompt back."],
      [e.push - 0.3, "Sent again a few seconds later: blocked again, new decision id, a fresh Guard notice."],
    ],
  },
  "claude-mac": {
    label: "Claude for Mac", kind: "cm", app: "Claude",
    menus: ["File", "Edit", "View", "Window", "Help"],
    dur: 10.6,
    ev: { focus: 0.3, typeA: 0.6, typeB: 2.9, send: 3.8, push: 7.9 },
    derive: (e) => ({ err: e.send + 0.28, err2: e.push + 0.2 }),
    guard: { service: "Claude", rule: "Surface block: claude-macos", app: "com.anthropic.claudefordesktop.helper" },
    zoomType: [840, 396], typeZ: 1.35, endStd: [[652, 400], 1.12], endWide: [[672, 520], 1],
    cues: (e) => [
      [0, "Claude for Mac. The admin has switched the Mac app off."],
      [e.send, "Send. Guard stops it before it reaches Anthropic, and its window says why."],
      [e.err + 1.5, "Claude shows its own error in the chat."],
      [e.push - 0.4, "Send again, within 10 seconds: blocked again. Still one Guard notice."],
    ],
  },
  "chatgpt-mac": {
    label: "ChatGPT for Mac + Codex", kind: "codex", app: "ChatGPT",
    menus: ["File", "Edit", "View", "Window", "Help"],
    dur: 11.8,
    ev: { typeA: 0.4, typeB: 2.2, send: 3.0, err: 5.6, close: 6.9, paste: 7.6, push: 8.2, err2: 10.8 },
    guard: { service: "Codex", ruleName: "Payment card numbers", matchType: "card-number", matchCount: 1, example: "4111***1111", app: "codex" },
    cues: (e) => [
      [0, "ChatGPT for Mac in Codex mode. A card number goes into the prompt."],
      [e.send, "Send. Guard's content rule blocks it on the Mac, and its window names the rule."],
      [e.send + 2.0, "Codex retries by itself, then prints Guard's 403. One Guard notice for the whole burst."],
      [e.paste, "Pasted and sent again: blocked again. No second popup."],
    ],
  },
};

const PROMPT_CX = "Debug the failed refund in ticket #4821, card 4111 1111 1111 1111";
const ERR = (gev) => `unexpected status 403 Forbidden: {"action":"block","blockPage":"<a>http://127.0.0.1:9471/blocked/${gev}</a>","code":"GUARD_BLOCKED","eventId":"${gev}","message":"Guard stopped this request under your organisation's AI policy.","requestsEnabled":true,"ruleId":"gcr_9611cc94","service":"openai-codex"}, url: <a>https://chatgpt.com/backend-api/codex/responses</a>`;

let C, guardEl, cursorEl, camEl, appEl, closeXY, pt;

const CX_SB = 330, CX_MID = CX_SB + (1280 - CX_SB) / 2;
const CX_RECENTS = ["Fix flaky checkout test", "Add rate limiting to /api/orders", "Migrate auth to OAuth 2.1", "Clean up structured logging", "Bump Node to 22.23.4"];
const CX_TITLE = "Add test card to billing fixture";
const CXI = {
  compose: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7.2 2.8H4.3a1.6 1.6 0 0 0-1.6 1.6v7.3a1.6 1.6 0 0 0 1.6 1.6h7.3a1.6 1.6 0 0 0 1.6-1.6V8.8"/><path d="M12.3 2.3a1.2 1.2 0 0 1 1.7 1.7L8.6 9.4l-2.2.5.5-2.2z"/></svg>',
  bell: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.2 11.2V7.3a3.8 3.8 0 0 1 7.6 0v3.9l1 1.2H3.2z"/><path d="M6.6 13.6a1.5 1.5 0 0 0 2.8 0"/></svg>',
  search: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="7.2" cy="7.2" r="4.3"/><path d="m10.4 10.4 3 3"/></svg>',
  chev: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 6.5 3.5 3.5 3.5-3.5"/></svg>',
  err: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 4.9v3.6"/><circle cx="8" cy="11" r=".55" fill="currentColor"/></svg>',
  radio: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1"><circle cx="8" cy="8" r="6.2"/></svg>',
  lin: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.4" fill="#222"/><path d="M3.3 9.9 6.1 12.7M3 7.6l5.4 5.4M4 5.2l6.8 6.8M5.9 3.8l6.3 6.3" stroke="#fff" stroke-width=".9"/></svg>',
};
function codexChrome(st) {
  const sent = st.bubbles.length > 0, err = sent && st.bubbles.some((b) => b.err);
  const rows = (sent ? [CX_TITLE, ...CX_RECENTS] : CX_RECENTS).map((r, i) =>
    `<div class="cx-sb-row${sent && i === 0 ? " sel" : ""}"><span>${r.replace(/&/g, "&amp;")}</span>${sent && i === 0 && err ? `<i class="cx-sb-err">${CXI.err}</i>` : ""}</div>`).join("");
  return `<div class="cx-tb"><span class="cx-lights"><i></i><i></i><i></i></span><span class="cx-tbi" style="left:106px">${I.back}</span><span class="cx-tbi off" style="left:142px">${I.fwd}</span><span class="cx-tbi" style="left:177px">${I.side}</span>${sent ? `<span class="cx-tbt">${CX_TITLE}</span>` : ""}</div>`
    + `<div class="cx-sb"><div class="cx-sb-hd"><b>Codex</b>${CXI.chev}<span class="grow"></span>${CXI.bell}${CXI.search}</div>`
    + `<div class="cx-sb-new">${CXI.compose}<span>New chat</span></div>`
    + `<div class="cx-sb-sec">Projects</div><div class="cx-sb-none">No projects</div>`
    + `<div class="cx-sb-sec">Recents</div>${rows}`
    + `<div class="cx-gs"><div class="cx-gs-hd"><b>Getting started</b><span>0 of 3</span></div><div class="cx-gs-bar"></div>`
    + `<div class="cx-gs-it">${CXI.radio}<span>Enable notifications</span></div><div class="cx-gs-it">${CXI.radio}<span>Catch me up on Linear</span><span class="grow"></span>${CXI.lin}</div><div class="cx-gs-it">${CXI.radio}<span>Try In-App Browser</span></div></div></div>`;
}
function codexHTML(st) {
  const comp =`<div class="cx-col cx-proj">${I.folder}<span>Choose project</span></div>`
    + `<div class="cx-col cx-comp"><div class="cx-text${st.text ? "" : " ph"}">${st.text ? st.text.replace(/&/g, "&amp;").replace(/</g, "&lt;") : "Work with Codex"}${st.caret ? '<span class="cx-caret"></span>' : ""}</div>`
    + `<div class="cx-row">${I.plus}<span class="cx-appr">${I.hand}<span>Ask for approval</span></span><span class="grow"></span><span class="cx-model"><b>6 Luna</b> <span>Medium</span></span>${I.chev}${I.mic}<span class="cx-send${st.busy ? " busy" : ""}">${st.busy ? I.stop : I.up}</span></div></div>`;
  let thread = "";
  if (!st.bubbles.length) thread = `<div class="cx-empty"><div class="glyph">${I.term}</div><h2>What should we build?</h2></div>`;
  else {
    let y = 70;
    st.bubbles.forEach((b) => {
      thread += `<div class="cx-col" style="top:${y}px;height:0"><div class="cx-bub" style="top:0">${PROMPT_CX}</div></div>`;
      y += 64;
      if (b.recon) { thread += `<div class="cx-col" style="top:${y}px"><div class="cx-recon">${I.wifi}<span>Reconnecting ${b.recon}/5</span></div></div>`; y += 32; }
      if (b.err) { thread += `<div class="cx-col" style="top:${y}px"><div class="cx-err" style="top:0"><span class="ico">${I.alert}</span>${ERR(b.err)}</div></div>`; y += 150; }
    });
  }
  return `<div class="cx">${codexChrome(st)}<div class="cx-main">${thread}${comp}</div></div>`;
}
function codexAt(t) {
  const e = C.ev, st = { text: "", caret: false, busy: false, bubbles: [] };
  const burst = (t0, gev) => { const k = Math.max(0, t - t0); const b = { recon: Math.min(5, 1 + Math.floor(Math.max(0, k - 0.25) / 0.4)) }; if (k >= e.err - e.send) b.err = gev; return b; };
  if (t < e.send) { const n = Math.round(PROMPT_CX.length * Math.min(1, Math.max(0, (t - e.typeA) / (e.typeB - e.typeA)))); st.text = PROMPT_CX.slice(0, Math.max(0, n)); st.caret = true; }
  if (t >= e.send) { const b = burst(e.send + 0.05, "gev_e8318942746f46d2"); st.bubbles.push(b); st.busy = !b.err; }
  if (t >= e.paste && t < e.push) { st.text = PROMPT_CX; st.caret = true; }
  if (t >= e.push) { const b = burst(e.push + 0.05, "gev_5a07c3d1b6e94f20"); st.bubbles.push(b); st.busy = !b.err; }
  if (t >= e.send && t < e.paste) st.caret = true;
  return st;
}

const KINDS = {
  cw: { html: (t) => claudeWebHTML(claudeWebAt(t, C.ev)), comp: ".cw-comp", caret: ".cw-caret", send: ".cw-send", head: ".cw-greet", err: ".cw-toast", errAt: 0.45 },
  gw: { html: (t) => chatgptWebHTML(chatgptWebAt(t, C.ev)), comp: ".gw-comp", caret: ".gw-caret", send: ".gw-send", head: ".gw-h1", err: ".gw-card", errAt: 1.0, retry: ".gw-retry" },
  cm: { html: (t) => claudeMacHTML(claudeMacAt(t, C.ev)), comp: ".cm-comp", caret: ".cm-caret", send: ".cm-send", head: ".cm-greet", err: ".cm-toast", errAt: 0.5 },
};
let VW = 1280, VH = 800, MOBILE = false, WIDE = false;
let CARET = [], COMP = null, ERRR = null, HEAD = null, SENDP = null, RETRYP = null, stageEl;
const rectOf = (el) => { const r = el.getBoundingClientRect(), s = stageEl.getBoundingClientRect(); return { l: r.left - s.left, t: r.top - s.top, r: r.right - s.left, b: r.bottom - s.top }; };
const inkOf = (el) => { const g = document.createRange(); g.selectNodeContents(el); const r = g.getBoundingClientRect(), s = stageEl.getBoundingClientRect(); return { l: r.left - s.left, t: r.top - s.top, r: r.right - s.left, b: r.bottom - s.top }; };
const mid2 = (r) => ({ x: (r.l + r.r) / 2, y: (r.t + r.b) / 2 });
const interp = (arr, t) => {
  if (!arr.length) return 0;
  if (t <= arr[0][0]) return arr[0][1];
  for (let i = 1; i < arr.length; i++) if (t <= arr[i][0]) { const [t0, a] = arr[i - 1], [t1, b] = arr[i]; return lerp(a, b, (t - t0) / (t1 - t0 || 1)); }
  return arr[arr.length - 1][1];
};

export async function setup(id, opts = {}) {
  MOBILE = !!opts.mobile; WIDE = !MOBILE && !!opts.wide;
  VW = MOBILE ? 720 : WIDE ? 1140 : 1280; VH = MOBILE ? 720 : WIDE ? 493 : 800;
  C = CLIPS[id]; GUARD = { left: 0, top: 0, width: 380 }; GS = 1;
  const stage = stageEl = document.getElementById("stage");
  stage.style.width = `${VW}px`; stage.style.height = `${VH}px`;
  let win = "";
  if (C.chrome) win = chromeWindow({ ...C.chrome, w: Math.round(1280 * S) });
  if (C.kind === "cm") win = nativeWindow(APPROOT, "");
  if (C.kind === "codex") win = nativeWindow(`<div id="cxroot" style="position:absolute;left:0;top:0;width:1280px;height:800px;transform:scale(${S});transform-origin:0 0"></div>`,
    "");
  stage.innerHTML = `<div id="cam"><div class="wall"></div>${menu(C.app, C.menus)}${win}<div id="guard" style="left:0;top:0">${blockedWindow({ ...C.guard, width: GUARD.width, active: false })}</div><div id="cursor">${I.pointer}</div></div>`;
  camEl = document.getElementById("cam"); guardEl = document.getElementById("guard"); cursorEl = document.getElementById("cursor"); appEl = document.getElementById("approot");
  const winEl = document.getElementById("win"), content = document.getElementById("content");
  const wl = winEl.offsetLeft, ct = winEl.offsetTop + content.offsetTop;
  pt = ([x, y]) => [wl + x * S, ct + y * S];
  if (C.kind !== "codex") {
    const K = KINDS[C.kind], e = C.ev;
    C.o = { ...e, ...C.derive(e) };
    const at = (t) => { appEl.innerHTML = K.html(t); return appEl; };
    at(e.typeB + 0.1); await document.fonts.ready;
    COMP = rectOf(at(e.typeA - 0.1).querySelector(K.comp));
    HEAD = inkOf(appEl.querySelector(K.head));
    CARET = [];
    for (let t = e.typeA + 0.02; t <= e.typeB + 0.2; t += 1 / 48) { const c = at(t).querySelector(K.caret); if (c) CARET.push([t, rectOf(c).l]); }
    for (let i = 1; i < CARET.length; i++) CARET[i][1] = Math.max(CARET[i][1], CARET[i - 1][1]);
    const sp = mid2(rectOf(at(e.typeB + 0.1).querySelector(K.send))); SENDP = sp;
    ERRR = rectOf(at(C.o.err + K.errAt).querySelector(K.err));
    if (K.retry) RETRYP = mid2(rectOf(appEl.querySelector(K.retry)));
    appEl.innerHTML = "";
  } else {
    C.o = { ...C.ev };
    const root = document.getElementById("cxroot"); CARET = [];
    for (let t = C.ev.typeA + 0.05; t <= C.ev.typeB + 0.2; t += 1 / 24) {
      root.innerHTML = codexHTML(codexAt(t)); const c = root.querySelector(".cx-caret"); if (c) CARET.push([t, rectOf(c).l]);
    }
    COMP = rectOf(root.querySelector(".cx-comp"));
    root.innerHTML = codexHTML(codexAt(C.ev.err + 0.2));
    const er = rectOf(root.querySelector(".cx-err")), rc = rectOf(root.querySelector(".cx-recon"));
    ERRR = { l: Math.min(er.l, rc.l), t: Math.min(er.t, rc.t), r: Math.max(er.r, rc.r), b: Math.max(er.b, rc.b) };
    root.innerHTML = "";
  }
  plan();
  return { dur: C.dur, cues: C.cues(C.o).map(([t, s]) => [Math.max(0, +t.toFixed(2)), s]), label: C.label, posterT: +POSTER.toFixed(2) };
}

let G, CUR, CLK, CAM, FOLLOW = null, POSTER = 0;
const clampV = (v) => { const hw = VW / 2 / v.z, hh = VH / 2 / v.z; return { z: v.z, cx: Math.min(Math.max(v.cx, hw), 1280 - hw), cy: Math.min(Math.max(v.cy, hh), 800 - hh) }; };
const minZ = () => Math.max(VW / 1280, VH / 800);
const fit = (r, pad = 36, cap = 1.6) => clampV({ z: Math.max(minZ(), Math.min(cap, VW / (r.r - r.l + 2 * pad), VH / (r.b - r.t + 2 * pad))), cx: (r.l + r.r) / 2, cy: (r.t + r.b) / 2 });
const union = (a, b) => ({ l: Math.min(a.l, b.l), t: Math.min(a.t, b.t), r: Math.max(a.r, b.r), b: Math.max(a.b, b.b) });
const hits = (a, b) => !(a.r < b.l || a.l > b.r || a.b < b.t || a.t > b.b);
function placeGuard(cx, cy, gs) {
  GS = gs;
  const w = guardEl.offsetWidth, h = guardEl.offsetHeight;
  GUARD = { left: cx - w / 2, top: cy - h / 2, width: w };
  guardEl.style.left = `${GUARD.left}px`; guardEl.style.top = `${GUARD.top}px`;
  const gr = guardEl.getBoundingClientRect(), br = guardEl.querySelector(".mui-blocked-foot .mui-btn").getBoundingClientRect();
  closeXY = [cx + (br.left + br.width / 2 - (gr.left + gr.width / 2)) * gs, cy + (br.top + br.height / 2 - (gr.top + gr.height / 2)) * gs];
  return { l: cx - (w * gs) / 2, t: cy - (h * gs) / 2, r: cx + (w * gs) / 2, b: cy + (h * gs) / 2 };
}
const Pp = (p) => pt(p);
const Zv = (p, z) => { const [x, y] = Pp(p); return { z, cx: x, cy: y }; };
const Pt = (p) => { const [x, y] = Pp(p); return { x, y }; };
const sendOf = () => (C.kind === "codex" ? Pt([CX_MID + 343, 718]) : SENDP);

function plan() {
  FOLLOW = null;
  if (MOBILE) planPhone(); else planDesktop();
}

function planPhone() {
  const o = C.o, ts = o.send, te = o.typeB, codex = C.kind === "codex", cg = C.kind === "gw";
  const wr = rectOf(document.getElementById("win"));
  let V0 = null;
  if (HEAD) {
    const r = { l: COMP.l, t: HEAD.t, r: Math.max(HEAD.r, COMP.l + 240), b: COMP.b }, pl = 40, pr = 36, pv = 40;
    const z = Math.min(cg ? 1.85 : 1.5, VW / (r.r - r.l + pl + pr), VH / (r.b - r.t + 2 * pv));
    V0 = { z, cx: r.l - pl + VW / 2 / z, cy: (r.t + r.b) / 2 };
  }
  const hp = 24, pad = 40, c0 = CARET.length ? CARET[0][1] : COMP.l + 20, c1 = CARET.length ? CARET[CARET.length - 1][1] : COMP.r;
  let need = 0;
  if (HEAD) need = Math.max(HEAD.r - HEAD.l + 2 * hp, HEAD.r + hp - (c0 - pad), c1 + 30 - (HEAD.l - hp), c1 + 30 - (c0 - pad));
  const ZF = Math.min(cg ? 1.85 : 1.5, need ? VW / need : 9), FW = VW / ZF, FH = VH / ZF;
  let lo = COMP.l - pad, hi = Math.max(lo, COMP.r + pad - FW);
  if (HEAD) { lo = Math.max(lo, HEAD.r + hp - FW); hi = Math.max(lo, Math.min(hi, HEAD.l - hp)); }
  const left = (t) => Math.min(Math.max(interp(CARET, t) - 0.64 * FW, lo), hi);
  const sm = (t) => { let s = 0; for (let k = -4; k <= 4; k++) s += left(t + k * 0.06); return s / 9; };
  const vc = HEAD ? (Math.min(HEAD.t, COMP.t) + COMP.b) / 2 : (COMP.t + COMP.b) / 2;
  const fcy = Math.min(Math.max(vc, wr.t + FH / 2), Math.max(wr.t + FH / 2, wr.b - FH / 2));
  const tA = o.typeA ?? 0, bl = 0.55;
  const pan = (t) => ({ z: ZF, cx: sm(t) + FW / 2, cy: fcy });
  FOLLOW = { until: te + 0.12, at: (t) => {
    const f = pan(t); if (!V0) return f;
    const k = ease((t - (tA - bl)) / bl);
    return { z: lerp(V0.z, f.z, k), cx: lerp(V0.cx, f.cx, k), cy: lerp(V0.cy, f.cy, k) };
  } };
  const f0 = FOLLOW.at(te + 0.12), sendP = sendOf();
  const zS = HEAD ? Math.min(ZF, VW / (sendP.x + 64 - (HEAD.l - hp))) : ZF, FWs = VW / zS;
  const sendV = { z: zS, cx: Math.max(f0.cx - FW / 2, sendP.x + 64 - FWs) + FWs / 2, cy: fcy };
  let OUT = clampV(codex ? Zv([CX_MID, 420], 0.98) : cg ? Zv([811, 400], 0.98) : Zv([784, 430], 0.98));
  if (!codex && !cg && ERRR) OUT = clampV({ ...OUT, cx: Math.max(OUT.cx, ERRR.r + 12 - VW / 2 / OUT.z) });
  const gw = guardEl.offsetWidth, gh = guardEl.offsetHeight;
  let gs0 = Math.min((0.9 * VW) / OUT.z / gw, (0.86 * VH) / OUT.z / gh);
  if (!codex && !cg && ERRR) gs0 = Math.min(gs0, (2 * (ERRR.t - 16 - OUT.cy)) / gh);
  const gr = placeGuard(OUT.cx, OUT.cy, gs0);
  const gOn = ts + 0.55, cl = { x: closeXY[0], y: closeXY[1] }, restP = { x: cl.x + 54, y: Math.min(cl.y + 44, gr.b + 20) };
  const idle = { x: sendP.x + 40, y: fcy + FH / 2 + 50 };
  const typing = [[0, idle], [te + 0.12, idle], [ts - 0.14, sendP], [ts + 0.15, sendP]];
  const after = { x: sendP.x - 70, y: sendP.y + 56 };
  const head = [[te + 0.12, f0], [ts - 0.12, sendV], [ts + 0.05, sendV], [ts + 0.5, OUT]];
  POSTER = ts + 1.4;
  if (codex) {
    const close = ts + 2.1, panel = clampV(Zv([CX_MID, 250], 1.08)), thread = clampV(Zv([CX_MID, 380], 1.05));
    G = [[gOn, close]];
    CUR = [...typing, [ts + 0.75, restP], [close - 0.6, restP], [close - 0.3, cl], [close + 0.2, cl], [o.push - 0.3, sendP], [o.push + 0.15, sendP], [o.push + 0.6, after]];
    CLK = [ts, close, o.push];
    CAM = [...head, [close + 0.1, OUT], [close + 0.6, panel], [o.paste - 0.2, panel], [o.paste + 0.3, sendV], [o.push + 0.1, sendV], [o.push + 0.6, thread]];
    return;
  }
  if (cg) {
    const close = o.err + 2.0, retry = RETRYP;
    const cardL = clampV({ z: 1.6, cx: ERRR.l - 24 + VW / 2 / 1.6, cy: (ERRR.t + ERRR.b) / 2 });
    const card = clampV({ z: 1.6, cx: Math.max(cardL.cx, ERRR.r + 24 - VW / 2 / 1.6), cy: cardL.cy });
    G = [[gOn, close], [o.push + 0.55, 1e9]];
    CUR = [...typing, [ts + 0.75, restP], [close - 0.6, restP], [close - 0.3, cl], [close + 0.2, cl], [o.retry - 0.35, retry], [o.retry + 0.3, retry], [o.push - 0.3, sendP], [o.push + 0.15, sendP], [o.push + 0.75, restP]];
    CLK = [ts, close, o.retry, o.push];
    CAM = [...head, [close + 0.1, OUT], [close + 0.6, cardL], [Math.max(close + 1.9, o.retry - 1.1), cardL], [o.retry - 0.45, card], [o.retry + 0.15, card], [o.retry + 0.7, sendV], [o.push + 0.05, sendV], [o.push + 0.5, OUT]];
    return;
  }
  const close = o.err + 2.4, tz = 1.75;
  const toastV = clampV({ z: tz, cx: (ERRR.l + ERRR.r) / 2, cy: Math.min(ERRR.b + 28, wr.b + 4) - VH / 2 / tz });
  G = [[gOn, close]];
  CUR = [...typing, [ts + 0.75, restP], [close - 0.6, restP], [close - 0.3, cl], [close + 0.2, cl], [o.push - 0.35, sendP], [o.push + 0.15, sendP], [o.push + 0.6, after]];
  CLK = [ts, close, o.push];
  CAM = [...head, [close + 0.1, OUT], [close + 0.65, toastV]];
}

function planDesktop() {
  const o = C.o, ts = o.send, te = o.typeB, codex = C.kind === "codex", cg = C.kind === "gw";
  const mid = { z: WIDE ? VW / 1280 : 1, cx: 640, cy: WIDE && codex ? 512 : 400 };
  const typeZ = codex ? Zv([CX_MID, 690], 1.35) : Zv(C.zoomType, C.typeZ);
  const at = clampV(typeZ);
  const gw = guardEl.offsetWidth, gh = guardEl.offsetHeight, wr = rectOf(document.getElementById("win"));
  const gz = Math.min(1.8, (VW - 100) / gw, (VH - 80) / gh), hw = VW / 2 / gz;
  let gcx = at.cx, gcy = at.cy;
  if (cg && ERRR && gcx + gw / 2 > ERRR.l && gcx - gw / 2 < ERRR.r) gcy = Math.max(gcy, ERRR.b + 14 + gh / 2);
  if (cg && ERRR) gcy = Math.max(gcy, ERRR.b + 12 + VH / 2 / gz);
  if (wr.r - wr.l >= 2 * hw) gcx = Math.min(Math.max(gcx, wr.l + hw), wr.r - hw);
  const gd = clampV({ z: gz, cx: gcx, cy: gcy });
  const gr = placeGuard(gd.cx, gd.cy, 1);
  const u = union(gr, ERRR), bp = WIDE ? 22 : 40;
  const cover = hits(gr, ERRR) || Math.min(VW / (u.r - u.l + 2 * bp), VH / (u.b - u.t + 2 * bp)) < minZ();
  const both = fit(u, bp, 1.25), errV = fit(ERRR, 60, 1.45);
  const gOn = ts + 0.22, cl = { x: closeXY[0], y: closeXY[1] }, sendP = sendOf();
  const restFor = (p) => (p.x > gr.l - 28 && p.x < gr.r + 28 && p.y > gr.t - 28 && p.y < gr.b + 28 ? { x: gr.l - 70, y: Math.min(gr.b + 40, p.y + 40) } : p);
  const rest = restFor(sendP);
  const m0 = clampV(mid), idle = { x: Math.min(1250, sendP.x + 80), y: Math.max(at.cy + VH / 2 / at.z, m0.cy + VH / 2 / m0.z) + 40 };
  const typing = [[0, idle], [te + 0.12, idle], [ts - 0.14, sendP], [ts + 0.15, sendP]];
  if (codex) {
    const close = cover ? Math.min(o.close, o.err - 0.3) : o.close;
    G = [[gOn, close]];
    CUR = [...typing, [ts + 0.6, rest], [close - 0.65, rest], [close - 0.3, cl], [close + 0.25, cl], [o.push - 0.3, sendP], [o.push + 0.15, sendP], [o.push + 0.6, rest]];
    CLK = [ts, close, o.push];
    const pull = cover ? [[close + 0.1, gd], [close + 0.6, errV], [o.err + 1.2, errV]] : [[ts + 1.9, gd], [ts + 2.5, both], [close + 0.1, both]];
    CAM = [[0, mid], [0.5, typeZ], [ts - 0.1, typeZ], [ts + 0.6, gd], ...pull, [close + 0.6, typeZ], [o.push + 0.15, typeZ], [o.push + 0.75, Zv([640, 420], 1.15)]];
    POSTER = cover ? ts + 1.4 : o.err + 0.4;
    return;
  }
  if (cg) {
    const close = cover ? o.err + 1.6 : Math.min(o.err + 2.9, o.retry - 0.9);
    const close2 = cover ? o.push + 2.0 : 1e9;
    G = [[gOn, close], [o.push + 0.22, close2]];
    const retry = RETRYP;
    CUR = [...typing, [ts + 0.6, rest], [close - 0.65, rest], [close - 0.3, cl], [close + 0.2, cl], [o.retry - 0.35, retry], [o.retry + 0.3, retry], [o.push - 0.3, sendP], [o.push + 0.15, sendP], [o.push + 0.6, rest]];
    CLK = [ts, close, o.retry, o.push];
    if (cover) { CUR.push([close2 - 0.65, rest], [close2 - 0.3, cl], [close2 + 0.2, cl]); CLK.push(close2); }
    const cardV = clampV(Zv(C.zoomEnd, C.typeZ)), endV = WIDE ? clampV({ z: 0.95, cx: 640, cy: 512 }) : mid;
    const first = cover ? [[close + 0.05, gd], [close + 0.6, cardV]] : [[o.err + 1.5, gd], [o.err + 2.0, both], [close + 0.05, both], [close + 0.6, cardV]];
    const last = cover ? [[close2 + 0.05, gd], [close2 + 0.6, endV]] : [[o.push + 1.6, gd], [o.push + 2.2, endV]];
    CAM = [[0, mid], [0.7, typeZ], [ts - 0.1, typeZ], [ts + 0.75, gd], ...first, [o.retry + 0.15, cardV], [o.retry + 0.7, typeZ], [o.push - 0.05, typeZ], [o.push + 0.6, gd], ...last];
    POSTER = ts + 1.5;
    return;
  }
  const close = cover ? o.err + 1.6 : Math.min(o.err + 2.9, o.push - 0.9);
  G = [[gOn, close]];
  CUR = [...typing, [ts + 0.6, rest], [close - 0.65, rest], [close - 0.3, cl], [close + 0.2, cl], [o.push - 0.35, sendP], [o.push + 0.15, sendP], [o.push + 0.6, rest]];
  CLK = [ts, close, o.push];
  const end = Zv(...(WIDE ? C.endWide : C.endStd));
  const pullT = o.err + 1.5;
  CAM = cover
    ? [[0, mid], [0.7, typeZ], [ts - 0.1, typeZ], [ts + 0.75, gd], [close + 0.05, gd], [close + 0.7, end]]
    : [[0, mid], [0.7, typeZ], [ts - 0.1, typeZ], [ts + 0.75, gd], [pullT, gd], [pullT + 0.5, both], [close + 0.05, both], [close + 0.7, end]];
  POSTER = cover ? ts + 1.4 : pullT + 0.65;
}

export async function renderAt(t) {
  if (C.kind === "codex") document.getElementById("cxroot").innerHTML = codexHTML(codexAt(t));
  else appEl.innerHTML = KINDS[C.kind].html(t);
  let op = 0, sc = 0.94;
  for (const [a, b] of G) {
    if (t >= a && t < b) { const k = ease((t - a) / 0.22); op = k; sc = lerp(0.94, 1, k); }
    else if (t >= b && t < b + 0.15) { op = 1 - (t - b) / 0.15; sc = 1; }
  }
  guardEl.style.opacity = op; guardEl.style.transform = `scale(${sc * GS})`; guardEl.style.visibility = op > 0.001 ? "visible" : "hidden";
  const c = track(CUR, t); let s = 1;
  for (const k of CLK) if (t >= k - 0.06 && t < k + 0.12) s = 0.86;
  cursorEl.style.transform = `translate(${c.x - 3}px, ${c.y - 3}px) scale(${s})`;
  cursorEl.style.left = "0"; cursorEl.style.top = "0";
  const v = clampV(FOLLOW && t < FOLLOW.until ? FOLLOW.at(t) : track(CAM, t)), z = v.z;
  camEl.style.transform = `translate(${VW / 2 - v.cx * z}px, ${VH / 2 - v.cy * z}px) scale(${z})`;
}

window.__compose = { setup, renderAt, CLIPS: Object.keys(CLIPS), debug: () => ({ G, CUR, CLK, CAM, GUARD, GS, COMP, ERRR, HEAD, SENDP, RETRYP, CARET, o: C.o, dur: C.dur }) };
