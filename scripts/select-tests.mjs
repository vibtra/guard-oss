import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';

const USAGE = `usage: node scripts/select-tests.mjs [--map <file>] (--changed <file> | --base <sha> --head <sha>) [--json] [--github]
       node scripts/select-tests.mjs [--map <file>] --check-map`;
const ROOT = path.resolve(import.meta.dirname, '..');

const globToRegExp = (glob) => {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*' && glob[index + 1] === '*') {
      const slash = glob[index + 2] === '/';
      source += slash ? '(?:.*/)?' : '.*';
      index += slash ? 2 : 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
};

export const loadMap = (file) => {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const compile = (globs) => globs.map((glob) => ({ glob, test: globToRegExp(glob) }));
  return {
    raw,
    global: compile(raw.global),
    lintOnly: compile(raw.lintOnly),
    areas: Object.entries(raw.areas).map(([name, globs]) => ({ name, globs: compile(globs) })),
    always: raw.always,
  };
};

const firstMatch = (globs, file) => globs.find(({ test }) => test.test(file))?.glob;

export const select = (map, changed) => {
  const reasons = [];
  const selected = new Map();
  let all = false;
  for (const file of changed) {
    const global = firstMatch(map.global, file);
    if (global) {
      all = true;
      reasons.push(`${file} is a global input (${global})`);
      continue;
    }
    const hits = map.areas.filter(({ globs }) => firstMatch(globs, file));
    for (const { name } of hits) {
      if (!selected.has(name)) selected.set(name, file);
    }
    if (hits.length > 0) continue;
    if (firstMatch(map.lintOnly, file)) continue;
    all = true;
    reasons.push(`${file} matches no area, so everything runs`);
  }
  const names = map.areas.map(({ name }) => name);
  const run = all ? names : names.filter((name) => selected.has(name));
  return {
    all,
    reasons,
    run,
    skip: names.filter((name) => !run.includes(name)),
    always: map.always,
    because: Object.fromEntries([...selected]),
    changed: changed.length,
  };
};

export const checkMap = (map, tracked) => {
  const problems = [];
  for (const { glob, test } of [...map.global, ...map.lintOnly, ...map.areas.flatMap(({ globs }) => globs)]) {
    if (!tracked.some((file) => test.test(file))) problems.push(`${glob} matches no tracked file`);
  }
  const covered = new Set([...map.areas.map(({ name }) => name), ...map.always]);
  const testDirs = new Set(tracked.filter((file) => /^tests\/integration\/[^/]+\//.test(file)).map((file) => file.split('/').slice(1, 3).join('/')));
  for (const dir of testDirs) {
    if (!covered.has(dir)) problems.push(`tests/${dir} has no area and is not in always`);
  }
  for (const entry of map.always) {
    if (!tracked.some((file) => file === `tests/${entry}` || file.startsWith(`tests/${entry}/`))) problems.push(`always entry ${entry} matches no tracked file`);
  }
  return problems;
};

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const main = () => {
  const args = process.argv.slice(2);
  const value = (flag) => {
    const index = args.indexOf(flag);
    return index === -1 ? undefined : args[index + 1];
  };
  const map = loadMap(path.resolve(ROOT, value('--map') ?? 'tests/selection-map.json'));
  if (args.includes('--check-map')) {
    const problems = checkMap(map, git('ls-files').split('\n').filter(Boolean));
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log('selection map: every glob matches a tracked file and every integration test folder is covered');
    return;
  }
  let changed;
  if (value('--changed')) changed = readFileSync(value('--changed'), 'utf8').split('\n').filter(Boolean);
  else if (value('--base') && value('--head')) changed = git('diff', '--no-renames', '--name-only', `${value('--base')}...${value('--head')}`).split('\n').filter(Boolean);
  else {
    console.error(USAGE);
    process.exit(2);
  }
  const result = select(map, changed);
  if (args.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(result.all ? 'everything runs' : `runs ${result.run.length} of ${result.run.length + result.skip.length} areas`);
    for (const reason of result.reasons.slice(0, 20)) console.log(`  ${reason}`);
    for (const [name, file] of Object.entries(result.because)) console.log(`  ${name}: ${file}`);
  }
  if (args.includes('--github') && process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      '### Test selection (shadow mode: everything still runs)',
      '',
      result.all ? `Would run everything: ${result.reasons[0]}` : `Would run ${result.run.length} areas and skip ${result.skip.length}.`,
      '',
      '| Area | Would run | Because of |',
      '| --- | --- | --- |',
      ...[...result.run, ...result.skip].map((name) => `| ${name} | ${result.run.includes(name) ? 'yes' : 'no'} | ${result.all ? 'everything runs' : (result.because[name] ?? '')} |`),
      '',
      `Always: ${result.always.join(', ')}`,
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  }
};

if (process.argv[1] && path.resolve(process.argv[1]) === import.meta.filename) main();
