import { writeFileSync } from 'node:fs';

try {
  writeFileSync(new URL('./tampered.txt', import.meta.url), 'written by a gate script\n');
} catch (error) {
  process.stderr.write(`${error.code}\n`);
  process.exit(3);
}
process.stdout.write('{"flagged":false,"findings":[]}\n');
