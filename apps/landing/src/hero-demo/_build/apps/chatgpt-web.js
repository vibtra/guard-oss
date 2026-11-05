export const GW_PROMPT = "Draft the Q3 churn summary for Monday's exec review.";
export const GW_IDS = ["pd_5c1e0a9b7d3f42e8a6b1c4d7e9f0a2b3", "pd_e2b7f4c9a1d6483f90c5b8a3d7e1f264"];
export const GW_REFUSAL = (id) => `vibtra: blocked — Your organisation's Guard surface policy blocks this action. Ask your administrator to review this surface block; per-request approval cannot override it. (decision ${id})`;
export const GW_GREETING = { first: "Where should we begin?", retry: "How can I help, Alex?" };
const HISTORY = ["Weekly team update draft", "Customer interview synthesis", "Clean up CSV export in Python", "Launch checklist for v2.4", "Competitor pricing table", "Offsite agenda ideas", "Regex for invoice numbers", "Translate release notes to German", "Meeting notes to action items", "Excel formula for churn rate", "Job description for designer", "Summarise Q3 board deck", "Explain OAuth device flow", "Newsletter subject lines", "Refund policy wording", "Roadmap prioritisation matrix", "Onboarding survey questions", "Docker compose for Postgres", "Product FAQ rewrite", "Holiday coverage schedule"];

