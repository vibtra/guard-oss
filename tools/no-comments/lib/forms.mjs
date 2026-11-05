import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { headerOf, isDirective, isJsdocType } from "./kept-comments.mjs";
import { errorLine, parseSql, parseTree } from "./languages.mjs";

const goastDir = join(dirname(fileURLToPath(import.meta.url)), "..", "goast");

export const shortHash = (form) => createHash("sha256").update(form).digest("hex").slice(0, 12);

const compilerOptions = {
  removeComments: true,
  jsx: ts.JsxEmit.ReactJSX,
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.ESNext,
};

function jsxText(text) {
  let result;
  let first = 0;
  let last = -1;
  const add = (line) => {
    result = result === undefined ? line : `${result} ${line}`;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\n" || char === "\r") {
      if (first !== -1 && last !== -1) add(text.slice(first, last + 1));
      first = -1;
    } else if (char !== " " && char !== "\t") {
      last = index;
      if (first === -1) first = index;
    }
  }
  if (first !== -1) add(text.slice(first));
  return result;
}

const jsxChildren = (context) => {
  const { factory } = context;
  const clean = (children) =>
    factory.createNodeArray(
      children.flatMap((child) => {
        if (ts.isJsxExpression(child) && !child.expression) return [];
        if (!ts.isJsxText(child)) return [child];
        const text = jsxText(child.text);
        return text === undefined ? [] : [factory.createJsxText(text)];
      }),
    );
  const visit = (node) => {
    const next = ts.visitEachChild(node, visit, context);
    if (ts.isJsxElement(next)) {
      return factory.updateJsxElement(next, next.openingElement, clean(next.children), next.closingElement);
    }
    if (ts.isJsxFragment(next)) {
      return factory.updateJsxFragment(next, next.openingFragment, clean(next.children), next.closingFragment);
    }
    return next;
  };
  return (file) => ts.visitNode(file, visit);
};

