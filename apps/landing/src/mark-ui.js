import { MARKS, markIdFor } from "./marks/index.js";

let n = 0;
export function markSvgUnique(id) {
  const svg = MARKS[id]?.svg;
  if (!svg) return "";
  const k = `u${++n}`;
  let out = svg;
  for (const [, i] of svg.matchAll(/\bid="([^"]+)"/g)) {
    out = out.split(`id="${i}"`).join(`id="${i}-${k}"`).split(`#${i})`).join(`#${i}-${k})`).split(`"#${i}"`).join(`"#${i}-${k}"`);
  }
  return out;
}

export function markHtml(nameOrId, cls = "mk-i") {
  const id = MARKS[nameOrId] ? nameOrId : markIdFor(nameOrId);
  return id ? `<span class="${cls}" aria-hidden="true">${markSvgUnique(id)}</span>` : "";
}

export function fillMarks(root = document) {
  root.querySelectorAll("[data-mark]").forEach((el) => {
    if (!el.innerHTML.trim()) el.innerHTML = markSvgUnique(el.dataset.mark);
    el.setAttribute("aria-hidden", "true");
  });
}