export const GW_GEOM = {
  sidebarRight: 340,
  composerIdle: { x: 427, y: 336, w: 768, h: 52 },
  composerChat: { x: 427, y: 724, w: 768, h: 52 },
  editor: { x: 479, y: 349, w: 528, h: 26 },
  sendIdle: { x: 1151, y: 344, w: 36, h: 36 },
  sendChat: { x: 1151, y: 732, w: 36, h: 36 },
  bubble: { x: 751, y: 84, w: 444, h: 46 },
  card: { x: 427, y: 172, w: 768, h: 86 },
  retry: { x: 1125, y: 203, w: 52, h: 24 },
  newRow: { x: 6, y: 436, w: 317, h: 36 },
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const IC = {
  compose: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9.2 3.6H6.1a2.6 2.6 0 0 0-2.6 2.6v7.7a2.6 2.6 0 0 0 2.6 2.6h7.7a2.6 2.6 0 0 0 2.6-2.6v-3.1"/><path d="M14.7 3.4a1.75 1.75 0 0 1 2.5 2.5l-5.7 5.7-3.1.7.7-3.1z"/></svg>',
  images: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"><path d="M7.6 5.6 7.9 4.4a1.6 1.6 0 0 1 1.9-1.2l7.3 1.1a1.6 1.6 0 0 1 1.3 1.8l-1 6.4a1.6 1.6 0 0 1-1.6 1.3h-1.3"/><rect x="2.1" y="6.6" width="11" height="10.6" rx="1.8" transform="rotate(-9 7.6 11.9)"/><circle cx="9.1" cy="9.8" r="1.15" fill="currentColor" stroke="none"/><path d="m2.9 15.3 4.3-2.9 5.6 4.1"/></svg>',
  clock: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><circle cx="10" cy="10" r="7.25"/><path d="M10 5.6V10l-2.6 3"/></svg>',
  library: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><rect x="2.6" y="3.4" width="4" height="13.2" rx="1.3"/><rect x="6.6" y="3.4" width="4" height="13.2" rx="1.3"/><rect x="11.4" y="3.6" width="4" height="13.2" rx="1.3" transform="rotate(-14 13.4 10.2)"/></svg>',
  plugins: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><g transform="translate(0 -.5)"><path d="M14.75 16.5A7.35 7.35 0 1 1 17.35 10.6c0 1.7-.8 2.7-2 2.7-1 0-1.7-.6-2-1.4"/><path d="M9.7 7.15A3.1 3.1 0 1 1 7.25 11"/><path d="m8.7 5.7 1 1.45-1.5.9"/></g></svg>',
  dots: '<svg viewBox="0 0 20 20" fill="currentColor"><circle cx="4.2" cy="10" r="1.45"/><circle cx="10" cy="10" r="1.45"/><circle cx="15.8" cy="10" r="1.45"/></svg>',
  search: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="9" cy="9" r="6"/><path d="m13.4 13.4 3.6 3.6"/></svg>',
  side: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2.75" y="3.75" width="14.5" height="12.5" rx="3"/><path d="M7.75 3.75v12.5"/></svg>',
  temp: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round"><path transform="translate(0 -.2)" d="M4.26 5.01A7.6 7.6 0 0 1 15.9 5.22M17.14 7.4a7.6 7.6 0 0 1-5.3 9.97M2.86 7.4a7.6 7.6 0 0 0 .9 6.96L3.5 17l5.25-.4"/></svg>',
  plus: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M10 3.4v13.2M3.4 10h13.2"/></svg>',
  brain: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M10 4.4c-.6-1-1.6-1.5-2.7-1.4-1.4.1-2.4 1.1-2.6 2.4-1.2.4-2 1.5-2 2.8 0 .7.3 1.4.7 1.9-.4.5-.7 1.2-.7 1.9 0 1.3.8 2.4 2 2.8.2 1.3 1.2 2.3 2.6 2.4 1.1.1 2.1-.4 2.7-1.4.6 1 1.6 1.5 2.7 1.4 1.4-.1 2.4-1.1 2.6-2.4 1.2-.4 2-1.5 2-2.8 0-.7-.3-1.4-.7-1.9.4-.5.7-1.2.7-1.9 0-1.3-.8-2.4-2-2.8-.2-1.3-1.2-2.3-2.6-2.4-1.1-.1-2.1.4-2.7 1.4Z"/><path d="M10 4.4v11.2"/></svg>',
  mic: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><rect x="6.75" y="1.35" width="6.4" height="10.1" rx="3.2"/><path d="M4.15 11.35a5.8 3 0 0 0 11.6 0M9.95 14.35v3.1"/></svg>',
  wave: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M3.5 7.4v5.2M7.7 3.6v12.8M12.3 4.9v10.2M16.5 7.4v5.2"/></svg>',
  up: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15.6V3.6M4.9 8.5 10 3.4l5.1 5.1"/></svg>',
  stop: '<svg viewBox="0 0 20 20" fill="currentColor"><rect x="5.5" y="5.5" width="9" height="9" rx="1.6"/></svg>',
  x: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="m6.25 6.25 7.5 7.5m0-7.5-7.5 7.5"/></svg>',
  share: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"><path d="M10 12.2V3.2M6.6 6.4 10 3l3.4 3.4"/><path d="M3.6 11v3.4a2.2 2.2 0 0 0 2.2 2.2h8.4a2.2 2.2 0 0 0 2.2-2.2V11"/></svg>',
  info: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M8 7.3v3.6"/><circle cx="8" cy="5.1" r=".45" fill="currentColor" stroke="none"/></svg>',
  spin: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"><circle cx="8" cy="8" r="4.5" opacity=".22"/><path d="M8 3.5a4.5 4.5 0 1 1-4.5 4.5"/></svg>',
};

const NAV_TOP = [["compose", "New chat", 60], ["images", "Images", 96]];
const NAV = [["clock", "Scheduled", 134.5], ["library", "Library", 170.5], ["plugins", "Plugins", 206.5], ["dots", "Explore", 242.5]];

function sidebar(st) {
  const navRow = ([ic, label, y], sel) => `<div class="gw-nav${ic === "compose" ? " nc" : ""}${sel ? " sel" : ""}" style="top:${y}px"><i>${IC[ic]}</i><span>${label}</span></div>`;
  const rows = [...st.chats.map((c) => ({ ...c, title: c.title ?? GW_PROMPT })), ...HISTORY.map((title) => ({ title }))];
  const hist = rows.map((r, i) => {
    const icon = r.icon === "err" ? `<b class="gw-ri err">${IC.info}</b>` : r.icon === "spin" ? `<b class="gw-ri spin" style="--a:${(r.spinA ?? 0).toFixed(1)}deg">${IC.spin}</b>` : "";
    return `<div class="gw-row${r.sel ? " sel" : ""}${icon ? " has-ic" : ""}${r.icon === "spin" ? " busy" : ""}" style="top:${436 + i * 37}px"><span class="gw-rt"${r.fade != null && r.fade < 1 ? ` style="opacity:${r.fade.toFixed(3)}"` : ""}>${esc(r.title)}</span>${icon}</div>`;
  }).join("");
  return `<aside class="gw-sb">`
    + `<div class="gw-wm">ChatGPT</div><i class="gw-hi" style="left:260px">${IC.search}</i><i class="gw-hi" style="left:304px">${IC.side}</i>`
    + navRow(NAV_TOP[0], st.newChatSel) + navRow(NAV_TOP[1])
    + `<div class="gw-scroll">${NAV.map((n) => navRow(n)).join("")}`
    + `<div class="gw-sec" style="top:306.5px">Projects</div><div class="gw-none" style="top:347px">No projects</div>`
    + `<div class="gw-sec" style="top:404px">Recents</div>${hist}</div>`
    + `<i class="gw-sbthumb"></i>`
    + `<div class="gw-foot"><span class="gw-av">AM</span><span class="gw-nm">Alex Morgan</span><span class="gw-pl">Business</span></div>`
    + `</aside>`;
}

function composer(st, y) {
  const btn = st.sendBtn === "stop" ? `<span class="gw-send busy">${IC.stop}</span>` : st.sendBtn === "up" ? `<span class="gw-send">${IC.up}</span>` : `<span class="gw-send">${IC.wave}</span>`;
  const txt = st.text ? `<span class="gw-tx">${esc(st.text)}</span>` : `<span class="gw-ph">Ask ChatGPT</span>`;
  const caret = st.caret ? '<span class="gw-caret"></span>' : "";
  const ed = st.text ? `${txt}${caret}` : `${caret}${txt}`;
  return `<div class="gw-comp" style="top:${y}px"><i class="gw-plus">${IC.plus}</i><div class="gw-ed">${ed}</div>`
    + `<span class="gw-think${st.sendBtn === "stop" ? " busy" : ""}">${IC.brain}<span>Think</span></span><i class="gw-mic${st.sendBtn === "stop" ? " busy" : ""}">${IC.mic}</i>${btn}</div>`;
}

const card = (id, retry, top, op = 1) => `<div class="gw-card" style="top:${top}px${op < 1 ? `;opacity:${op.toFixed(3)}` : ""}"><p>${esc(GW_REFUSAL(id))}</p>${retry ? '<span class="gw-retry">Retry</span>' : ""}</div>`;

export function chatgptWebHTML(st) {
  let main = "";
  if (st.page === "new") {
    main = `<i class="gw-temp">${IC.temp}</i><h1 class="gw-h1"${st.greetOp != null && st.greetOp < 1 ? ` style="opacity:${st.greetOp.toFixed(3)}"` : ""}>${esc(st.greeting)}</h1>${composer(st, 336)}`;
  } else {
    const s = st.scroll || 0;
    let thread = `<div class="gw-bub" style="top:${84 - s}px">${esc(GW_PROMPT)}</div>`;
    if (st.thinking) thread += `<i class="gw-dot" style="top:${st.dotY - s}px"></i>`;
    if (st.card) thread += card(st.card.id, true, 172 - s, st.card.op ?? 1);
    const top = st.topbar ? `<div class="gw-top"><i class="gw-more">${IC.dots}</i><i class="gw-x">${IC.x}</i><span class="gw-share">${IC.share}<span>Share</span></span></div>` : "";
    const bar = st.scrollbar ? `<i class="gw-mthumb" style="top:${56 + s * 0.93}px"></i>` : "";
    const docked = st.docked ? `<div class="gw-dock">${card(st.docked.id, false, 0)}</div>` : "";
    const disc = st.disclaimer > 0 ? `<div class="gw-disc" style="top:${st.discY ?? 700}px;opacity:${st.disclaimer.toFixed(3)}">ChatGPT can make mistakes. Check important info.</div>` : "";
    main = `${thread}${top}${bar}${disc}<div class="gw-fade"></div>${composer(st, st.docked ? 650 : 724)}${docked}`;
  }
  return `<div class="gw">${sidebar(st)}<main class="gw-main">${main}</main></div>`;
}

export const GW_EVENTS = { focus: 1.2, typeA: 1.51, typeB: 4.83, send: 5.54, retry: 11.18, push: 16.39 };
const D = {
  chat: 0.145,
  flash: 0.205,
  card: 0.585,
  scroll: 0.4,
  disc: 0.08,
  newchat: 0.237,
  chat2: 0.02,
  card2: 0.084,
};

const lerp = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k));
const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - Math.pow(1 - x, 3));

