import { createRequire } from "node:module";
import { extname } from "node:path";
import { loadModule, parseSync, scanSync } from "libpg-query";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

const rawPrefix = (prefixes) => (comment) => prefixes.some((prefix) => comment.text.startsWith(prefix));
const bodyPrefix = (prefixes) => (comment) => prefixes.some((prefix) => comment.body.startsWith(prefix));
const hashDirective = (pattern) => {
  const directive = new RegExp(`#\\s*(?:${pattern})`);
  return (comment) => directive.test(comment.text);
};
const none = () => false;

export const languages = {
  go: {
    name: "go",
    grammar: "tree-sitter-go/tree-sitter-go.wasm",
    comments: ["comment"],
    prefixes: ["//"],
    directive: rawPrefix(["//go:", "//nolint", "// +build", "//export", "//line"]),
    form: "go",
  },
  rust: {
    name: "rust",
    grammar: "@lumis-sh/wasm-rust/tree-sitter-rust.wasm",
    comments: ["line_comment", "block_comment"],
    prefixes: ["///", "//!", "//"],
    directive: none,
    bangIsDoc: true,
    form: "tree",
  },
  swift: {
    name: "swift",
    grammar: "@lumis-sh/wasm-swift/tree-sitter-swift.wasm",
    comments: ["comment", "multiline_comment"],
    prefixes: ["///", "//"],
    directive: bodyPrefix(["swiftlint:"]),
    form: "tree",
  },
  python: {
    name: "python",
    grammar: "tree-sitter-python/tree-sitter-python.wasm",
    comments: ["comment"],
    prefixes: ["#"],
    directive: hashDirective("noqa|type:|pragma|-\\*- coding|fmt:"),
    form: "tree",
  },
  shell: {
    name: "shell",
    grammar: "tree-sitter-bash/tree-sitter-bash.wasm",
    comments: ["comment"],
    prefixes: ["#"],
    directive: hashDirective("shellcheck"),
    form: "tree",
  },
  css: {
    name: "css",
    grammar: "tree-sitter-css/tree-sitter-css.wasm",
    comments: ["comment", "js_comment"],
    prefixes: ["//"],
    directive: bodyPrefix(["stylelint-disable", "prettier-ignore", "# sourceMappingURL"]),
    commentIsSpace: false,
    form: "tree",
  },
  sql: {
    name: "sql",
    prefixes: ["--"],
    directive: none,
    form: "sql",
  },
  ts: { name: "ts", form: "typescript" },
  js: { name: "js", form: "typescript" },
};

const extensions = {
  ".go": languages.go,
  ".rs": languages.rust,
  ".swift": languages.swift,
  ".py": languages.python,
  ".sh": languages.shell,
  ".zsh": languages.shell,
  ".bash": languages.shell,
  ".css": languages.css,
  ".sql": languages.sql,
  ".ts": languages.ts,
  ".tsx": languages.ts,
  ".mts": languages.ts,
  ".cts": languages.ts,
  ".js": languages.js,
  ".jsx": languages.js,
  ".mjs": languages.js,
  ".cjs": languages.js,
};

export const languageFor = (path) => extensions[extname(path).toLowerCase()];

export const scannable = (language) => Boolean(language?.prefixes);

let treeSitter;
const parsers = new Map();

export async function parseTree(language, text) {
  treeSitter ??= Parser.init();
  await treeSitter;
  let parser = parsers.get(language.name);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(await Language.load(require.resolve(language.grammar)));
    parsers.set(language.name, parser);
  }
  return parser.parse(text);
}

export function errorLine(tree) {
  if (!tree.rootNode.hasError) return 0;
  const cursor = tree.walk();
  try {
    for (;;) {
      if (cursor.nodeType === "ERROR" || cursor.nodeIsMissing) return cursor.startPosition.row + 1;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return 1;
      }
    }
  } finally {
    cursor.delete();
  }
}

let postgres;

function utf16Offsets(text) {
  const bytes = Buffer.byteLength(text);
  if (bytes === text.length) return (offset) => offset;
  const map = new Uint32Array(bytes + 1);
  let byte = 0;
  let index = 0;
  for (const char of text) {
    const width = Buffer.byteLength(char);
    map.fill(index, byte, byte + width);
    byte += width;
    index += char.length;
  }
  map[byte] = index;
  return (offset) => map[offset];
}

export async function scanSql(text) {
  postgres ??= loadModule();
  await postgres;
  const toIndex = utf16Offsets(text);
  return scanSync(text)
    .tokens.filter((token) => token.tokenName === "SQL_COMMENT" || token.tokenName === "C_COMMENT")
    .map((token) => ({ start: toIndex(token.start), end: toIndex(token.end) }));
}

export async function parseSql(text) {
  postgres ??= loadModule();
  await postgres;
  return parseSync(text);
}
