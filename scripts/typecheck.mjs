import { spawn } from 'node:child_process';
import path from 'node:path';

const PROJECTS = ['apps/guard-console', 'apps/registry', 'packages/ui', 'packages/guard-contract', 'packages/console-api', 'infra', 'tests'];
const root = path.resolve(import.meta.dirname, '..');
const tsc = path.join(root, 'node_modules', '.bin', process.argv.includes('--tsrs') ? 'tsrs' : 'tsc');

const check = (project) =>
  new Promise((resolve) => {
    const child = spawn(tsc, ['--noEmit', '-p', path.join(root, project, 'tsconfig.json')], { cwd: root });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ project, code, output }));
  });

const results = await Promise.all(PROJECTS.map(check));
for (const { project, code, output } of results) {
  if (code !== 0) process.stdout.write(`${project}\n${output}\n`);
}
const failed = results.filter(({ code }) => code !== 0).map(({ project }) => project);
if (failed.length > 0) {
  console.error(`typecheck failed in ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`typecheck passed in ${PROJECTS.length} projects`);
