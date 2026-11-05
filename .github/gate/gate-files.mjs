import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadApprovers } from './lib/approvers.mjs';
import { parseDiff, touchedPaths } from './lib/diff.mjs';
import { loadPatterns, matcher } from './lib/patterns.mjs';

const USAGE = `usage: node .github/gate/gate-files.mjs --diff <file> [--list <file>] [--json]
       node .github/gate/gate-files.mjs --probes <dir> [--list <file>]
       node .github/gate/gate-files.mjs --codeowners [--list <file>] [--approvers <file>]
       node .github/gate/gate-files.mjs --check-codeowners <file> [--list <file>] [--approvers <file>]`;

const MODES = ['diff', 'probes', 'codeowners', 'check-codeowners'];
const SEGMENT = /^[\w.*?@+-]+$/;

const sibling = (name) => fileURLToPath(new URL(`../${name}`, import.meta.url));

const options = {
  diff: { type: 'string' },
  probes: { type: 'string' },
  codeowners: { type: 'boolean' },
  'check-codeowners': { type: 'string' },
  list: { type: 'string', default: sibling('gate-files.txt') },
  approvers: { type: 'string', default: sibling('gate-approvers.txt') },
  json: { type: 'boolean', default: false },
};

const loadList = (file) => {
  const patterns = loadPatterns(file);
  if (patterns.length === 0) throw new Error(`${file}: no pattern`);
  const bad = patterns.find((p) => p.split('/').some((s) => !SEGMENT.test(s) || (s.includes('**') && s !== '**')));
  if (bad !== undefined) throw new Error(`${file}: unsupported pattern: ${bad}`);
  return patterns;
};

const evaluate = (diffText, match) => {
  const files = parseDiff(diffText);
  if (files.length === 0 && diffText.trim() !== '') throw new Error('the diff has no "diff --git" header');
  const hits = new Map();
  for (const path of files.flatMap((file) => touchedPaths(file))) {
    const pattern = match(path);
    if (pattern !== null) hits.set(path, pattern);
  }
  const gated = [...hits].map(([path, pattern]) => ({ path, pattern }));
  return { gated: gated.length > 0, files: gated };
};

const runDiff = ({ diff, list, json }) => {
  const result = evaluate(readFileSync(diff, 'utf8'), matcher(loadList(list)));
  if (json) console.log(JSON.stringify(result));
  else if (!result.gated) console.log('clear: no gate file touched');
  else for (const { path, pattern } of result.files) console.log(`gated: ${path} (${pattern})`);
  return result.gated ? 1 : 0;
};

const runProbe = (dir, match) => {
  const expected = JSON.parse(readFileSync(join(dir, 'expect.json'), 'utf8'))?.gateFiles;
  if (expected !== 'gated' && expected !== 'clear') throw new Error('expect.json needs "gateFiles": "gated" or "clear"');
  const actual = evaluate(readFileSync(join(dir, 'pr.diff'), 'utf8'), match).gated ? 'gated' : 'clear';
  return { expected, actual };
};

const runProbes = ({ probes, list }) => {
  const match = matcher(loadList(list));
  const names = readdirSync(probes, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  if (names.length === 0) throw new Error(`${probes}: no probe`);
  const codes = names.map((name) => {
    try {
      const { expected, actual } = runProbe(join(probes, name), match);
      if (actual === expected) {
        console.log(`pass ${name}: ${actual}`);
        return 0;
      }
      console.log(`FAIL ${name}: expected ${expected}, got ${actual}`);
      return 1;
    } catch (error) {
      console.log(`error ${name}: ${error.message}`);
      return 2;
    }
  });
  return Math.max(...codes);
};

const codeowners = ({ list, approvers }) => {
  const owners = loadApprovers(approvers).map((login) => `@${login}`).join(' ');
  return loadList(list).map((p) => `${p.startsWith('**/') ? p : `/${p}`} ${owners}\n`).join('');
};

const runCheckCodeowners = (values) => {
  const file = values['check-codeowners'];
  if (readFileSync(file, 'utf8') === codeowners(values)) {
    console.log(`${file} matches the gate-file list`);
    return 0;
  }
  console.log(`${file} does not match the gate-file list. Regenerate it: node .github/gate/gate-files.mjs --codeowners > .github/CODEOWNERS`);
  return 1;
};

const run = (values) => {
  if (MODES.filter((mode) => values[mode] !== undefined).length !== 1) throw new Error(USAGE);
  if (values.diff !== undefined) return runDiff(values);
  if (values.probes !== undefined) return runProbes(values);
  if (values.codeowners) {
    process.stdout.write(codeowners(values));
    return 0;
  }
  return runCheckCodeowners(values);
};

try {
  process.exitCode = run(parseArgs({ options }).values);
} catch (error) {
  console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? `${error.message}\n${USAGE}` : error.message);
  process.exitCode = 2;
}
