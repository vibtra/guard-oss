const DIRECTIVE =
  /^(?:eslint-(?:disable|enable)\b|@ts-(?:expect-error|nocheck)\b|\/\s*<reference\b|@vitest-environment\b|@jsxImportSource\b|[#@]__PURE__\b|webpack[A-Z]\w*\s*:|@vite-ignore\b|(?:c8|v8|istanbul) ignore\b|prettier-ignore\b|#\s*sourceMappingURL=)/;
const JS_FILE = /\.(?:js|mjs|cjs)$/;
const JSDOC_TYPE = /@(?:type|typedef|template|satisfies|import)\b|@param\s*\{|@returns\s*\{/;
const MARKER = /SPDX-|Copyright|@license|Licensed under|Provenance:/;
const TAG = /^(?:SPDX-[A-Za-z-]+:|Copyright\b)/;
const LICENCE = /licen[cs]e|copyright|warrant|permission|redistribut|spdx-|rights reserved/i;

export const isDirective = (comment) => DIRECTIVE.test(comment.value.replace(/^[\s*]+/, ""));

export const isJsdocType = (comment, filename) =>
  comment.type === "Block" && comment.value.startsWith("*") && JS_FILE.test(filename) && JSDOC_TYPE.test(comment.value);

const style = (comment) => {
  if (comment.type === "Block") return "block";
  if (comment.value.startsWith("/")) return "///";
  if (comment.value.startsWith("!")) return "//!";
  return "//";
};

const isEmptyLine = (comment) => comment.type === "Line" && comment.value.trim() === "";

const textOf = (paragraph) => paragraph.map((comment) => comment.value).join("\n");

const paragraphsOf = (comments) => {
  const units = [];
  for (const comment of comments) {
    if (isEmptyLine(comment)) {
      units.push({ separator: comment });
      continue;
    }
    const last = units.at(-1);
    const previous = last?.paragraph?.at(-1);
    const joins =
      previous !== undefined &&
      comment.type === "Line" &&
      style(previous) === style(comment) &&
      comment.loc.start.line === previous.loc.end.line + 1;
    if (joins) last.paragraph.push(comment);
    else units.push({ paragraph: [comment] });
  }
  return units;
};

const qualifies = (paragraph) =>
  (paragraph[0].type === "Block" && paragraph[0].value.startsWith("!")) || MARKER.test(textOf(paragraph));

const keptFromFirst = (paragraph) => {
  if (paragraph[0].type !== "Line" || !TAG.test(paragraph[0].value.trim())) return paragraph;
  let tags = 0;
  while (tags < paragraph.length && TAG.test(paragraph[tags].value.trim())) tags += 1;
  const rest = paragraph.slice(tags);
  return rest.length === 0 || LICENCE.test(textOf(rest)) ? paragraph : paragraph.slice(0, tags);
};

export const headerOf = (leading) => {
  const units = paragraphsOf(leading);
  const firstIndex = units.findIndex((unit) => unit.paragraph !== undefined);
  const kept = new Set();
  if (firstIndex === -1 || !qualifies(units[firstIndex].paragraph)) return kept;
  const first = units[firstIndex].paragraph;
  for (const comment of keptFromFirst(first)) kept.add(comment);
  let pending = [];
  for (const unit of units.slice(firstIndex + 1)) {
    if (unit.separator !== undefined) {
      pending.push(unit.separator);
      continue;
    }
    const sameStyle = style(unit.paragraph[0]) === style(first[0]);
    if (!sameStyle || !LICENCE.test(textOf(unit.paragraph))) break;
    for (const comment of [...pending, ...unit.paragraph]) kept.add(comment);
    pending = [];
  }
  return kept;
};
