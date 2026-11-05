import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { addedLines, filePath, parseDiff } from './lib/diff.mjs';

const { values } = parseArgs({
  options: {
    diff: { type: 'string' },
    'gate-files': { type: 'string' },
    'test-files': { type: 'string' },
    json: { type: 'boolean', default: false },
  },
});
const rules = Object.entries(JSON.parse(readFileSync(new URL('./stand-in-rules.json', import.meta.url), 'utf8')))
  .map(([rule, source]) => ({ rule, re: new RegExp(source) }));
const findings = parseDiff(readFileSync(values.diff, 'utf8')).flatMap((file) =>
  addedLines(file).flatMap((line) =>
    rules
      .filter(({ re }) => re.test(line.text))
      .map(({ rule }) => ({ rule, file: filePath(file), line: line.newLine, text: line.text })),
  ),
);
process.stdout.write(`${JSON.stringify({ flagged: findings.length > 0, findings })}\n`);
process.exitCode = findings.length > 0 ? 1 : 0;
