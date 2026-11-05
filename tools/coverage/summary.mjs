import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = 'usage: node tools/coverage/summary.mjs --input <folder> [--summary <file>] [--out <file>]';
const JS_FILES = ['coverage-final.json', 'coverage-summary.json'];
const METRICS = ['lines', 'statements', 'functions', 'branches'];
const ISTANBUL_MAPS = ['statementMap', 's', 'fnMap', 'f', 'branchMap', 'b'];
const KINDS = [['js', 'JS'], ['go', 'Go']];
const META_ONLY = 'covmeta without covcounters (the program did not exit normally, so it wrote no counters)';
const COUNTERS_ONLY = 'covcounters without covmeta';
const PERCENT_ENTRY = /(\S+)(?:\s+coverage: (?:([\d.]+)% of statements|\[no statements\]))?/g;
const PROFILE_BLOCK = /^(.+):(\d+)\.(\d+),(\d+)\.(\d+) (\d+) (\d+)$/;

class InputError extends Error {}

const toPosix = (path) => path.replaceAll('\\', '/');
const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const metric = ({ covered, total }) => ({ covered, total, pct: total === 0 ? null : Math.floor((100000 * covered) / total / 10) / 100 });

const countHits = (hits) => {
  let covered = 0;
  for (const hit of hits.values()) if (hit) covered += 1;
  return { covered, total: hits.size };
};

const readWorkspacePatterns = (file) => {
  if (!existsSync(file)) return [];
  const patterns = [];
  let inPackages = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^packages:\s*$/.test(line)) inPackages = true;
    else if (inPackages && line.trim() !== '' && !line.trim().startsWith('#')) {
      const item = /^\s+-\s+["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (!item) break;
      if (!item[1].startsWith('!')) patterns.push(item[1].split('/'));
    }
  }
  return patterns;
};

const repoRoot = toPosix(fileURLToPath(new URL('../..', import.meta.url))).replace(/\/+$/, '');
const workspacePatterns = readWorkspacePatterns(join(repoRoot, 'pnpm-workspace.yaml'));

const packageAt = (segments, start) => {
  let best = null;
  for (const pattern of workspacePatterns) {
    const fits = start + pattern.length < segments.length && pattern.every((part, i) => part === '*' || part === segments[start + i]);
    if (fits && (best === null || pattern.length > best.length)) best = pattern;
  }
  return best && segments.slice(start, start + best.length).join('/');
};

const areaOf = (file) => {
  const path = toPosix(file);
  if (path.startsWith(`${repoRoot}/`)) {
    const segments = path.slice(repoRoot.length + 1).split('/');
    return packageAt(segments, 0) ?? (segments.length > 1 ? segments[0] : '(root)');
  }
  const segments = path.split('/');
  for (let start = 0; start < segments.length; start += 1) {
    const area = packageAt(segments, start);
    if (area) return area;
  }
  return '(other)';
};

