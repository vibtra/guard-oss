import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const [report, out = 'tests/test-durations.json'] = process.argv.slice(2);
if (!report) {
  console.error('usage: node scripts/test-durations.mjs <vitest json report> [out]');
  process.exit(2);
}
const { testResults } = JSON.parse(readFileSync(report, 'utf8'));
const root = path.resolve(path.dirname(out));
const durations = {};
for (const result of testResults) {
  const file = path.relative(root, result.name).split(path.sep).join('/');
  durations[file] = Math.max(1, Math.round(result.endTime - result.startTime));
}
const sorted = Object.fromEntries(Object.entries(durations).sort(([a], [b]) => (a < b ? -1 : 1)));
writeFileSync(out, `${JSON.stringify(sorted, null, 2)}\n`);
console.log(`${Object.keys(sorted).length} files written to ${out}`);
