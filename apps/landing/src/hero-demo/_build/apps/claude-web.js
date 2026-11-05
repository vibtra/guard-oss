import { markSvg } from "../../../marks/index.js";

export const CW_PROMPTS = {
  content: "Draft the payroll exception note for HR. Employee TFN: 123 456 782.",
  surface: "Draft a two-sentence welcome note for a new teammate.",
};
export const CW_EVENTS = { typeA: 1.508, typeB: 5.165, send: 5.868, push: 11.432, push2: 16.454 };
export const CW_GEOM = {
  composer: { x: 448, y: 341, w: 672, h: 111 },
  editor: { x: 468, y: 356, w: 640, h: 50 },
  send: { x: 1080, y: 412, w: 28, h: 28 },
  toast: { x: 904, y: 720, w: 360, h: 64 },
  userMessage: { x: 679, y: 83, w: 473, h: 44 },
};
export const CW_HISTORY = ["Q4 hiring plan draft", "Refactor billing webhook retries", "Summarise vendor security review", "Board update for October", "SQL for 90-day churn cohort", "Rewrite onboarding email", "Pricing page copy ideas", "Explain SOC 2 CC6 controls", "Postmortem: checkout outage", "Quarterly OKR review notes", "Kubernetes cost breakdown", "Draft RFC for feature flags", "Customer FAQ for API limits", "Interview loop scorecard"];
const USER = { name: "Alex Morgan", first: "Alex", init: "AM", plan: "Team" };