const readJson = (file) => {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new InputError(`cannot read ${file}: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InputError(`${file} is not valid JSON: ${error.message}`);
  }
};

const isPoint = (value) => isRecord(value) && typeof value.line === 'number' && typeof value.column === 'number';
const isSpan = (value) => isRecord(value) && isPoint(value.start) && isPoint(value.end);
const spanOf = (item) => (isSpan(item) ? item : isSpan(item?.loc) ? item.loc : null);
const spanKey = (span) => (isSpan(span) ? `${span.start.line}|${span.start.column}|${span.end.line}|${span.end.column}` : '?');

const nearestContainer = (item, map) => {
  const inner = spanOf(item);
  if (inner === null) return null;
  let found = null;
  let best = null;
  for (const [id, candidate] of Object.entries(map)) {
    const outer = spanOf(candidate);
    if (outer === null) continue;
    const distance = [
      inner.start.line - outer.start.line,
      inner.start.column - outer.start.column,
      outer.end.line - inner.end.line,
      outer.end.column - inner.end.column,
    ];
    if (distance[0] < 0 || distance[2] < 0 || (distance[0] === 0 && distance[1] < 0) || (distance[2] === 0 && distance[3] < 0)) continue;
    const closer = best === null
      || distance[0] < best[0] || (distance[0] === 0 && distance[1] < best[1])
      || distance[2] < best[2] || (distance[2] === 0 && distance[3] < best[3]);
    if (closer) {
      found = id;
      best = distance;
    }
  }
  return found;
};

const addHits = (a, b) => {
  if (Array.isArray(a) && Array.isArray(b)) return a.map((value, i) => (value || 0) + (b[i] || 0));
  if (typeof a === 'number' && typeof b === 'number') return a + b;
  return a;
};

const mergeHits = (leftHits, leftMap, rightHits, rightMap, keyOf) => {
  const byKey = (hits, map) => {
    const items = new Map();
    for (const [id, itemHits] of Object.entries(hits)) items.set(keyOf(map[id]), [itemHits, map[id]]);
    return items;
  };
  const withContainer = (item, itemHits, map, hits) => {
    const container = nearestContainer(item, map);
    return container === null ? itemHits : addHits(itemHits, hits[container]);
  };
  const rightItems = byKey(rightHits, rightMap);
  const merged = new Map();
  for (const [key, [itemHits, item]] of byKey(leftHits, leftMap)) {
    const match = rightItems.get(key);
    merged.set(key, [match === undefined ? withContainer(item, itemHits, rightMap, rightHits) : addHits(itemHits, match[0]), item]);
  }
  for (const [key, [itemHits, item]] of rightItems) {
    if (!merged.has(key)) merged.set(key, [withContainer(item, itemHits, leftMap, leftHits), item]);
  }
  const hits = {};
  const map = {};
  [...merged.values()].forEach(([itemHits, item], id) => {
    hits[id] = itemHits;
    map[id] = item;
  });
  return [hits, map];
};

const mergeCoverage = (existing, incoming) => {
  if (incoming.all === true) return existing;
  if (existing.all === true) return incoming;
  const [s, statementMap] = mergeHits(existing.s, existing.statementMap, incoming.s, incoming.statementMap, spanKey);
  const [f, fnMap] = mergeHits(existing.f, existing.fnMap, incoming.f, incoming.fnMap, (item) => spanKey(item?.loc));
  const [b, branchMap] = mergeHits(existing.b, existing.branchMap, incoming.b, incoming.branchMap, (item) => spanKey(item?.locations?.[0]));
  return { all: false, statementMap, s, fnMap, f, branchMap, b };
};

const countTruthy = (hits) => {
  let covered = 0;
  let total = 0;
  for (const value of Object.values(hits)) {
    total += 1;
    if (value) covered += 1;
  }
  return { covered, total };
};

const summarize = ({ statementMap, s, f, b }) => {
  const lines = new Map();
  for (const [id, count] of Object.entries(s)) {
    const line = statementMap[id]?.start?.line;
    if (line !== undefined) lines.set(line, lines.get(line) === true || Boolean(count));
  }
  const branches = { covered: 0, total: 0 };
  for (const hits of Object.values(b)) {
    branches.total += hits.length;
    for (const value of hits) if (value > 0) branches.covered += 1;
  }
  return { lines: countHits(lines), statements: countTruthy(s), functions: countTruthy(f), branches };
};

const readFinal = (file) => {
  const data = readJson(file);
  if (!isRecord(data)) throw new InputError(`${file} is not an Istanbul coverage map`);
  return Object.entries(data).map(([path, coverage]) => {
    if (!isRecord(coverage) || !ISTANBUL_MAPS.every((key) => isRecord(coverage[key])) || !Object.values(coverage.b).every(Array.isArray)) {
      throw new InputError(`${file}: ${path} is not Istanbul file coverage`);
    }
    return [path, { coverage }];
  });
};

const readSummary = (file) => {
  const data = readJson(file);
  if (!isRecord(data)) throw new InputError(`${file} is not an Istanbul coverage summary`);
  return Object.entries(data).filter(([path]) => path !== 'total').map(([path, summary]) => {
    if (!isRecord(summary) || !METRICS.every((name) => isRecord(summary[name]) && Number.isInteger(summary[name].covered) && Number.isInteger(summary[name].total))) {
      throw new InputError(`${file}: ${path} is not an Istanbul file summary`);
    }
    return [path, { counts: Object.fromEntries(METRICS.map((name) => [name, { covered: summary[name].covered, total: summary[name].total }])) }];
  });
};

const countsOf = (record) => record.counts ?? summarize(record.coverage);

const mergeRecords = (existing, incoming) => {
  if (existing.coverage && incoming.coverage) return { coverage: mergeCoverage(existing.coverage, incoming.coverage) };
  const left = countsOf(existing);
  const right = countsOf(incoming);
  return { counts: Object.fromEntries(METRICS.map((name) => [name, left[name].covered >= right[name].covered ? left[name] : right[name]])) };
};

const collectJs = (sources) => {
  const files = new Map();
  for (const source of sources) {
    const entries = source.file === 'coverage-final.json' ? readFinal(source.path) : readSummary(source.path);
    source.files = entries.length;
    for (const [path, record] of entries) files.set(path, files.has(path) ? mergeRecords(files.get(path), record) : record);
  }
  const areas = new Map();
  for (const [path, record] of files) {
    const area = areaOf(path);
    const entry = areas.get(area) ?? { files: 0, counts: Object.fromEntries(METRICS.map((name) => [name, { covered: 0, total: 0 }])) };
    areas.set(area, entry);
    entry.files += 1;
    const counts = countsOf(record);
    for (const name of METRICS) {
      entry.counts[name].covered += counts[name].covered;
      entry.counts[name].total += counts[name].total;
    }
  }
  return [...areas].map(([area, entry]) => ({
    kind: 'js',
    area,
    files: entry.files,
    ...Object.fromEntries(METRICS.map((name) => [name, metric(entry.counts[name])])),
  }));
};

const covdata = (args, dir, cwd) => {
  try {
    return execFileSync('go', ['tool', 'covdata', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (error.code === 'ENOENT') throw new InputError(`cannot read the Go coverage in ${dir}: the go command is not on PATH`);
    throw new InputError(`go tool covdata ${args[0]} failed for ${dir}: ${String(error.stderr ?? '').trim() || error.message}`);
  }
};

const parseProfile = (text, dir) => {
  const [header, ...rows] = text.split('\n').filter((line) => line !== '');
  if (header === undefined) return [];
  if (!header.startsWith('mode: ')) throw new InputError(`go tool covdata textfmt gave an unexpected first line for ${dir}: ${header}`);
  return rows.map((row) => {
    const match = PROFILE_BLOCK.exec(row);
    if (!match) throw new InputError(`go tool covdata textfmt gave an unexpected line for ${dir}: ${row}`);
    const [, file, startLine, startColumn, endLine, endColumn, statements, count] = match;
    return {
      key: `${file}:${startLine}.${startColumn},${endLine}.${endColumn}`,
      file,
      startLine: Number(startLine),
      endLine: Number(endLine),
      statements: Number(statements),
      hit: Number(count) > 0,
    };
  });
};

const readGoBlocks = (sources) => {
  const blocks = new Map();
  const readable = sources.filter((source) => source.skipped === null);
  if (readable.length === 0) return blocks;
  const scratch = mkdtempSync(join(tmpdir(), 'coverage-summary-'));
  try {
    readable.forEach((source, index) => {
      const percent = covdata(['percent', `-i=${source.path}`], source.dir, scratch);
      source.percent = Object.fromEntries([...percent.matchAll(PERCENT_ENTRY)].map(([, name, pct]) => [name, pct === undefined ? null : Number(pct)]));
      const profile = join(scratch, `${index}.txt`);
      covdata(['textfmt', `-i=${source.path}`, `-o=${profile}`], source.dir, scratch);
      for (const block of parseProfile(readFileSync(profile, 'utf8'), source.dir)) {
        const known = blocks.get(block.key);
        if (known === undefined) blocks.set(block.key, block);
        else if (known.statements !== block.statements) {
          throw new InputError(`the Go coverage in ${source.dir} does not match an earlier folder at ${block.key}`);
        } else known.hit ||= block.hit;
      }
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  return blocks;
};

const collectGo = (sources) => {
  const packages = new Map();
  for (const block of readGoBlocks(sources).values()) {
    if (block.statements === 0) continue;
    const name = posix.dirname(block.file);
    const entry = packages.get(name) ?? { files: new Set(), statements: { covered: 0, total: 0 }, lines: new Map() };
    packages.set(name, entry);
    entry.files.add(block.file);
    entry.statements.total += block.statements;
    if (block.hit) entry.statements.covered += block.statements;
    for (let line = block.startLine; line <= block.endLine; line += 1) {
      const key = `${block.file}:${line}`;
      entry.lines.set(key, entry.lines.get(key) === true || block.hit);
    }
  }
  return [...packages].map(([area, entry]) => ({
    kind: 'go',
    area,
    files: entry.files.size,
    lines: metric(countHits(entry.lines)),
    statements: metric(entry.statements),
    functions: null,
    branches: null,
  }));
};

const listDir = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((a, b) => byName(a.name, b.name));
  } catch (error) {
    throw new InputError(`cannot read ${dir}: ${error.message}`);
  }
};

const discover = (input) => {
  const js = [];
  const go = [];
  const visit = (dir) => {
    const entries = listDir(dir);
    const names = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
    const label = toPosix(relative(input, dir)) || '.';
    const jsFile = JS_FILES.find((name) => names.includes(name));
    if (jsFile) js.push({ dir: label, path: join(dir, jsFile), file: jsFile });
    const metaFiles = names.filter((name) => name.startsWith('covmeta.')).length;
    const counterFiles = names.filter((name) => name.startsWith('covcounters.')).length;
    if (metaFiles > 0 || counterFiles > 0) {
      go.push({ dir: label, path: dir, counterFiles, skipped: metaFiles === 0 ? COUNTERS_ONLY : counterFiles === 0 ? META_ONLY : null });
    }
    for (const entry of entries) if (entry.isDirectory()) visit(join(dir, entry.name));
  };
  visit(input);
  return { js, go };
};

const inputFolder = (input) => {
  let stats;
  try {
    stats = statSync(input, { throwIfNoEntry: false });
  } catch (error) {
    throw new InputError(`cannot read ${input}: ${error.message}`);
  }
  if (stats !== undefined && !stats.isDirectory()) throw new InputError(`--input ${input} is not a folder`);
  return stats !== undefined;
};

const totalOf = (rows) => {
  if (rows.length === 0) return null;
  const sum = (name) => {
    if (rows[0][name] === null) return null;
    const counts = { covered: 0, total: 0 };
    for (const row of rows) {
      counts.covered += row[name].covered;
      counts.total += row[name].total;
    }
    return metric(counts);
  };
  return { files: rows.reduce((files, row) => files + row.files, 0), ...Object.fromEntries(METRICS.map((name) => [name, sum(name)])) };
};

const buildReport = (input) => {
  const found = inputFolder(input);
  const { js, go } = found ? discover(resolve(input)) : { js: [], go: [] };
  const jsRows = collectJs(js).sort((a, b) => byName(a.area, b.area));
  const goRows = collectGo(go).sort((a, b) => byName(a.area, b.area));
  return {
    input,
    inputFound: found,
    sources: [
      ...js.map(({ dir, file, files }) => ({ kind: 'js', dir, file, files })),
      ...go.map(({ dir, counterFiles, skipped, percent: packages }) => ({ kind: 'go', dir, counterFiles, ...(skipped === null ? { percent: packages } : { skipped }) })),
    ],
    areas: [...jsRows, ...goRows],
    totals: { js: totalOf(jsRows), go: totalOf(goRows) },
  };
};

const cell = (value) => {
  if (value === null) return 'n/a';
  if (value.total === 0) return '0/0';
  return `${value.pct.toFixed(2)}% (${value.covered}/${value.total})`;
};

const tableRow = (cells) => `| ${cells.join(' | ')} |`;

const sourceLine = (source) => {
  if (source.kind === 'js') return `- \`${source.dir}\`: JS, ${source.file}, files: ${source.files}`;
  if (source.skipped) return `- \`${source.dir}\`: Go, skipped: ${source.skipped}`;
  const packages = Object.entries(source.percent).map(([name, pct]) => `${name} ${pct === null ? 'no statements' : `${pct.toFixed(1)}%`}`);
  return `- \`${source.dir}\`: Go, counter files: ${source.counterFiles}, go tool covdata percent: ${packages.join(', ') || 'no packages'}`;
};

const renderMarkdown = (report) => {
  const lines = ['## Coverage', '', tableRow(['Kind', 'Area', 'Lines', 'Statements', 'Functions', 'Branches']), tableRow(Array(6).fill('---'))];
  for (const [kind, label] of KINDS) {
    const rows = report.areas.filter((area) => area.kind === kind);
    if (rows.length === 0) lines.push(tableRow([label, 'no data', '', '', '', '']));
    else {
      for (const row of [...rows, { ...report.totals[kind], area: '**total**' }]) {
        lines.push(tableRow([label, row.area, ...METRICS.map((name) => cell(row[name]))]));
      }
    }
  }
  lines.push('');
  if (!report.inputFound) lines.push(`No folder at \`${report.input}\`.`);
  else if (report.sources.length === 0) lines.push(`No coverage files under \`${report.input}\`.`);
  else lines.push(`Sources under \`${report.input}\`:`, '', ...report.sources.map(sourceLine));
  lines.push('', 'Report only. No thresholds.', '');
  return lines.join('\n');
};

const writeOutput = (file, text, append) => {
  try {
    if (append) appendFileSync(file, text);
    else writeFileSync(file, text);
  } catch (error) {
    throw new InputError(`cannot write ${file}: ${error.message}`);
  }
};

const fail = (message) => {
  process.stderr.write(`coverage summary: ${message}\n`);
  return 2;
};

const main = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { input: { type: 'string' }, summary: { type: 'string' }, out: { type: 'string' } } }));
  } catch (error) {
    return fail(`${error.message}\n${USAGE}`);
  }
  if (!values.input) return fail(`--input is required\n${USAGE}`);
  try {
    const report = buildReport(values.input);
    const markdown = renderMarkdown(report);
    if (values.summary) writeOutput(values.summary, markdown, true);
    else process.stdout.write(markdown);
    if (values.out) writeOutput(values.out, `${JSON.stringify(report, null, 2)}\n`, false);
    return 0;
  } catch (error) {
    if (error instanceof InputError) return fail(error.message);
    throw error;
  }
};

process.exitCode = main(process.argv.slice(2));
