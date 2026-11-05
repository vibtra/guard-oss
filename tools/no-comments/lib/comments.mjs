import { errorLine, parseTree, scanSql } from "./languages.mjs";

const markers = /SPDX-|Copyright|@license|Licensed under|Provenance:/;
const licenceWords = /licen[cs]e|copyright|warrant|permission|redistribut|spdx-|rights reserved/i;
const tagLine = /^(?:SPDX-[A-Za-z-]+:|Copyright\b)/;

function describe(language, text, { start, end, unparsed }) {
  let stop = end;
  while (stop > start && (text[stop - 1] === "\n" || text[stop - 1] === "\r")) stop -= 1;
  const raw = text.slice(start, stop);
  const block = raw.startsWith("/*");
  const style = block
    ? raw.slice(0, raw[2] === "*" || raw[2] === "!" ? 3 : 2)
    : (language.prefixes.find((prefix) => raw.startsWith(prefix)) ?? "");
  const body = block
    ? raw.slice(2, raw.endsWith("*/") && raw.length >= 4 ? -2 : undefined).replace(/^[*!\s]+/, "").trim()
    : raw.slice(style.length).trim();
  return { start, end: stop, line: 0, text: raw, block, style, body, kept: null, unparsed };
}

function walkTree(tree, language) {
  const types = new Set(language.comments);
  const spans = [];
  const cgo = [];
  const cursor = tree.walk();
  const errorStack = [];
  let errorDepth = 0;
  try {
    let descend = true;
    for (;;) {
      if (descend) {
        const type = cursor.nodeType;
        if (types.has(type)) {
          spans.push({ start: cursor.startIndex, end: cursor.endIndex, unparsed: errorDepth > 0 });
        } else {
          if (type === "import_spec") {
            const spec = cursor.currentNode;
            if (spec.childForFieldName("path")?.text === '"C"') {
              cgo.push(spec.startIndex);
              if (spec.parent?.type === "import_declaration") cgo.push(spec.parent.startIndex);
            }
          }
          const error = type === "ERROR";
          if (cursor.gotoFirstChild()) {
            errorStack.push(error);
            if (error) errorDepth += 1;
            continue;
          }
        }
      }
      if (cursor.gotoNextSibling()) {
        descend = true;
        continue;
      }
      if (!cursor.gotoParent()) break;
      if (errorStack.pop()) errorDepth -= 1;
      descend = false;
    }
  } finally {
    cursor.delete();
  }
  return { spans, cgo };
}

const newlines = (gap) => gap.split("\n").length - 1;

function markCgo(text, comments, targets) {
  for (const target of targets) {
    let index = comments.findLastIndex((comment) => comment.end <= target);
    if (index < 0 || !/^[ \t]*\r?\n[ \t]*$/.test(text.slice(comments[index].end, target))) continue;
    comments[index].kept ??= "cgo";
    while (index > 0 && /^\s*$/.test(text.slice(comments[index - 1].end, comments[index].start))) {
      if (newlines(text.slice(comments[index - 1].end, comments[index].start)) > 1) break;
      index -= 1;
      comments[index].kept ??= "cgo";
    }
  }
}

function headerUnits(text, leading) {
  const units = [];
  let previous = null;
  for (const comment of leading) {
    const blankBefore = previous !== null && newlines(text.slice(previous.end, comment.start)) > 1;
    previous = comment;
    if (!comment.block && comment.body === "") {
      units.push({ separator: comment });
      continue;
    }
    const last = units.at(-1);
    if (!comment.block && last && !last.separator && !last.block && last.style === comment.style && !blankBefore) {
      last.comments.push(comment);
    } else {
      units.push({ block: comment.block, style: comment.style, comments: [comment] });
    }
  }
  return units;
}

function markHeader(language, text, comments) {
  const leading = [];
  let position = 0;
  for (const comment of comments) {
    if (/\S/.test(text.slice(position, comment.start))) break;
    leading.push(comment);
    position = comment.end;
  }
  if (leading[0]?.kept === "shebang") leading.shift();
  const units = headerUnits(text, leading);
  const firstIndex = units.findIndex((unit) => !unit.separator);
  if (firstIndex < 0) return;
  const first = units[firstIndex];
  const pinned = first.block && first.style === "/*!" && !language.bangIsDoc;
  if (!pinned && !markers.test(first.comments.map((comment) => comment.text).join("\n"))) return;
  const keep = new Set();
  const prose = first.block ? 0 : first.comments.findIndex((comment) => !tagLine.test(comment.body));
  const tags = prose < 0 ? first.comments.length : prose;
  const rest = first.comments.slice(tags);
  const licensed = tags === 0 || (rest.length > 0 && licenceWords.test(rest.map((comment) => comment.body).join(" ")));
  (licensed ? first.comments : first.comments.slice(0, tags)).forEach((comment) => keep.add(comment));
  let lastKept = firstIndex;
  for (let index = firstIndex + 1; index < units.length; index += 1) {
    const unit = units[index];
    if (unit.separator) continue;
    if (unit.block !== first.block || unit.style !== first.style) break;
    if (!licenceWords.test(unit.comments.map((comment) => comment.text).join("\n"))) break;
    unit.comments.forEach((comment) => keep.add(comment));
    for (let between = lastKept + 1; between < index; between += 1) keep.add(units[between].separator);
    lastKept = index;
  }
  for (const comment of keep) comment.kept ??= "licence";
}

