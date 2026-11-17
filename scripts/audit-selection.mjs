import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { loadMap } from './select-tests.mjs';

const USAGE = 'usage: node scripts/audit-selection.mjs --area <name> --opens <fatrace log> [--map <file>]';
const ROOT = path.resolve(import.meta.dirname, '..');

export const openedFiles = (log, root, tracked) => {
  const prefix = `${root}${path.sep}`;
  const files = new Set();
  for (const line of log.split('\n')) {
    const at = line.indexOf(` ${prefix}`);
    if (at === -1) continue;
    const relative = line.slice(at + 1 + prefix.length).trim().split(path.sep).join('/');
    if (tracked.has(relative)) files.add(relative);
  }
  return [...files].sort();
};

export const undeclared = (map, area, files) => {
  const entry = map.areas.find(({ name }) => name === area);
  if (!entry) throw new Error(`${area} is not an area in the selection map`);
  const declared = [...map.global, ...entry.globs];
  return files.filter((file) => !declared.some(({ test }) => test.test(file)));
};

const main = () => {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const area = value('--area');
  const opens = value('--opens');
  if (!area || !opens) {
    console.error(USAGE);
    process.exit(2);
  }
  const map = loadMap(path.resolve(ROOT, value('--map') ?? 'tests/selection-map.json'));
  const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean));
  const files = openedFiles(readFileSync(opens, 'utf8'), ROOT, tracked);
  const missing = undeclared(map, area, files);
  const summary = [
    `### Selection audit: ${area}`,
    '',
    `The tests opened ${files.length} tracked files. ${missing.length === 0 ? 'The map declares every one.' : `The map does not declare ${missing.length}:`}`,
    '',
    ...missing.map((file) => `- \`${file}\``),
  ].join('\n');
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
  if (files.length === 0) {
    console.error(`::error::fatrace recorded no tracked file for ${area}, so the audit proves nothing. Check that fatrace ran.`);
    process.exit(1);
  }
  if (missing.length > 0) {
    console.error(`::error::${area} reads ${missing.length} file(s) that tests/selection-map.json does not list for it. Add them to the area (or to global), or a change to them would skip these tests.`);
    process.exit(1);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();