const sv = (vb, body, extra = "") => `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</svg>`;
export const CWI = {
  toggle: sv("0 0 20 20", '<rect x="2.6" y="4.1" width="14.8" height="11.8" rx="2.4"/><path d="M6.1 8.1v3.8"/>'),
  plus: sv("0 0 20 20", '<path d="M10 3.6v12.8M3.6 10h12.8"/>'),
  search: sv("0 0 20 20", '<circle cx="8.9" cy="8.9" r="5.7"/><path d="m13.1 13.1 3.6 3.6"/>'),
  projects: sv("0 0 20 20", '<path d="M6.6 3.5h6.8M4.8 6h10.4M3.7 8.8h12.6l-.8 6.2a2 2 0 0 1-2 1.7H6.5a2 2 0 0 1-2-1.7z"/>'),
  artifacts: sv("0 0 20 20", '<path d="M8.6 5.4l.2-.9a1.7 1.7 0 0 1 2-1.3l4.6 1a1.7 1.7 0 0 1 1.3 2l-1.6 7.4a1.7 1.7 0 0 1-2 1.3l-.6-.1"/><rect x="3.3" y="5.6" width="8.8" height="11.2" rx="1.8" transform="rotate(6 7.7 11.2)"/>'),
  code: sv("0 0 20 20", '<path d="M6.3 5.6 2.6 10l3.7 4.4M13.7 5.6l3.7 4.4-3.7 4.4M11.4 4 8.6 16"/>'),
  customize: sv("0 0 20 20", '<rect x="2.9" y="6.6" width="14.2" height="9.8" rx="2.2"/><path d="M7 6.6V5.3a1.4 1.4 0 0 1 1.4-1.4h3.2A1.4 1.4 0 0 1 13 5.3v1.3"/>'),
  tri: '<svg viewBox="0 0 10 10" fill="currentColor"><path d="M1.6 3h6.8L5 7.2z"/></svg>',
  filter: sv("0 0 20 20", '<path d="M4.6 5.6h10.8M6.6 10h6.8M8.6 14.4h2.8"/>'),
  ring: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1"><circle cx="5" cy="5" r="3"/></svg>',
  chev: sv("0 0 20 20", '<path d="m6 8 4 4 4-4"/>'),
  devices: sv("0 0 20 20", '<path d="M10.6 13.4H4.1a1.6 1.6 0 0 1-1.6-1.6V5.1a1.6 1.6 0 0 1 1.6-1.6h10.6a1.6 1.6 0 0 1 1.6 1.6v1.6M6.2 16.5h4.4M8.4 13.4v3.1"/><rect x="12.1" y="8.4" width="5.4" height="8.4" rx="1.2"/><path d="M14.8 14.6v.1"/>'),
  ghost: sv("0 0 20 20", '<path d="M4.2 16.6V9.4a5.8 5.8 0 0 1 11.6 0v7.2l-1.9-1.4-1.9 1.4-2-1.4-2 1.4-1.9-1.4z"/><path d="M8 9.2v1.3M12 9.2v1.3"/>'),
  mic: sv("0 0 20 20", '<rect x="7.4" y="2.6" width="5.2" height="9.4" rx="2.6"/><path d="M4.4 9.4a5.6 5.6 0 0 0 11.2 0M10 15v2.6"/>'),
  wave: sv("0 0 20 20", '<path d="M3.9 8.4v3.2M6.9 6.4v7.2M10 3.8v12.4M13.1 6.4v7.2M16.1 8.4v3.2"/>'),
  up: sv("0 0 20 20", '<path d="M10 16.2V4.2M4.8 9.4 10 4.2l5.2 5.2"/>', ' stroke-width="1.8"'),
  warn: sv("0 0 20 20", '<path d="M8.5 3.9a1.7 1.7 0 0 1 3 0l6 10.6a1.7 1.7 0 0 1-1.5 2.5H4a1.7 1.7 0 0 1-1.5-2.5z"/><path d="M10 8v3.4M10 14v.1"/>'),
  x: sv("0 0 20 20", '<path d="m5.5 5.5 9 9m0-9-9 9"/>'),
  share: sv("0 0 20 20", '<path d="M10 12.5V3.2M6.4 6.6 10 3l3.6 3.6M2.6 11v3.8a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8V11"/>'),
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
const NAV = [["plus", "New"], ["search", "Search"], ["projects", "Projects"], ["artifacts", "Artifacts"], ["code", "Code"], ["customize", "Customize"]];

function sidebar(st) {
  const rows = st.newRow ? [st.newRow, ...CW_HISTORY] : CW_HISTORY;
  const nav = NAV.map(([ic, label], i) => `<div class="cw-nav${i === 0 && !st.newRow && st.view === "new" ? " on" : ""}" style="top:${49 + i * 34}px"><i>${CWI[ic]}</i><span>${label}</span></div>`).join("");
  const hist = rows.slice(0, 13).map((r, i) => `<div class="cw-row${st.newRow && i === 0 ? " on" : ""}" style="top:${305 + i * 34}px"><i>${CWI.ring}</i><span>${esc(r)}</span></div>`).join("");
  return `<aside class="cw-sb"><div class="cw-sb-hd"><i class="cw-tog">${CWI.toggle}</i><b class="cw-word">Claude</b></div>${nav}`
    + `<div class="cw-sec"><span>Chats and tasks</span><i class="cw-tri">${CWI.tri}</i><i class="cw-filter">${CWI.filter}</i></div>${hist}`
    + `<div class="cw-scroll"></div>`
    + `<div class="cw-foot"><span class="cw-av">${USER.init}</span><span class="cw-name">${USER.name}</span><span class="cw-plan"><em>·</em> ${USER.plan}</span><i class="cw-fchev">${CWI.chev}</i><i class="cw-dev">${CWI.devices}</i></div></aside>`;
}
function sendBtn(kind, rot = 0) {
  if (kind === "send") return `<span class="cw-send">${CWI.up}</span>`;
  if (kind === "spin") return `<span class="cw-send spin"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.6" fill="none" stroke="rgba(255,255,255,.3)" stroke-width="1.1"/><path d="M10 2.4a7.6 7.6 0 0 1 7.6 7.6" fill="none" stroke="rgba(255,255,255,.75)" stroke-width="1.1" stroke-linecap="round" transform="rotate(${rot.toFixed(1)} 10 10)"/></svg></span>`;
  return `<span class="cw-voice">${CWI.wave}</span>`;
}
function composerNew(st) {
  const txt = st.text ? esc(st.text) : "";
  return `<div class="cw-comp"><div class="cw-ed${txt ? "" : " ph"}">${st.caret ? '<span class="cw-caretwrap">' : ""}${txt || ""}${st.caret ? '<span class="cw-caret"></span></span>' : ""}${txt || st.sendBtn === "spin" ? "" : '<span class="cw-ph">How can I help you today?</span>'}</div>`
    + `<div class="cw-tools"><i class="cw-cplus">${CWI.plus}</i><span class="cw-seg"><b>Chat</b><span>Cowork</span></span>`
    + `<span class="cw-model"><b>Sonnet 5.5</b> <span>Medium</span></span><i class="cw-mic${st.sendBtn === "spin" ? " dim" : ""}">${CWI.mic}</i><i class="cw-mchev">${CWI.chev}</i>${sendBtn(st.sendBtn, st.spin || 0)}</div></div>`;
}
function mainNew(st) {
  const g = st.greeting ?? 1;
  return `<div class="cw-greet" style="opacity:${g}"><i class="cw-spark">${markSvg("claude")}</i><h1>Good afternoon, ${USER.first}</h1></div>${composerNew(st)}`
    + (st.msg ? `<div class="cw-msg ghost" style="opacity:${st.msg.opacity}">${esc(st.prompt)}</div>` : "");
}
function mainChat(st) {
  return `<div class="cw-chathd"><span class="cw-title">${esc(st.title)}</span><i class="cw-tchev">${CWI.chev}</i><span class="cw-share">${CWI.share}<span>Share</span></span></div>`
    + `<div class="cw-msg" style="opacity:${st.msg ? st.msg.opacity : 1}">${esc(st.prompt)}</div><span class="cw-dot"></span>`
    + `<div class="cw-comp2"><i class="cw-cplus">${CWI.plus}</i><span class="cw-ed2"><span class="cw-caret"></span><span class="cw-ph">Write a message…</span></span><i class="cw-mic">${CWI.mic}</i><i class="cw-mchev">${CWI.chev}</i><span class="cw-stop"></span></div>`
    + `<div class="cw-disc"><span>Claude is AI and can make mistakes. Please double-check responses.</span><span class="cw-disc-m">Sonnet 5.5&nbsp; <span>Medium</span></span></div>`;
}
function toast(st) {
  if (!st.toast) return "";
  const k = st.toast.k, out = st.toast.out || 0, o = Math.min(1, 0.35 + k * 0.65) * (1 - out);
  return `<div class="cw-toast" style="opacity:${o.toFixed(3)};transform:translateY(${((1 - k) * 34 + out * 6).toFixed(2)}px) scale(${(1 - out * 0.05).toFixed(4)})"><i class="cw-warn">${CWI.warn}</i><span>This isn’t working right now. You can try again later.</span><i class="cw-tx">${CWI.x}</i></div>`;
}
export function claudeWebHTML(st) {
  const main = st.view === "chat" ? mainChat(st) : mainNew(st);
  return `<div class="cw">${sidebar(st)}<main class="cw-main"><i class="cw-ghost">${CWI.ghost}</i>${main}</main>${toast(st)}</div>`;
}

const T1 = { pend: 0.037, rowAt: 0.037, chat: 0.144, back: 0.244, toastA: 0.283, toastB: 0.342, restore: 0.342 };
const T2 = { pend: 0.037, rowAt: 0.104, chat: 0.104, back: 0.194, toastA: 0.208, toastB: 0.33, restore: 0.279, outB: 0.09 };
const blink = (since) => since % 1.0 < 0.5;
export function claudeWebAt(t, ev = CW_EVENTS, opts = {}) {
  const prompt = opts.prompt || CW_PROMPTS.content;
  const sends = [ev.send, ev.push, ev.push2].filter((x) => x != null && t >= x);
  const st = { text: "", caret: true, sendBtn: "voice", greeting: 1, view: "new", msg: null, newRow: null, toast: null, prompt, title: prompt };
  if (!sends.length) {
    const k = Math.min(1, Math.max(0, (t - ev.typeA) / (ev.typeB - ev.typeA)));
    st.text = prompt.slice(0, Math.round(prompt.length * k));
    st.sendBtn = st.text ? "send" : "voice";
    st.caret = blink(t - (t > ev.typeB ? ev.typeB : t < ev.typeA ? 0 : t));
    return st;
  }
  const s = sends[sends.length - 1], dt = t - s;
  const hadToast = sends.length > 1;
  const T = hadToast ? T2 : T1;
  if (dt < T.back) {
    st.sendBtn = "spin"; st.spin = (dt * 420) % 360; st.greeting = 0; st.caret = !hadToast && dt >= T.pend;
    if (hadToast && dt < T.outB) st.toast = { k: 1, out: dt / T.outB };
    if (dt >= T.rowAt) st.newRow = prompt;
    if (dt >= T.pend && dt < T.chat) st.msg = { opacity: Math.min(1, 0.4 + (dt - T.pend) / (T1.chat - T.pend)) };
    if (dt >= T.chat) { st.view = "chat"; st.msg = { opacity: 0.75 + 0.25 * Math.min(1, (dt - T.chat) / 0.1) }; }
    return st;
  }
  const k = Math.min(1, Math.max(0, (dt - T.toastA) / (T.toastB - T.toastA)));
  if (dt >= T.toastA) st.toast = { k: 1 - (1 - k) * (1 - k) };
  if (dt >= T.restore) { st.text = prompt; st.sendBtn = "send"; }
  st.caret = blink(dt - (dt >= T.restore ? T.restore : T.back));
  return st;
}