function numberLines(text, comments) {
  let line = 1;
  let position = 0;
  for (const comment of comments) {
    for (let index = text.indexOf("\n", position); index !== -1 && index < comment.start; index = text.indexOf("\n", index + 1)) {
      line += 1;
    }
    position = comment.start;
    comment.line = line;
  }
}

export async function findComments(language, text) {
  let spans;
  let cgo = [];
  let parseErrorLine = 0;
  if (language.form === "sql") {
    spans = await scanSql(text);
  } else {
    const tree = await parseTree(language, text);
    try {
      ({ spans, cgo } = walkTree(tree, language));
      parseErrorLine = errorLine(tree);
    } finally {
      tree.delete();
    }
  }
  const comments = spans.map((span) => describe(language, text, { unparsed: false, ...span }));
  numberLines(text, comments);
  for (const comment of comments) {
    if (comment.start === 0 && comment.text.startsWith("#!")) comment.kept = "shebang";
    else if (language.directive(comment)) comment.kept = "directive";
  }
  markCgo(text, comments, cgo);
  markHeader(language, text, comments);
  return { comments, errorLine: parseErrorLine };
}

function splitLines(text) {
  const lines = [];
  for (let start = 0; start < text.length; ) {
    const newline = text.indexOf("\n", start);
    const next = newline < 0 ? text.length : newline + 1;
    const end = newline < 0 ? text.length : newline > start && text[newline - 1] === "\r" ? newline - 1 : newline;
    lines.push({ start, end, next });
    start = next;
  }
  return lines;
}

const opener = /[([{]/;
const closer = /[)\]},;]/;
const tight = /[()[\]{},;]/;

function joinLine(parts, indent, commentIsSpace) {
  let out = parts[0] === null ? indent : "";
  let cut = false;
  for (const part of parts) {
    if (part === null) {
      cut = true;
      continue;
    }
    if (!cut) {
      out += part;
      continue;
    }
    const rest = part.replace(/^[ \t]+/, "");
    if (rest === "") continue;
    cut = false;
    if (/^[ \t]*$/.test(out)) {
      out += rest;
      continue;
    }
    const left = out.replace(/[ \t]+$/, "");
    const spaced = left.length < out.length || rest.length < part.length;
    const l = left.at(-1);
    const r = rest[0];
    const keepTogether = !spaced && (!commentIsSpace || tight.test(l) || tight.test(r));
    const space = opener.test(l) || closer.test(r) || keepTogether ? "" : " ";
    out = left + space + rest;
  }
  return cut ? out.replace(/[ \t]+$/, "") : out;
}

const blank = (value) => value !== null && /^[ \t]*$/.test(value);

export const removable = (comment) => !comment.kept && !comment.unparsed;

export function strip(language, text, comments) {
  const cuts = comments.filter(removable);
  if (cuts.length === 0) return text;
  const lines = splitLines(text);
  const out = [];
  const dropped = [];
  let first = 0;
  for (const { start, end } of lines) {
    while (first < cuts.length && cuts[first].end <= start) first += 1;
    const parts = [];
    let position = start;
    let indent = "";
    for (let index = first; index < cuts.length && cuts[index].start < end; index += 1) {
      const cut = cuts[index];
      if (cut.start < start) {
        const from = text.lastIndexOf("\n", cut.start - 1) + 1;
        indent = text.slice(from).match(/^[ \t]*/)[0];
      }
      if (cut.start > position) parts.push(text.slice(position, cut.start));
      parts.push(null);
      position = Math.max(position, Math.min(cut.end, end));
    }
    if (parts.length === 0) {
      out.push(text.slice(start, end));
      dropped.push(false);
      continue;
    }
    if (position < end) parts.push(text.slice(position, end));
    const line = joinLine(parts, indent, language.commentIsSpace !== false);
    const gone = /^[ \t]*$/.test(line);
    out.push(gone ? null : line);
    dropped.push(gone);
  }
  for (let index = 0; index < lines.length; index += 1) {
    if (!dropped[index]) continue;
    let last = index;
    while (last + 1 < lines.length && dropped[last + 1]) last += 1;
    let before = index - 1;
    while (before >= 0 && out[before] === null) before -= 1;
    let after = last + 1;
    while (after < lines.length && out[after] === null) after += 1;
    if ((before < 0 || blank(out[before])) && after < lines.length && blank(out[after])) out[after] = null;
    else if (after >= lines.length && before >= 0 && blank(out[before])) out[before] = null;
    index = last;
  }
  let result = "";
  lines.forEach(({ end, next }, index) => {
    if (out[index] !== null) result += out[index] + text.slice(end, next);
  });
  return result;
}

export const fixedComments = (comments) =>
  comments.filter((comment) => comment.kept || comment.unparsed).map((comment) => `${comment.kept ?? "unparsed"} ${comment.text}`);