export function chatgptWebAt(t, ev = {}) {
  const e = { ...GW_EVENTS, ...ev };
  const tChat = e.chat ?? e.send + D.chat, tFlash = e.flash ?? e.send + D.flash, tCard = e.err ?? e.send + D.card;
  const tNew = e.newchat ?? e.retry + D.newchat, tChat2 = e.chat2 ?? e.push + D.chat2, tCard2 = e.err2 ?? e.push + D.card2;
  const st = { page: "new", greeting: GW_GREETING.first, text: "", caret: false, sendBtn: "voice", newChatSel: true, chats: [], topbar: false,
    thinking: false, dotY: 148, card: null, docked: null, scroll: 0, scrollbar: false, disclaimer: 0 };
  const blink = (t0) => Math.floor(Math.max(0, t - t0) / 0.5) % 2 === 0;
  const spinA = (t0) => ((t - t0) * 360 / 0.9) % 360;
  const row1 = { title: GW_PROMPT };

  if (t < tChat) {
    if (t >= e.focus) {
      const n = Math.round(GW_PROMPT.length * Math.min(1, Math.max(0, (t - e.typeA) / (e.typeB - e.typeA))));
      st.text = GW_PROMPT.slice(0, n);
      st.caret = t < e.typeB ? true : blink(e.typeB);
      if (t < e.typeA) st.caret = blink(e.focus);
    }
    st.sendBtn = st.text ? "up" : "voice";
    return st;
  }
  if (t < tNew) {
    st.page = "chat";
    if (t < tFlash) {
      st.thinking = true; st.dotY = 148; st.sendBtn = "stop"; st.caret = true;
      st.chats = [{ ...row1, icon: "spin", spinA: spinA(tChat) }];
      return st;
    }
    if (t < tCard) {
      st.caret = true; st.docked = { id: GW_IDS[0] };
      st.chats = [{ ...row1, icon: "err" }];
      return st;
    }
    st.newChatSel = false; st.topbar = true; st.scrollbar = true; st.caret = blink(tCard);
    st.card = { id: GW_IDS[0] };
    st.scroll = Math.round(31 * ease((t - tCard) / D.scroll));
    st.disclaimer = Math.min(1, Math.max(0, (t - tCard - 0.05) / D.disc)); st.discY = 701;
    st.chats = [{ ...row1, icon: "err", sel: true }];
    return st;
  }
  if (t < tChat2) {
    st.greeting = GW_GREETING.retry; st.text = GW_PROMPT; st.caret = blink(tNew); st.sendBtn = "up";
    st.chats = [{ ...row1, icon: "err" }];
    return st;
  }
  st.page = "chat"; st.newChatSel = false; st.topbar = true; st.disclaimer = 1; st.caret = true;
  if (t < tCard2) {
    st.thinking = true; st.dotY = 184; st.sendBtn = "stop";
    st.chats = [{ ...row1, icon: "spin", spinA: spinA(tChat2), sel: true }, { ...row1, icon: "err" }];
    return st;
  }
  st.caret = blink(tCard2);
  st.card = { id: GW_IDS[1] };
  st.chats = [{ ...row1, icon: "err", sel: true }, { ...row1, icon: "err" }];
  return st;
}

export const GW_STATES = {
  idle: 0.5, typing: 3.05, typed: 5.3, sent: 5.69, flash: 5.8, card: 6.13, result: 6.7, retried: 11.5, sent2: 16.42, result2: 16.6,
};
