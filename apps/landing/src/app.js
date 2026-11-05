import { fillMarks } from "./mark-ui.js";
import "./hero-demo/demo.js";
import { blockedWindow } from "./mac-ui/mac-ui.js";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const root = document.documentElement;
const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
const desktop = window.matchMedia("(min-width: 992px)");
const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");

const isDark = () => root.getAttribute("data-theme") === "dark";
const syncToggle = () => {
  $$(".ftoggle button").forEach((b) => {
    const on = b.dataset.themeSet === (isDark() ? "dark" : "light");
    b.classList.toggle("active", on);
    b.setAttribute("aria-pressed", String(on));
  });
};
const withoutTransitions = (fn) => {
  const css = document.createElement("style");
  css.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(css);
  fn();
  void getComputedStyle(document.body).backgroundColor;
  requestAnimationFrame(() => requestAnimationFrame(() => css.remove()));
};
$$(".ftoggle button").forEach((b) => b.addEventListener("click", () => {
  withoutTransitions(() => root.setAttribute("data-theme", b.dataset.themeSet === "dark" ? "dark" : "light"));
  try { localStorage.setItem("theme", b.dataset.themeSet); } catch {}
  syncToggle();
}));
syncToggle();

const nv = $(".nv");
if (nv) {
  const trig = $(".nv-trig", nv);
  const drop = $(".nv-drop", nv);
  const dd = $(".nv-dd", nv);
  if (trig && drop) {
    let t = 0;
    const set = (open) => {
      clearTimeout(t);
      drop.dataset.open = String(open);
      trig.setAttribute("aria-expanded", String(open));
    };
    const later = () => { clearTimeout(t); t = setTimeout(() => set(false), 120); };
    dd.addEventListener("mouseenter", () => { if (canHover.matches && desktop.matches) set(true); });
    dd.addEventListener("mouseleave", () => { if (canHover.matches && desktop.matches) later(); });
    trig.addEventListener("click", () => set(drop.dataset.open !== "true"));
    dd.addEventListener("focusout", (e) => { if (!dd.contains(e.relatedTarget)) set(false); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && drop.dataset.open === "true") { set(false); trig.focus(); } });
    document.addEventListener("click", (e) => { if (drop.dataset.open === "true" && !dd.contains(e.target)) set(false); });
    $$(".nv-row-a", drop).forEach((a) => {
      const show = () => $$(".nv-pv", drop).forEach((p) => { p.dataset.on = String(p.dataset.pv === a.dataset.pv); });
      a.addEventListener("mouseenter", show);
      a.addEventListener("focus", show);
      a.addEventListener("click", () => set(false));
    });
  }

  const burger = $(".nv-burger", nv);
  const sheet = $(".nv-sheet", nv);
  if (burger && sheet) {
    const set = (open) => {
      sheet.dataset.open = String(open);
      nv.dataset.sheet = String(open);
      burger.setAttribute("aria-expanded", String(open));
      $(".sr-only", burger).textContent = open ? "Close menu" : "Menu";
      document.documentElement.style.overflow = open ? "hidden" : "";
    };
    burger.addEventListener("click", () => set(sheet.dataset.open !== "true"));
    $(".nv-veil", nv)?.addEventListener("click", () => set(false));
    $$("a", sheet).forEach((a) => a.addEventListener("click", () => set(false)));
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && sheet.dataset.open === "true") { set(false); burger.focus(); } });
    desktop.addEventListener("change", () => { if (desktop.matches) set(false); });
    const acc = $(".nv-acc", sheet);
    acc?.addEventListener("click", () => {
      const open = acc.getAttribute("aria-expanded") !== "true";
      acc.setAttribute("aria-expanded", String(open));
    });
  }
}

const ICONS = {
  see: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/></svg>`,
  rules: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4.5 6v5.5c0 4.4 3.1 8.1 7.5 9.5 4.4-1.4 7.5-5.1 7.5-9.5V6L12 3Z"/><path d="M8.5 12h7M8.5 15h4.5"/></svg>`,
  switches: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="6" rx="3"/><circle cx="18" cy="8" r="1.6"/><rect x="3" y="13" width="18" height="6" rx="3"/><circle cx="6" cy="16" r="1.6"/></svg>`,
  explain: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5.5h16v10H9.5L5.5 19v-3.5H4z"/><path d="M12 8.5v3M12 13.4v.1"/></svg>`,
};
$$("[data-ic]").forEach((el) => { if (!el.innerHTML.trim()) el.innerHTML = ICONS[el.dataset.ic] ?? ""; });
fillMarks();

