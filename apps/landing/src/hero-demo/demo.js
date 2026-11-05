import clips from "./media/clips.json";

const SURF = [
  { id: "claude-web", full: "Claude website" },
  { id: "chatgpt-web", full: "ChatGPT website" },
  { id: "claude-mac", full: "Claude for Mac" },
  { id: "chatgpt-mac", full: "ChatGPT for Mac + Codex" },
];
const media = (f) => new URL(`./media/${f}`, import.meta.url).href;

const root = document.querySelector("[data-ard]");
if (root) {
  const video = root.querySelector(".ard-video");
  const cap = root.querySelector(".ard-cap");
  const playBtn = root.querySelector(".ard-play");
  const pauseBtn = root.querySelector(".ard-pause");
  let held = false;
  const PAUSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>';
  const PLAY_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10.5-6.5z"/></svg>';
  const syncPause = () => {
    if (!pauseBtn) return;
    pauseBtn.hidden = reduced.matches;
    pauseBtn.innerHTML = `${held ? PLAY_ICON : PAUSE_ICON}<span>${held ? "Play demo" : "Pause demo"}</span>`;
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const phone = window.matchMedia("(max-width: 599px)");
  const wide = window.matchMedia("(min-width: 992px)");
  const cut = () => (phone.matches ? "-m" : wide.matches ? "-w" : "");
  const posterT = (id) => (phone.matches ? clips[id]?.mobilePosterT : wide.matches ? clips[id]?.widePosterT : clips[id]?.posterT) ?? 0;

  const main = document.querySelector('[data-section="trust"] .trust-chips');
  const chips = main ? SURF.map((s) => [...main.children].find((li) => li.textContent.trim() === s.full)) : [];
  if (main) {
    main.setAttribute("role", "tablist");
    main.setAttribute("aria-label", "Play the demo for a covered surface");
  }
  chips.forEach((li, i) => {
    if (!li) return;
    li.classList.add("ard-sel");
    li.insertAdjacentHTML("beforeend", '<span class="ard-bar" aria-hidden="true"><i></i></span>');
    li.setAttribute("role", "tab"); li.tabIndex = -1; li.setAttribute("aria-selected", "false");
    li.addEventListener("click", () => pick(i));
  });

  let cur = -1, onScreen = true;
  const cueAt = (i, t) => { const c = clips[SURF[i].id]?.cues ?? []; let s = c[0]?.[1] ?? ""; for (const [ct, txt] of c) if (t >= ct) s = txt; return s; };
  const setCap = (s) => { if (cap.textContent !== s) cap.textContent = s; };
  const bars = (i, k) => { const b = chips[i]?.querySelector(".ard-bar i"); if (b) b.style.transform = `scaleX(${k})`; };

  function show(i, { play = true, focus = false } = {}) {
    cur = (i + SURF.length) % SURF.length;
    const s = SURF[cur];
    chips.forEach((li, k) => {
      if (!li) return;
      li.setAttribute("aria-selected", String(k === cur));
      li.tabIndex = k === cur ? 0 : -1;
    });
    SURF.forEach((_, k) => bars(k, 0));
    if (focus) chips[cur]?.focus();
    const c = cut();
    video.poster = media(`${s.id}${c}-${reduced.matches ? "poster" : "start"}.webp`);
    video.innerHTML = `<source src="${media(`${s.id}${c}.webm`)}" type="video/webm"><source src="${media(`${s.id}${c}.mp4`)}" type="video/mp4">`;
    video.load();
    video.setAttribute("aria-label", `${s.full}: ${(clips[s.id]?.cues ?? []).map((x) => x[1]).join(" ")}`);
    setCap(cueAt(cur, reduced.matches ? posterT(s.id) : 0));
    playBtn.hidden = !reduced.matches;
    syncPause();
    if (play) tryPlay();
  }
  function pick(i) { held = false; if (i !== cur || video.ended) show(i); else { video.currentTime = 0; syncPause(); tryPlay(); } }
  function tryPlay() {
    if (reduced.matches || held || !onScreen || document.hidden) return;
    const p = video.play(); if (p) p.catch(() => {});
  }
  function tick() {
    requestAnimationFrame(tick);
    if (cur < 0 || !video.duration) return;
    bars(cur, Math.min(1, video.currentTime / video.duration));
    if (!reduced.matches || !video.paused) setCap(cueAt(cur, video.currentTime));
  }
  video.addEventListener("ended", () => { if (reduced.matches) { playBtn.hidden = false; return; } if (!held) show(cur + 1); });

  main?.addEventListener("keydown", (e) => {
    const k = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (k) { e.preventDefault(); show(cur + k, { focus: true }); }
    if (e.key === "Home") { e.preventDefault(); show(0, { focus: true }); }
    if (e.key === "End") { e.preventDefault(); show(SURF.length - 1, { focus: true }); }
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(cur); }
  });
  playBtn.addEventListener("click", () => { playBtn.hidden = true; video.currentTime = 0; const p = video.play(); if (p) p.catch(() => {}); });
  pauseBtn?.addEventListener("click", () => {
    held = !held;
    syncPause();
    if (held) video.pause(); else tryPlay();
  });

  new IntersectionObserver((es) => { onScreen = es[0].isIntersecting; if (onScreen) tryPlay(); else video.pause(); }, { threshold: 0.25 }).observe(root);
  document.addEventListener("visibilitychange", () => { if (document.hidden) video.pause(); else tryPlay(); });
  for (const mq of [reduced, phone, wide]) mq.addEventListener("change", () => show(cur, { play: true }));

  show(0);
  requestAnimationFrame(tick);
}
