import * as React from "react";

const ACTIVE =
  ':is([aria-selected="true"], [aria-current="page"], [aria-pressed="true"], [aria-checked="true"], [data-state="active"])';

interface Placed {
  pill: HTMLSpanElement;
  resize: ResizeObserver;
  mutate: MutationObserver;
}

function activeOf(track: HTMLElement): HTMLElement | null {
  for (const hit of track.querySelectorAll<HTMLElement>(ACTIVE)) {
    if (hit.closest("[data-tab-track]") === track && hit.getAttribute("data-slot") !== "tab-indicator") return hit;
  }
  return null;
}

function place(track: HTMLElement, pill: HTMLSpanElement, animate: boolean) {
  const tab = activeOf(track);
  if (tab === null || tab.offsetWidth === 0) {
    pill.hidden = true;
    track.removeAttribute("data-indicator");
    return;
  }
  if (!animate) pill.style.transition = "none";
  pill.hidden = false;
  pill.style.translate = `${tab.offsetLeft}px ${tab.offsetTop}px`;
  pill.style.width = `${tab.offsetWidth}px`;
  pill.style.height = `${tab.offsetHeight}px`;
  track.setAttribute("data-indicator", "on");
  if (!animate) {
    void pill.offsetWidth;
    pill.style.transition = "";
  }
}

function attach(track: HTMLElement): Placed {
  const pill = document.createElement(track.tagName === "UL" || track.tagName === "OL" ? "li" : "span");
  pill.setAttribute("role", "presentation");
  pill.setAttribute("data-slot", "tab-indicator");
  pill.setAttribute("aria-hidden", "true");
  pill.className = "v-tab-indicator";
  track.prepend(pill);
  place(track, pill, false);
  const resize = new ResizeObserver(() => place(track, pill, false));
  resize.observe(track);
  const mutate = new MutationObserver(() => place(track, pill, true));
  mutate.observe(track, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["aria-selected", "aria-current", "aria-pressed", "aria-checked", "data-state"],
  });
  return { pill, resize, mutate };
}

export function TabIndicators() {
  React.useEffect(() => {
    if (typeof ResizeObserver === "undefined" || typeof MutationObserver === "undefined") return undefined;
    const placed = new Map<HTMLElement, Placed>();
    const scan = () => {
      for (const track of document.querySelectorAll<HTMLElement>("[data-tab-track]")) {
        if (!placed.has(track)) placed.set(track, attach(track));
      }
      for (const [track, hold] of placed) {
        if (track.isConnected) continue;
        hold.resize.disconnect();
        hold.mutate.disconnect();
        placed.delete(track);
      }
    };
    scan();
    let queued = false;
    const body = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    });
    body.observe(document.body, { childList: true, subtree: true });
    return () => {
      body.disconnect();
      for (const [track, hold] of placed) {
        hold.resize.disconnect();
        hold.mutate.disconnect();
        hold.pill.remove();
        track.removeAttribute("data-indicator");
      }
      placed.clear();
    };
  }, []);
  return null;
}