const MAC = {
  "bv-1": () => blockedWindow({ service: "ChatGPT", ruleName: "Tax file numbers", matchType: "au-tfn", matchCount: 1, example: "123***782", app: "com.google.Chrome.helper" }),
  "bv-2": () => blockedWindow({ service: "Claude", rule: "Surface block: claude-web", app: "com.google.Chrome.helper" }),
  "bv-3": () => blockedWindow({ service: "ChatGPT", ruleName: "Bulk email addresses", matchType: "email-bulk", matchCount: 14, app: "com.openai.chat", asked: true, requestAccess: true }),
  explain: () => blockedWindow({ service: "ChatGPT", ruleName: "Tax file numbers", matchType: "au-tfn", matchCount: 1, example: "123***782", app: "com.google.Chrome.helper", requestAccess: true }),
};
$$(".bv-v:not(.bv-shot)").forEach((el) => { el.innerHTML = `<div class="fit-in">${MAC[`bv-${el.dataset.i}`]()}</div>`; });
$$("[data-mac]").forEach((el) => { el.innerHTML = `<div class="fit-in">${MAC[el.dataset.mac]()}</div>`; });
const fitAll = () => $$("[data-scale]").forEach((el) => {
  const w = Number(el.dataset.scale);
  const inner = el.firstElementChild;
  if (!w || !inner) return;
  const s = el.clientWidth / w;
  inner.style.width = `${w}px`;
  inner.style.transform = `scale(${s})`;
  el.style.setProperty("--fit-h", `${inner.offsetHeight * s}px`);
});
fitAll();
if ("ResizeObserver" in window) { const ro = new ResizeObserver(() => fitAll()); $$("[data-scale]").forEach((el) => ro.observe(el)); }

const openFaq = () => { const t = location.hash && document.getElementById(location.hash.slice(1)); if (t?.tagName === "DETAILS") t.open = true; };
window.addEventListener("hashchange", openFaq);
$$('a[href^="#faq-"]').forEach((a) => a.addEventListener("click", () => { const t = document.getElementById(a.getAttribute("href").slice(1)); if (t?.tagName === "DETAILS") t.open = true; }));
openFaq();

const tray = $(".bento-tray");
if (tray) $$(".bt-in", tray).forEach((r) => r.addEventListener("change", () => { tray.dataset.active = r.value; }));

const tabs = $$(".tab");
if (tabs.length) {
  const cards = tabs.map((t) => document.getElementById(t.dataset.tab));
  const bar = $(".tabs-wrap");
  let raf = 0;
  const spy = () => {
    raf = 0;
    const line = (bar?.getBoundingClientRect().bottom ?? 0) + 24;
    let cur = -1;
    cards.forEach((c, k) => { const r = c.getBoundingClientRect(); if (r.top <= line + 40 && r.bottom > line) cur = k; });
    const sec = bar?.closest("section");
    const reached = sec && sec.getBoundingClientRect().top <= 1;
    if (!reached) cur = -1;
    else if (cur === -1 && cards[0].getBoundingClientRect().top > line) cur = 0;
    const last = cards[cards.length - 1].getBoundingClientRect();
    if (last.bottom <= line) cur = -1;
    tabs.forEach((t, k) => { if (k === cur) t.setAttribute("aria-current", "true"); else t.removeAttribute("aria-current"); });
  };
  window.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(spy); }, { passive: true });
  window.addEventListener("resize", spy);
  spy();
}

const REVEAL = [
  [".stats-in > .h2", ".stats-row > li"],
  [".bento-head", ".bento-tray"],
  [".feats-head"],
  [".fcard"],
  [".cta-in > *"],
  [".faq-l", ".faq-r"],
];
if (!reduced.matches && "IntersectionObserver" in window) {
  const io = new IntersectionObserver((es) => es.forEach((e) => {
    if (!e.isIntersecting) return;
    e.target.classList.add("rv-in");
    io.unobserve(e.target);
  }), { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });
  REVEAL.forEach((group) => {
    let i = 0;
    group.forEach((sel) => $$(sel).forEach((el) => {
      el.dataset.rv = "";
      if (!el.matches(".fcard")) el.style.setProperty("--rv-i", String(Math.min(i++, 4)));
      io.observe(el);
    }));
  });
  root.classList.add("rv");
  reduced.addEventListener("change", () => { if (reduced.matches) root.classList.remove("rv"); });
}
