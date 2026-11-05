const commentRanges = (sourceCode) =>
  typeof sourceCode.getAllComments === "function"
    ? sourceCode.getAllComments().map((comment) => comment.range)
    : sourceCode.comments.map((comment) => [comment.loc.start.offset, comment.loc.end.offset]);

export const uncommented = (sourceCode, hidden = []) => {
  const { text } = sourceCode;
  let kept = "";
  let last = 0;
  for (const [start, end] of [...commentRanges(sourceCode), ...hidden].toSorted(([a], [b]) => a - b)) {
    if (end <= last) continue;
    const from = Math.max(start, last);
    kept += `${text.slice(last, from)}${" ".repeat(end - from)}`;
    last = end;
  }
  return `${kept}${text.slice(last)}`;
};

export const reportMatches = (context, pattern, messageId, hidden) => {
  const { sourceCode } = context;
  for (const match of uncommented(sourceCode, hidden).matchAll(pattern)) {
    context.report({
      loc: { start: sourceCode.getLocFromIndex(match.index), end: sourceCode.getLocFromIndex(match.index + match[0].length) },
      messageId,
      data: { colour: match[0] },
    });
  }
};
