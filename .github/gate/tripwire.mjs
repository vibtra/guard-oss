import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { filePath, parseDiff } from './lib/diff.mjs';
import { globToRegExp, loadPatterns, matcher } from './lib/patterns.mjs';

const USAGE = `usage: node .github/gate/tripwire.mjs --diff <file> [--gate-files <file>] [--test-files <file>] [--json]
       node .github/gate/tripwire.mjs --probes <dir> [--gate-files <file>] [--test-files <file>]`;

const sibling = (name) => fileURLToPath(new URL(name, import.meta.url));

const options = {
  diff: { type: 'string' },
  probes: { type: 'string' },
  'gate-files': { type: 'string', default: sibling('../gate-files.txt') },
  'test-files': { type: 'string', default: sibling('./test-files.txt') },
  json: { type: 'boolean', default: false },
};

const DATA_DIR = /(?:^|\/)(?:fixtures|testdata|__snapshots__)\//;
const DATA_ALWAYS = /^\.github\/gate\/(?:probes|classifier\/eval)\/|\.(?:diff|patch|snap|md|mdx)$/;
const CODE_EXT = /\.(?:[cm]?[jt]sx?|vue|svelte|go|py|swift|rs|sh|bash|zsh|rb|java|kt|kts|cs|c|cc|cpp|h|hpp|m|mm|php|pl|lua|ps1)$/;
const SPEC = /\.(?:test|spec)\.[^/]+$|_test\.(?:go|py)$|(?:^|\/)test_[^/]*\.py$|Tests?\.swift$/;
const RUNNABLE_SPEC = /\.(?:test|spec)\.[cm]?[jt]sx?$|_test\.go$|(?:_test|(?:^|\/)test_[^/]*)\.py$|Tests?\.swift$/;
const isData = (path) => (DATA_DIR.test(path) && !CODE_EXT.test(path)) || DATA_ALWAYS.test(path);
const specSuffix = (path) => {
  const hit = path.match(RUNNABLE_SPEC)?.[0];
  if (hit === undefined) return null;
  return hit.endsWith('.py') ? '.py' : hit.replace(/^\//, '');
};
const SKIPPED_DIR = {
  js: /^(?:\..*|testdata|node_modules|dist|cypress)$/,
  go: /^(?:[._].*|testdata|node_modules|vendor)$/,
  py: /^(?:\..*|testdata|node_modules|build|dist|venv)$/,
  swift: /^(?:\..*|testdata|node_modules)$/,
};
const VITEST_ROOTS = [
  ['tests/', ['integration/**/*.test.ts', 'e2e/**/*.test.ts']],
  ['apps/guard-console/', ['src/**/*.test.ts', 'src/**/*.test.tsx']],
  ['packages/ui/', ['test/**/*.test.ts', 'test/**/*.test.tsx']],
].map(([root, globs]) => ({ root, include: globs.map(globToRegExp) }));
const langOf = (path) => (path.endsWith('.go') ? 'go' : path.endsWith('.py') ? 'py' : path.endsWith('.swift') ? 'swift' : 'js');
const ESLINT_CONFIG = /(?:^|\/)(?:eslint\.config\.[cm]?[jt]s|\.eslintrc(?:\.\w+)?)$/;
const GOLANGCI_CONFIG = /(?:^|\/)\.golangci\.ya?ml$/;
const TSCONFIG = /(?:^|\/)tsconfig[\w.-]*\.json$/;

const KEY = /^\s*(?:-\s+)?["']?([\w$@./-]+)["']?\s*[:=](?!=)/;
const TABLE = /^\s*\[\[?\s*([\w.-]+)\s*\]\]?\s*$/;
const FLAG = /(?:^|\s)--?([A-Za-z][\w.-]*)/g;

const norm = (key) => key.toLowerCase().replace(/[^a-z0-9.]/g, '');
const keyOf = (text) => text.match(KEY)?.[1] ?? null;
const indentOf = (text) => text.match(/^\s*/)[0].length;
const trimmed = (text) => text.trim();

const SKIP = [
  /\.(?:only|skip|skipIf|runIf|todo|fixme)\s*[(`.]/,
  /^\s*(?:await\s+)?(?:xit|xdescribe|xtest|xcontext|fit|fdescribe|ftest)\s*\(/,
  /\b\w+\.Skip(?:Now|f)?\s*\(/,
  /\bXCTSkip(?:If|Unless)?\b/,
  /#\[ignore\b/,
  /@(?:pytest\.mark\.)?(?:skip|skipif|xfail)\b|\bunittest\.skip|\bpytest\.(?:skip|xfail)\s*\(/,
  /^\s*(?:-\s+)?["']?skip["']?\s*[:=]\s*(?!["']?(?:false|0)["']?\s*,?\s*$)\S/i,
  /(?:^|\s)--?skip(?:[=\s]|$)/,
  /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]/i,
  /\bSKIP_[A-Z0-9_]+["']?\s*[:=]\s*["']?(?:1|true|yes)\b/,
  /pass[W]ithNoTests/,
  /\b(?:it|test|describe|suite|bench|specify)(?:\.\w+)*\.(?:fails|failing|fail)\s*[(`.]/,
  /\b(?:it|test|describe|suite|bench|specify)(?:\.\w+)*\s*\(.*[{,]\s*(?:skip|todo|only|fails)\s*:\s*(?!false\b|0\b)[^\s,}]/,
];

const SUPPRESS = [
  /\b(?:eslint|stylelint|oxlint|tslint)[-:](?:disable|ignore)/,
  /\b(?:biome|deno-lint)-ignore\b/,
  /@ts-(?:ignore|expect-error|nocheck)\b/,
  /\/\/\s*nolint\b/,
  /#\s*noqa\b/i,
  /#\s*type:\s*ignore\b/,
  /\b(?:pylint|pyright|mypy|rubocop|swiftlint|shellcheck)\s*:?\s*(?:disable|ignore)\b/i,
  /#!?\[allow\(/,
  /\b(?:c8|v8|istanbul)\s+ignore\b/,
  /\bprettier[-]ignore\b/,
  /#\s*nosec\b/,
];

const ESLINT_OFF = /^\s*["']?[@\w/.-]+["']?\s*:\s*(?:["'](?:off|warn)["']|[01]\b|\[\s*(?:["'](?:off|warn)["']|[01]\b))/;
const TS_LOOSE = /["']?(?:strict\w*|noImplicit\w*|noUnused\w*|noUnchecked\w*|noFallthrough\w*|exactOptional\w*|noPropertyAccessFromIndexSignature|useUnknownInCatchVariables|alwaysStrict)["']?\s*:\s*false\b/;

const IGNORE_KEY = /ignore|exclu|allowlist|skipdirs|skipfiles|stopword/;
const NOT_IGNORE_KEY = /builtdependencies|scripts$|deprecations?$|case$|whitespace$|engines$/;
const EMPTY_VALUE = /[:=]\s*(?:\[\s*\]|\{\s*\}|""|''|["']?(?:false|no|none|null|0)["']?)\s*,?\s*$/i;
const IGNORE_FLAG = /^(?:(?:test|coverage|watch)?path)?(?:ignore|exclude)(?:s|d|patterns?|paths?|dirs?|files?|rules?|from)?$|^skip(?:dirs|files)$/;
const isIgnoreKey = (key) => IGNORE_KEY.test(norm(key)) && !NOT_IGNORE_KEY.test(norm(key));

const NUM = String.raw`(\d[\d_]*(?:\.\d+)?(?:\s*\*\s*\d[\d_]*(?:\.\d+)?)*)\s*(ms|s|m|h|%)?`;
const SETTINGS = [
  [new RegExp(String.raw`["']?([A-Za-z_$][\w$.-]*)["']?\s*[:=]\s*["']?${NUM}(?![\w.])`, 'g'), null],
  [new RegExp(String.raw`(?:^|\s)--?([A-Za-z][\w.-]*)\s+["']?${NUM}(?![\w.])`, 'g'), null],
  [new RegExp(String.raw`\b(setTimeout|timeout|setDefaultTimeout|retries|retry)\s*\(\s*${NUM}(?![\w.])`, 'g'), null],
  [new RegExp(String.raw`^\s*\}\s*,\s*${NUM}\s*\)`, 'g'), 'timeout'],
];
const UNIT = { ms: 1, s: 1000, m: 60000, h: 3600000 };
const LOWER_EASES = /^(?:lines|branches|functions|statements|perfile)$|coverage|failunder|minimum|^min(?:coverage|score|percent)/;
const RAISE_EASES = /timeout|retr(?:y|ies)|attempts|^max|limit|tolerance|threshold|warnings|complexity|^min|length|budget|slow/;

const ASSERT = /\bexpect(?:TypeOf)?\s*\(|\b(?:expect|assert)[A-Z]\w*\s*\(|(?:^|[^\w.$])assert(?:\.\w+)?\s*\(|^\s*assert\s|\b(?:require|assert)\.[A-Z]\w*\s*\(|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(|\bXCT(?:Assert\w*|Fail)\s*\(|\bassert(?:_eq|_ne)?!\s*\(|\bself\.assert\w*\s*\(|#(?:expect|require)\s*\(|\.should\b/;
const RANK = {
  toStrictEqual: 3, deepStrictEqual: 3,
  toBe: 2, toEqual: 2, toBeNull: 2, toBeUndefined: 2, toBeNaN: 2, toHaveBeenCalledWith: 2, toHaveBeenLastCalledWith: 2,
  toHaveBeenNthCalledWith: 2, toHaveBeenCalledTimes: 2, toHaveReturnedWith: 2, toHaveLength: 2, toMatch: 2,
  toMatchInlineSnapshot: 2, toMatchSnapshot: 2, toBeCloseTo: 2, toContainEqual: 2, toThrow: 2, toThrowError: 2,
  strictEqual: 2, notStrictEqual: 2, notDeepStrictEqual: 2, throws: 2, rejects: 2, match: 2,
  toMatchObject: 1, toContain: 1, toHaveProperty: 1, toBeInstanceOf: 1, toBeTypeOf: 1, toHaveBeenCalled: 1,
  toBeGreaterThan: 1, toBeGreaterThanOrEqual: 1, toBeLessThan: 1, toBeLessThanOrEqual: 1, deepEqual: 1, equal: 1, notEqual: 1,
  toBeDefined: 0, toBeTruthy: 0, toBeFalsy: 0, ok: 0,
};

const LITERAL = String.raw`(?:true|false|null|undefined|-?\d[\d_.]*|'[^']*'|"[^"]*")`;
const TAUTOLOGY = [
  new RegExp(String.raw`\bexpect\s*\(\s*${LITERAL}\s*\)`),
  /(?:^|[^\w.$])assert(?:\.ok|\.equal|\.strictEqual|\.True)?\s*\(\s*true\s*[,)]/,
  /^\s*assert\s+(?:True|1)\s*$/,
  /\bXCTAssert(?:True)?\s*\(\s*true\s*[,)]/,
  /\bassert!\s*\(\s*true\s*[,)]/,
  /#expect\s*\(\s*true\s*\)/,
];
const EMPTY_TEST = [
  /\b(?:it|test|specify)(?:\.\w+)*\s*\(\s*(['"`]).*?\1\s*,\s*(?:async\s+)?(?:\([^)]*\)|\w+)\s*=>\s*\{\s*\}\s*\)/,
  /\b(?:it|test|specify)(?:\.\w+)*\s*\(\s*(['"`]).*?\1\s*,\s*(?:async\s+)?function\s*\w*\s*\([^)]*\)\s*\{\s*\}\s*\)/,
  /^\s*func\s+Test\w*\s*\([^)]*\)\s*\{\s*\}/,
  /^\s*(?:async\s+)?def\s+test\w*\s*\([^)]*\)\s*(?:->[^:]*)?:\s*(?:pass|\.\.\.)\s*$/,
  /^\s*func\s+test\w*\s*\(\s*\)\s*(?:async\s+)?(?:throws\s+)?\{\s*\}/,
];
const TEST_OPENER = [
  /\b[xf]?(?:it|test|specify)(?:\.\w+)*\s*\(\s*(['"`]).*?\1\s*,.*\{\s*$/,
  /^\s*func\s+(?:Test|Benchmark|Fuzz)\w*\s*\(.*\)\s*\{\s*$/,
  /^\s*(?:async\s+)?def\s+test\w*\s*\(.*\)\s*(?:->[^:]*)?:\s*$/,
  /^\s*func\s+test\w*\s*\(\s*\)\s*(?:async\s+)?(?:throws\s+)?\{\s*$/,
];
const EARLY_EXIT = /^\s*(?:return\s*;?|pass|if\s*\(?\s*true\s*\)?\s*\{?\s*return\b.*)\s*$/;
const BARE_RETURN = /^\s*return(?:\s+(?:undefined|null|void 0|true|false|None|True|False))?\s*;?\s*(?:(?:\/\/|#).*)?$/;
const BARE_EXPECT = /^\s*(?:await\s+)?expect(?:\.soft)?\s*\((?!.*\)\s*\.\s*(?:not|resolves|rejects|to\w*)\b).*\)\s*;\s*$/;
const COMMENTED = /^\s*(?:\/\/|\/\*|\*|#(?!(?:expect|require)\s*\())/;
const OPENS_BLOCK_COMMENT = /^\s*\/\*(?!.*\*\/)/;
const isAssert = (text) => !COMMENTED.test(text) && ASSERT.test(text);
const isOpener = (text) => !COMMENTED.test(text) && TEST_OPENER.some((re) => re.test(text));
const unreachable = (line) => BARE_RETURN.test(line.text) && line.next !== null && !/^\s*[})]/.test(line.next) && indentOf(line.next) >= indentOf(line.text);

const ifFalse = (text) => {
  const value = text.match(/^\s*(?:-\s+)?if\s*:\s*(.+?)\s*$/)?.[1];
  if (value === undefined) return false;
  const bare = value.replace(/^(["'])(.*)\1$/, '$2').replace(/^\$\{\{\s*(.*?)\s*\}\}$/, '$1').replace(/^(["'])(.*)\1$/, '$2').trim();
  return bare === '0' || /(?:^|&&)\s*false\s*(?:&&|$)/.test(bare);
};

const strength = (text) => {
  const matcherCall = text.match(/\.(not\.)?(to\w+)\s*\(\s*(\))?/);
  if (matcherCall) {
    const rank = RANK[matcherCall[2]];
    if (rank === undefined) return null;
    if (matcherCall[1]) return 0;
    return matcherCall[2].startsWith('toThrow') && matcherCall[3] ? 1 : rank;
  }
  const nodeCall = text.match(/(?:^|[^\w.$])assert(?:\.(\w+))?\s*\(/);
  if (nodeCall) return RANK[nodeCall[1] ?? 'ok'] ?? null;
  return null;
};

const settingsOf = (text) =>
  SETTINGS.flatMap(([re, fixed]) =>
    [...text.matchAll(re)].map((m) => {
      const [key, raw, unit] = fixed === null ? [m[1], m[2], m[3]] : [fixed, m[1], m[2]];
      const value = raw.split('*').reduce((acc, part) => acc * Number(part.replace(/_/g, '')), 1) * (UNIT[unit] ?? 1);
      return { key: norm(key).split('.').at(-1), value };
    }),
  );

const dirOf = (path) => path.slice(0, path.lastIndexOf('/') + 1);
const within = (dir, base) => (base === '' ? dir === '' : dir.startsWith(base));

const runnable = (path) => {
  if (!RUNNABLE_SPEC.test(path)) return false;
  const lang = langOf(path);
  if (dirOf(path).split('/').some((segment) => SKIPPED_DIR[lang].test(segment))) return false;
  const runner = lang === 'js' ? VITEST_ROOTS.find(({ root }) => path.startsWith(root)) : undefined;
  return runner === undefined || runner.include.some((re) => re.test(path.slice(runner.root.length)));
};

const easing = (key) => (LOWER_EASES.test(key) ? 'lower' : RAISE_EASES.test(key) ? 'raise' : null);

const pool = (lines) => {
  const counts = new Map();
  for (const line of lines) counts.set(trimmed(line.text), (counts.get(trimmed(line.text)) ?? 0) + 1);
  return counts;
};

const take = (counts, text) => {
  const n = counts.get(trimmed(text)) ?? 0;
  if (n === 0) return false;
  counts.set(trimmed(text), n - 1);
  return true;
};

const landings = (files) => {
  const spots = new Map();
  for (const file of files) {
    for (const line of file.hunks.flatMap((h) => h.lines)) {
      if (line.type === 'add') spots.set(trimmed(line.text), [...(spots.get(trimmed(line.text)) ?? []), file]);
    }
  }
  return spots;
};

const landed = (spots, text, source) => {
  const list = spots.get(trimmed(text)) ?? [];
  const fits = (file) => runnable(file.newPath) && (file.oldPath !== null || within(dirOf(file.newPath), dirOf(source.oldPath)));
  const index = list.includes(source) ? list.indexOf(source) : list.findIndex(fits);
  if (index === -1) return false;
  list.splice(index, 1);
  return true;
};

const annotate = (hunk) => {
  const seed = hunk.context.match(TABLE)?.[1] ?? keyOf(hunk.context);
  let stack = seed ? [{ indent: 0, key: seed, table: TABLE.test(hunk.context) }] : [];
  let previous = null;
  const entries = hunk.lines.map((line) => {
    const entry = { ...line, keys: stack.map((s) => s.key), previous };
    if (line.type === 'del' || trimmed(line.text) === '') return entry;
    previous = line.text;
    const table = line.text.match(TABLE);
    if (table) {
      stack = [{ indent: -1, key: table[1], table: true }];
      entry.keys = [];
      return entry;
    }
    const indent = indentOf(line.text);
    const item = /^\s*-(?:\s|$)/.test(line.text);
    while (stack.length > 0 && !stack.at(-1).table && (item ? stack.at(-1).indent > indent : stack.at(-1).indent >= indent)) stack.pop();
    entry.keys = stack.map((s) => s.key);
    const key = keyOf(line.text);
    if (key !== null) stack.push({ indent: item ? line.text.match(/^\s*-\s*/)[0].length : indent, key, table: false });
    return entry;
  });
  let next = null;
  for (let i = entries.length - 1; i >= 0; i--) {
    entries[i].next = next;
    if (entries[i].type !== 'del' && trimmed(entries[i].text) !== '') next = entries[i].text;
  }
  return entries;
};

const groups = (lines) => {
  const out = [];
  let current = null;
  for (const line of lines) {
    if (line.type === 'ctx') current = null;
    else {
      if (current === null) out.push((current = { del: [], add: [] }));
      current[line.type].push(line);
    }
  }
  return out;
};

const widened = (line, path) => {
  const t = trimmed(line.text);
  if (t === '' || t.startsWith('#') || /^[\]})]+[,;]?$/.test(t) || /^[-\s'"`]*!/.test(t)) return false;
  if (/^\.(?!git|docker|npm)\w*ignore$/.test(basename(path))) return true;
  const own = keyOf(line.text);
  if (own !== null && isIgnoreKey(own)) return !EMPTY_VALUE.test(line.text);
  if ([...line.text.matchAll(FLAG)].some((m) => IGNORE_FLAG.test(norm(m[1])))) return true;
  if (line.keys.some(isIgnoreKey)) return true;
  return path.startsWith('.github/workflows/') && own !== null && norm(own) === 'paths';
};

const inString = (text, index) => {
  for (let i = 0; i < index; i++) {
    if (text.startsWith('//', i) || text.startsWith('/*', i) || text[i] === '#') return false;
    const quote = text[i];
    if (quote !== '"' && quote !== "'" && quote !== '`') continue;
    let end = i + 1;
    while (end < text.length && text[end] !== quote) end += text[end] === '\\' ? 2 : 1;
    if (end >= text.length) continue;
    if (end > index) return true;
    i = end;
  }
  return false;
};

const suppressed = (line, path) =>
  SUPPRESS.some((re) => {
    const hit = line.text.match(re);
    return hit !== null && !inString(line.text, hit.index);
  }) ||
  (ESLINT_CONFIG.test(path) && ESLINT_OFF.test(line.text)) ||
  (TSCONFIG.test(path) && TS_LOOSE.test(line.text)) ||
  (GOLANGCI_CONFIG.test(path) && /^\s*-\s*\S/.test(line.text) && norm(line.keys.at(-1) ?? '') === 'disable');

const MARKERS = [
  ['or-true', (line) => /\|\|\s*(?:true|:|exit\s+0)(?![\w-])/.test(line.text)],
  ['continue-on-error', (line) => /^\s*(?:-\s+)?continue-on-error\s*:\s*(?!["']?false["']?\s*$)\S/.test(line.text)],
  ['if-false', (line) => ifFalse(line.text)],
  ['skip-marker', (line) => SKIP.some((re) => re.test(line.text))],
  ['widened-pattern', widened],
];

const scan = (diffText, { isGate, isTest }) => {
  const files = parseDiff(diffText);
  if (files.length === 0 && diffText.trim() !== '') throw new Error('the diff has no "diff --git" header');
  const findings = [];
  const flag = (rule, file, line, text) => findings.push({ rule, file, line, text: trimmed(text).slice(0, 300) });
  const scoped = files.map((file) => {
    const paths = [file.oldPath, file.newPath].filter((p) => p !== null);
    const gate = paths.some(isGate);
    const test = paths.some(isTest);
    const code = paths.some((p) => !isData(p) || SPEC.test(p));
    return { file, gate, code, gated: (gate || test) && code, testCode: test && code };
  });
  const linesOf = (keep, type) => scoped.filter(keep).flatMap(({ file }) => file.hunks.flatMap((h) => h.lines.filter((l) => l.type === type)));
  const movedIn = pool(linesOf((s) => s.gated, 'del'));
  const assertMovedOut = landings(files);
  const assertMovedIn = pool(linesOf((s) => s.testCode, 'del'));
  const openerMovedOut = landings(files);
  const openerMovedIn = new Map(assertMovedIn);

  for (const { file, gate, code, gated, testCode } of scoped) {
    const path = filePath(file);

    if (file.oldPath !== null && isGate(file.oldPath) && (file.newPath === null || !isGate(file.newPath))) {
      flag('gate-line-removed', path, 0, file.newPath === null ? `deleted ${file.oldPath}` : `renamed ${file.oldPath} to ${file.newPath}`);
    }
    if (file.oldPath !== null && file.newPath !== null && SPEC.test(file.oldPath) && isTest(file.oldPath) && !isTest(file.newPath)) {
      flag('test-noop', path, 0, `renamed ${file.oldPath} to ${file.newPath}, which is not a test path`);
    }
    if (file.newPath === null && SPEC.test(file.oldPath) && isTest(file.oldPath)) {
      flag('test-noop', path, 0, `deleted ${file.oldPath}`);
    }
    if (file.oldPath !== null && file.newPath !== null && SPEC.test(file.oldPath) && !within(dirOf(file.newPath), dirOf(file.oldPath))) {
      flag('test-noop', path, 0, `moved ${file.oldPath} to ${file.newPath}, outside its folder, where a test runner may not pick it up`);
    }
    if (file.oldPath !== null && file.newPath !== null && file.oldPath !== file.newPath && specSuffix(file.oldPath) !== null && !runnable(file.newPath)) {
      flag('test-noop', path, 0, `moved ${file.oldPath} to ${file.newPath}, where its test runner does not pick it up`);
    }
    const oldSuffix = file.oldPath === null || file.newPath === null ? null : specSuffix(file.oldPath);
    if (oldSuffix !== null && specSuffix(file.newPath) !== oldSuffix) {
      flag('test-noop', path, 0, `renamed ${file.oldPath} to ${file.newPath}, which a test runner no longer picks up as ${oldSuffix}`);
    }

    const removedAsserts = [];
    const addedAsserts = [];
    const removedOpeners = [];
    let addedOpeners = 0;
    for (const hunk of file.hunks) {
      const lines = annotate(hunk);
      for (const line of lines) {
        if (line.type === 'del') {
          if (gate && trimmed(line.text) !== '') flag('gate-line-removed', path, line.oldLine, line.text);
          if (testCode && isAssert(line.text) && !landed(assertMovedOut, line.text, file)) removedAsserts.push(line);
          if (testCode && file.newPath !== null && isOpener(line.text) && !landed(openerMovedOut, line.text, file)) removedOpeners.push(line);
          continue;
        }
        if (line.type !== 'add') continue;
        if (testCode && isAssert(line.text) && !take(assertMovedIn, line.text)) addedAsserts.push(line);
        if (testCode && isOpener(line.text) && !take(openerMovedIn, line.text)) addedOpeners += 1;
        const fresh = !take(movedIn, line.text);
        if (!code) continue;
        if (suppressed(line, path)) flag('lint-suppression', path, line.newLine, line.text);
        if (!fresh) continue;
        if (gated) for (const [rule, hit] of MARKERS) if (hit(line, path)) flag(rule, path, line.newLine, line.text);
        if (testCode) {
          const t = line.text;
          const noop =
            TAUTOLOGY.some((re) => re.test(t)) ||
            EMPTY_TEST.some((re) => re.test(t)) ||
            (EARLY_EXIT.test(t) && line.previous !== null && TEST_OPENER.some((re) => re.test(line.previous))) ||
            unreachable(line) ||
            BARE_EXPECT.test(t) ||
            (OPENS_BLOCK_COMMENT.test(t) && line.newLine !== 1) ||
            /\bexpect\s*\(\s*([\w.$]+)\s*\)\.(?:not\.)?to(?:Be|Equal|StrictEqual)\s*\(\s*\1\s*\)/.test(t);
          if (noop) flag('test-noop', path, line.newLine, t);
        }
      }
      if (!gated) continue;
      for (const group of groups(lines)) {
        const before = group.del.flatMap((l) => settingsOf(l.text));
        for (const added of group.add) {
          for (const { key, value } of settingsOf(added.text)) {
            const direction = easing(key);
            if (direction === null) continue;
            const index = before.findIndex((s) => s.key === key);
            if (index === -1) {
              if (/^retr(?:y|ies)$/.test(key) && value > 0) flag('raised-threshold', path, added.newLine, added.text);
              continue;
            }
            const [old] = before.splice(index, 1);
            if (direction === 'raise' ? value > old.value : value < old.value) flag('raised-threshold', path, added.newLine, added.text);
          }
        }
        if (!testCode) continue;
        const was = group.del.map((l) => strength(l.text)).filter((s) => s !== null);
        const now = group.add.map((l) => ({ line: l, rank: strength(l.text) })).filter((s) => s.rank !== null);
        now.forEach(({ line, rank }, i) => {
          if (i < was.length && rank < was[i]) flag('assertion-removed', path, line.newLine, line.text);
        });
      }
    }
    if (removedAsserts.length > addedAsserts.length) {
      for (const line of removedAsserts) flag('assertion-removed', path, line.oldLine, line.text);
    }
    if (removedOpeners.length > addedOpeners) {
      for (const line of removedOpeners) flag('test-noop', path, line.oldLine, line.text);
    }
  }
  const seen = new Set();
  const unique = findings.filter((f) => {
    const key = `${f.rule}\n${f.file}\n${f.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { flagged: unique.length > 0, findings: unique };
};

const loadLists = (values) => {
  const lists = {};
  for (const [name, option] of [['isGate', 'gate-files'], ['isTest', 'test-files']]) {
    const patterns = loadPatterns(values[option]);
    if (patterns.length === 0) throw new Error(`${values[option]}: no pattern`);
    const match = matcher(patterns);
    lists[name] = (path) => match(path) !== null;
  }
  return lists;
};

const runDiff = (values) => {
  const result = scan(readFileSync(values.diff, 'utf8'), loadLists(values));
  if (values.json) console.log(JSON.stringify(result));
  else if (!result.flagged) console.log('clean: no tripwire finding');
  else for (const f of result.findings) console.log(`flag ${f.rule} ${f.file}:${f.line} ${JSON.stringify(f.text)}`);
  return result.flagged ? 1 : 0;
};

const findProbes = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const here = entries.some((e) => e.isFile() && e.name === 'pr.diff') ? [dir] : [];
  return [...here, ...entries.filter((e) => e.isDirectory()).flatMap((e) => findProbes(join(dir, e.name)))];
};

const runProbe = (dir, lists) => {
  const expect = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8'));
  if (expect?.tripwire !== 'flag' && expect?.tripwire !== 'clean') throw new Error('expect.json needs "tripwire": "flag" or "clean"');
  const result = scan(readFileSync(join(dir, 'pr.diff'), 'utf8'), lists);
  const actual = result.flagged ? 'flag' : 'clean';
  const rules = [...new Set(result.findings.map((f) => f.rule))].sort();
  const want = Array.isArray(expect.rules) ? [...new Set(expect.rules)].sort() : null;
  const ok = actual === expect.tripwire && (want === null || want.join() === rules.join());
  const got = `${actual}${rules.length > 0 ? ` (${rules.join(', ')})` : ''}`;
  return { ok, got, want: `${expect.tripwire}${want?.length ? ` (${want.join(', ')})` : ''}` };
};

const runProbes = (values) => {
  const lists = loadLists(values);
  const dirs = findProbes(values.probes);
  if (dirs.length === 0) throw new Error(`${values.probes}: no probe`);
  const codes = dirs.map((dir) => {
    const name = relative(values.probes, dir).split(sep).join('/') || '.';
    try {
      const { ok, got, want } = runProbe(dir, lists);
      console.log(ok ? `pass ${name}: ${got}` : `FAIL ${name}: expected ${want}, got ${got}`);
      return ok ? 0 : 1;
    } catch (error) {
      console.log(`error ${name}: ${error.message}`);
      return 2;
    }
  });
  return Math.max(...codes);
};

const run = (values) => {
  if ((values.diff === undefined) === (values.probes === undefined)) throw new Error(USAGE);
  return values.diff !== undefined ? runDiff(values) : runProbes(values);
};

try {
  process.exitCode = run(parseArgs({ options }).values);
} catch (error) {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? `${error.message}\n${USAGE}` : error.message);
  process.exitCode = 2;
}
