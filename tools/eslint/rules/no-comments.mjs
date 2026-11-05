import { headerOf, isDirective, isJsdocType } from "./kept-comments.mjs";

const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;
const SINGLE_TOKEN = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);

const leadingOf = (sourceCode) => {
  const firstToken = sourceCode.ast.tokens[0];
  const end = firstToken === undefined ? Number.POSITIVE_INFINITY : firstToken.range[0];
  return sourceCode.getAllComments().filter((comment) => comment.type !== "Shebang" && comment.range[1] <= end);
};

const lineStartOf = (text, index) => text.lastIndexOf("\n", index - 1) + 1;

const lineEndOf = (text, index) => {
  const found = text.indexOf("\n", index);
  return found === -1 ? text.length : found;
};

const throughNewline = (text, index) => (index < text.length ? index + 1 : index);

const spacesBefore = (text, index) => {
  let start = index;
  while (start > 0 && /[^\S\r\n\u2028\u2029]/.test(text[start - 1])) start -= 1;
  return index - start;
};

const spacesAfter = (text, index) => {
  let end = index;
  while (end < text.length && /[^\S\r\n\u2028\u2029]/.test(text[end])) end += 1;
  return end - index;
};

const standsAlone = (text, [start, end]) =>
  text.slice(lineStartOf(text, start), start).trim() === "" && text.slice(end, lineEndOf(text, end)).trim() === "";

const wholeLines = (text, [start, end]) => [lineStartOf(text, start), throughNewline(text, lineEndOf(text, end))];

const isBlank = (line) => line !== undefined && line.trim() === "";

const tidy = (text, [start, end]) => {
  if (start === 0) {
    let next = end;
    while (next < text.length && isBlank(text.slice(next, lineEndOf(text, next)))) next = throughNewline(text, lineEndOf(text, next));
    return [start, next];
  }
  const aboveStart = lineStartOf(text, start - 1);
  const above = text.slice(aboveStart, start - 1);
  const belowEnd = lineEndOf(text, end);
  const below = end === text.length ? undefined : text.slice(end, belowEnd);
  if (isBlank(below) && (isBlank(above) || /[{[(]\s*$/.test(above))) return [start, throughNewline(text, belowEnd)];
  if (isBlank(above) && (below === undefined || /^\s*[}\])]/.test(below))) return [aboveStart, end];
  return [start, end];
};

const inlineRemoval = (text, comment) => {
  const [start, end] = comment.range;
  const before = spacesBefore(text, start);
  const after = spacesAfter(text, end);
  const lineStart = lineStartOf(text, start);
  const lineEnd = lineEndOf(text, end);
  if (end + after === lineEnd || text.slice(end + after, lineEnd).trim() === "") {
    return { range: [start - before, end + after], text: "" };
  }
  if (start - before === lineStart) return { range: [start, end + after], text: "" };
  const lineBreak = LINE_BREAK.exec(text.slice(start, end));
  if (lineBreak !== null) {
    const indent = /^[^\S\r\n]*/.exec(text.slice(lineStartOf(text, end), end))[0];
    return { range: [start - before, end + after], text: `${lineBreak[0]}${indent}` };
  }
  const previous = text[start - before - 1];
  const next = text[end + after];
  if (before > 0 && after > 0) return { range: [start - before, end], text: "" };
  if (before > 0) return { range: SINGLE_TOKEN.has(next) ? [start - before, end] : [start, end], text: "" };
  if (after > 0) return { range: SINGLE_TOKEN.has(previous) ? [start, end + after] : [start, end], text: "" };
  return { range: [start, end], text: SINGLE_TOKEN.has(previous) || SINGLE_TOKEN.has(next) ? "" : " " };
};

const emptyContainerOf = (sourceCode, comment) => {
  const node = sourceCode.getNodeByRangeIndex(comment.range[0]);
  if (node?.type === "JSXEmptyExpression") return node.parent;
  if (node?.type === "JSXExpressionContainer" && node.expression.type === "JSXEmptyExpression") return node;
  return undefined;
};

const hasText = (node) => node?.type === "JSXText" && node.value.trim() !== "";

const splitsText = (container) => {
  const siblings = container.parent?.children ?? [];
  const index = siblings.indexOf(container);
  return hasText(siblings[index - 1]) && hasText(siblings[index + 1]);
};

export default {
  meta: {
    type: "suggestion",
    languages: ["js/js"],
    docs: {
      description: "Disallow comments other than a licence header, a tool directive or a JSDoc type block in a .js, .mjs or .cjs file",
    },
    fixable: "code",
    schema: [],
    messages: {
      comment: "Remove this comment. Only a licence header, a tool directive or a JSDoc type block in a .js, .mjs or .cjs file may stay.",
    },
  },
  create(context) {
    const { sourceCode } = context;
    const { text } = sourceCode;
    return {
      Program() {
        const header = headerOf(leadingOf(sourceCode));
        const reported = sourceCode
          .getAllComments()
          .filter(
            (comment) =>
              comment.type !== "Shebang" &&
              !header.has(comment) &&
              !isDirective(comment) &&
              !isJsdocType(comment, context.filename),
          );
        const removable = new Set(reported);
        const removals = new Map();
        const runs = [];
        let run;
        for (const comment of reported) {
          const container = emptyContainerOf(sourceCode, comment);
          if (container !== undefined) {
            run = undefined;
            const inside = sourceCode
              .getAllComments()
              .filter((other) => other.range[0] >= container.range[0] && other.range[1] <= container.range[1]);
            const lines = inside.every((other) => removable.has(other)) && standsAlone(text, container.range) && !splitsText(container);
            removals.set(comment, lines ? { range: wholeLines(text, container.range), text: "" } : { range: comment.range, text: "" });
            continue;
          }
          if (!standsAlone(text, comment.range)) {
            run = undefined;
            removals.set(comment, inlineRemoval(text, comment));
            continue;
          }
          const lines = wholeLines(text, comment.range);
          if (run !== undefined && run.range[1] === lines[0]) {
            run.range[1] = lines[1];
          } else {
            run = { range: lines, text: "" };
            runs.push(run);
          }
          removals.set(comment, run);
        }
        for (const each of runs) each.range = tidy(text, each.range);
        for (const comment of reported) {
          const removal = removals.get(comment);
          context.report({
            loc: comment.loc,
            messageId: "comment",
            fix: (fixer) => fixer.replaceTextRange([...removal.range], removal.text),
          });
        }
      },
    };
  },
};
