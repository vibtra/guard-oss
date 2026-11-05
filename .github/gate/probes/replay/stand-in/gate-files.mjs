import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDiff, touchedPaths } from './lib/diff.mjs';
import { loadPatterns, matcher } from './lib/patterns.mjs';

const { values } = parseArgs({
  options: {
    diff: { type: 'string' },
    list: { type: 'string', default: fileURLToPath(new URL('../gate-files.txt', import.meta.url)) },
    json: { type: 'boolean', default: false },
  },
});
const match = matcher(loadPatterns(values.list));
const files = parseDiff(readFileSync(values.diff, 'utf8'))
  .flatMap(touchedPaths)
  .flatMap((path) => {
    const pattern = match(path);
    return pattern === null ? [] : [{ path, pattern }];
  });
process.stdout.write(`${JSON.stringify({ gated: files.length > 0, files })}\n`);
process.exitCode = files.length > 0 ? 1 : 0;
