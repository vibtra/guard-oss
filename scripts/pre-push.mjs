import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const LINTABLE = /\.(?:[cm]?[jt]sx?|json|md|css|html)$/;
const started = Date.now();

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const base = () => {
  for (const ref of ['@{upstream}', 'origin/main']) {
    try {
      return git('merge-base', 'HEAD', ref);
    } catch {}
  }
  return git('rev-list', '--max-parents=0', 'HEAD').split('\n')[0];
};

const run = (label, command, args) => {
  const begin = Date.now();
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  console.log(`pre-push: ${label} ${result.status === 0 ? 'passed' : 'failed'} in ${((Date.now() - begin) / 1000).toFixed(1)} s`);
  return result.status === 0;
};

const changed = git('diff', '--name-only', '--diff-filter=ACMR', base(), 'HEAD')
  .split('\n')
  .filter((file) => file !== '' && LINTABLE.test(file) && existsSync(path.join(root, file)));

const results = [run('personal paths', process.execPath, ['scripts/check-personal-paths.mjs'])];
if (changed.length > 0) results.push(run(`eslint on ${changed.length} changed file(s)`, path.join(root, 'tools/eslint/node_modules/.bin/eslint'), ['--no-warn-ignored', ...changed]));
results.push(run('typecheck (TypeScript 7)', process.execPath, ['scripts/typecheck.mjs']));

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (results.includes(false)) {
  console.error(`pre-push: failed after ${seconds} s. Fix the errors above, or push with --no-verify only if you mean CI to catch them.`);
  process.exit(1);
}
console.log(`pre-push: passed in ${seconds} s`);