function typescriptForm(path, text) {
  const fileName = path.replace(/\.d\.([cm]?ts)$/, ".$1");
  const output = ts.transpileModule(text, { fileName, compilerOptions, reportDiagnostics: true });
  const error = output.diagnostics?.find((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (error) {
    const line = error.file && error.start !== undefined ? error.file.getLineAndCharacterOfPosition(error.start).line + 1 : 0;
    throw new Error(`parse error at line ${line}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  }
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest);
  const result = ts.transform(source, [jsxChildren]);
  const printed = ts.createPrinter({ removeComments: true }).printFile(result.transformed[0]);
  result.dispose();
  return `${output.outputText}\n\0\n${printed}`;
}

export function typescriptKeptComments(path, text) {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const lineOf = (position) => source.getLineAndCharacterOfPosition(position).line + 1;
  const comments = new Map();
  const collect = (ranges) => {
    for (const { pos, end, kind } of ranges ?? []) {
      if (comments.has(pos)) continue;
      const raw = text.slice(pos, end);
      const line = kind === ts.SyntaxKind.SingleLineCommentTrivia;
      comments.set(pos, { raw, pos, type: line ? "Line" : "Block", value: line ? raw.slice(2) : raw.slice(2, -2), loc: { start: { line: lineOf(pos) }, end: { line: lineOf(end) } } });
    }
  };
  const visit = (node) => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    for (const child of node.getChildren(source)) visit(child);
  };
  visit(source);
  const header = headerOf((ts.getLeadingCommentRanges(text, 0) ?? []).map(({ pos }) => comments.get(pos)));
  return [...comments.values()]
    .sort((a, b) => a.pos - b.pos)
    .flatMap((comment) => {
      if (header.has(comment)) return [`licence ${comment.raw}`];
      if (isDirective(comment) || isJsdocType(comment, path)) return [`directive ${comment.raw}`];
      return [];
    });
}

function treeItems(language, tree, text) {
  const comments = new Set(language.comments);
  const items = [];
  let position = 0;
  const uncovered = (until) => {
    if (until <= position) return;
    const region = text.slice(position, until);
    const lead = region.length - region.trimStart().length;
    const trail = region.length - region.trimEnd().length;
    if (lead < region.length) items.push({ kind: "text", label: "~", start: position + lead, end: until - trail });
    position = until;
  };
  const cursor = tree.walk();
  try {
    let descend = true;
    for (;;) {
      if (descend) {
        const { startIndex: start, endIndex: end, nodeType: type, currentFieldName: field } = cursor;
        const label = field ? `${field}:${type}` : type;
        uncovered(start);
        if (comments.has(type)) {
          items.push({ kind: "comment", start, end });
          position = end;
        } else if (cursor.gotoFirstChild()) {
          items.push({ kind: "open", label });
          continue;
        } else {
          items.push({ kind: "text", label, start, end });
          position = end;
        }
      }
      if (cursor.gotoNextSibling()) {
        descend = true;
        continue;
      }
      if (!cursor.gotoParent()) break;
      uncovered(cursor.endIndex);
      items.push({ kind: "close" });
      descend = false;
    }
  } finally {
    cursor.delete();
  }
  uncovered(text.length);
  return items;
}

function treeForm(items, text) {
  const parts = [];
  for (const item of items) {
    if (item.kind === "open") parts.push(`(${item.label}`);
    else if (item.kind === "close") parts.push(")");
    else if (item.kind === "text") parts.push(`${item.label} ${JSON.stringify(text.slice(item.start, item.end))}`);
  }
  return parts.join("\n");
}

function separator(gap) {
  const newline = gap.lastIndexOf("\n");
  if (newline >= 0) return `\n${gap.slice(newline + 1)}`;
  return /\s/.test(gap) ? " " : "";
}

function flatForm(language, items, text) {
  const commentIsSpace = language.commentIsSpace !== false;
  const parts = [];
  let gap = "";
  let position = 0;
  for (const { kind, start, end } of items) {
    if (kind === "comment") {
      const comment = text.slice(start, end);
      gap += text.slice(position, start) + (commentIsSpace ? (comment.includes("\n") ? "\n" : " ") : "");
      position = end;
    } else if (kind === "text" && end > start) {
      gap += text.slice(position, start);
      parts.push(parts.length > 0 ? separator(gap) : "", JSON.stringify(text.slice(start, end)));
      gap = "";
      position = end;
    }
  }
  return parts.join("");
}

const sqlPosition = /^(?:location|stmt_len)$|_location$|list_(?:start|end)$/;

async function sqlForm(text) {
  let tree;
  try {
    tree = await parseSql(text);
  } catch (error) {
    throw new Error(`parse error: ${error.message}`, { cause: error });
  }
  return JSON.stringify(tree, (key, value) => (sqlPosition.test(key) ? undefined : value));
}

function goast(mode, files) {
  const run = spawnSync("go", ["run", ".", mode], {
    cwd: goastDir,
    input: JSON.stringify(files),
    encoding: "utf8",
    maxBuffer: 1 << 30,
    env: { ...process.env, GOWORK: "off", GOFLAGS: "", GOTOOLCHAIN: "local" },
  });
  if (run.error) throw new Error(`cannot run go: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`go run ${goastDir} failed: ${run.stderr.trim()}`);
  return JSON.parse(run.stdout);
}

export function gofmtSources(files) {
  return goast("format", files);
}

export async function normalForms(entries) {
  const results = [];
  const go = [];
  for (const [index, { path, language, text }] of entries.entries()) {
    if (language.form === "go") {
      go.push(index);
      continue;
    }
    try {
      if (language.form === "typescript") {
        results[index] = { form: typescriptForm(path, text) };
      } else if (language.form === "sql") {
        results[index] = { form: await sqlForm(text) };
      } else {
        const tree = await parseTree(language, text);
        try {
          const partial = errorLine(tree);
          const items = treeItems(language, tree, text);
          results[index] = { form: treeForm(items, text), flat: flatForm(language, items, text), partial };
        } finally {
          tree.delete();
        }
      }
    } catch (error) {
      results[index] = { error: error.message };
    }
  }
  if (go.length > 0) {
    const printed = goast("print", go.map((index) => ({ name: entries[index].path, source: entries[index].text })));
    go.forEach((index, position) => {
      const { printed: form, error } = printed[position];
      results[index] = error ? { error: `parse error: ${error}` } : { form };
    });
  }
  return results;
}
