import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const USAGE = [
  'usage: node .github/gate/probe-replay.mjs --old <root> --new <root> --probes <dir> [--json] [--timeout <seconds>]',
  '       node .github/gate/probe-replay.mjs --selftest',
].join('\n');
const MAX_OUTPUT = 8 * 1024 * 1024;
const CHILD_ENV = process.env.PATH === undefined ? {} : { PATH: process.env.PATH };

const unique = (items) => [...new Set(items)].sort();

const CHECKS = [
  {
    id: 'gate-files',
    script: 'gate-files.mjs',
    hit: 'gated',
    miss: 'clear',
    field: 'paths',
    read: (data) =>
      typeof data?.gated === 'boolean' &&
      Array.isArray(data.files) &&
      data.files.every((file) => typeof file?.path === 'string') &&
      data.gated === data.files.length > 0
        ? unique(data.files.map((file) => file.path))
        : null,
  },
  {
    id: 'tripwire',
    script: 'tripwire.mjs',
    hit: 'flag',
    miss: 'clean',
    field: 'rules',
    read: (data) =>
      typeof data?.flagged === 'boolean' &&
      Array.isArray(data.findings) &&
      data.findings.every((finding) => typeof finding?.rule === 'string') &&
      data.flagged === data.findings.length > 0
        ? unique(data.findings.map((finding) => finding.rule))
        : null,
  },
];

const resultOf = (check, items) => ({ result: items.length > 0 ? check.hit : check.miss, [check.field]: items });

const clean = (text) => JSON.stringify(String(text)).slice(1, -1);

const brief = (stderr) => {
  const lines = stderr.split('\n').map((line) => line.trim()).filter((line) => line !== '');
  return lines.length === 0 ? '' : `: ${lines.slice(0, 4).join(' | ').slice(0, 400)}`;
};

const runCheck = (root, side, check, diff, timeoutMs) => {
  const script = join(root, '.github', 'gate', check.script);
  if (!existsSync(script)) {
    return side === 'old' ? { value: { ...resultOf(check, []), missing: true } } : { error: `${check.script} is missing` };
  }
  const run = spawnSync(
    process.execPath,
    ['--permission', `--allow-fs-read=${join(root, '.github')}`, `--allow-fs-read=${diff}`, script, '--diff', diff, '--json'],
    {
      cwd: root,
      env: CHILD_ENV,
      encoding: 'utf8',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: MAX_OUTPUT,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  if (run.error?.code === 'ETIMEDOUT') return { error: `${check.script} timed out after ${timeoutMs / 1000}s` };
  if (run.error?.code === 'ENOBUFS') return { error: `${check.script} wrote more than ${MAX_OUTPUT} bytes` };
  if (run.error) return { error: `${check.script} did not start: ${run.error.message}` };
  if (run.status !== 0 && run.status !== 1) {
    return { error: `${check.script} exited ${run.status ?? run.signal}${brief(run.stderr)}` };
  }
  let data;
  try {
    data = JSON.parse(run.stdout);
  } catch {
    return { error: `${check.script} exited ${run.status} without JSON on stdout${brief(run.stderr)}` };
  }
  const items = check.read(data);
  if (items === null) return { error: `${check.script} printed JSON that does not match the contract` };
  if ((items.length > 0) !== (run.status === 1)) {
    return { error: `${check.script} exited ${run.status} but its JSON says ${resultOf(check, items).result}` };
  }
  return { value: resultOf(check, items) };
};

const keyOf = (probe, check) => `${probe.name}\n${check.id}`;

const measure = (root, side, probes, timeoutMs) => {
  const values = new Map();
  for (const probe of probes) {
    for (const check of CHECKS) {
      const { value, error } = runCheck(root, side, check, probe.diff, timeoutMs);
      if (error !== undefined) return { values, error: { probe: probe.name, check: check.id, root: side, error } };
      values.set(keyOf(probe, check), value);
    }
  }
  return { values, error: null };
};

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const findProbes = (dir) => {
  const entries = readdirSync(dir, { withFileTypes: true }).sort(byName);
  const here = entries.some((entry) => entry.isFile() && entry.name === 'pr.diff') ? [dir] : [];
  return [...here, ...entries.filter((entry) => entry.isDirectory()).flatMap((entry) => findProbes(join(dir, entry.name)))];
};

const findSymlink = (path) => {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  if (stat.isSymbolicLink()) return path;
  if (!stat.isDirectory()) return null;
  for (const entry of readdirSync(path)) {
    const found = findSymlink(join(path, entry));
    if (found !== null) return found;
  }
  return null;
};

const replay = ({ oldRoot, newRoot, probesDir, timeoutMs }) => {
  const probes = findProbes(probesDir).map((dir) => ({
    name: relative(probesDir, dir).split(sep).join('/') || '.',
    diff: realpathSync(join(dir, 'pr.diff')),
  }));
  const report = { old: oldRoot, new: newRoot, probes: probes.map((probe) => probe.name), results: [], flips: [], stricter: [], errors: [] };
  if (probes.length === 0) {
    report.errors.push({ error: `no folder with a pr.diff under ${probesDir}` });
    return report;
  }
  for (const [side, root] of [['old', oldRoot], ['new', newRoot]]) {
    const link = findSymlink(join(root, '.github'));
    if (link !== null) {
      report.errors.push({ root: side, error: `symlink in the ${side} root: ${relative(root, link)}` });
      return report;
    }
  }
  const before = measure(oldRoot, 'old', probes, timeoutMs);
  if (before.error !== null) {
    report.errors.push(before.error);
    return report;
  }
  const after = measure(newRoot, 'new', probes, timeoutMs);
  if (after.error !== null) report.errors.push(after.error);
  for (const probe of probes) {
    for (const check of CHECKS) {
      const was = before.values.get(keyOf(probe, check));
      const now = after.values.get(keyOf(probe, check));
      if (now === undefined) continue;
      const lost = was[check.field].filter((item) => !now[check.field].includes(item));
      const gained = now[check.field].filter((item) => !was[check.field].includes(item));
      const entry = { probe: probe.name, check: check.id, old: was, new: now, lost, gained };
      report.results.push(entry);
      if (lost.length > 0) report.flips.push(entry);
      else if (gained.length > 0) report.stricter.push(entry);
    }
  }
  return report;
};

const describe = (value) => {
  if (value.missing) return 'missing (allows everything)';
  const items = value.paths ?? value.rules;
  return items.length === 0 ? value.result : `${value.result} (${items.join(', ')})`;
};

const verdict = (report) => {
  if (report.errors.length > 0) return 'probe-replay: error: the replay did not finish, so it cannot show that nothing got looser';
  if (report.flips.length > 0) {
    return `probe-replay: loosened: the new gate allows ${report.flips.length} probe result(s) that the old gate refused`;
  }
  return `probe-replay: nothing loosened (${report.stricter.length} stricter)`;
};

const render = (report) => {
  const lines = [`probe-replay: old ${report.old}, new ${report.new}, ${report.probes.length} probes`];
  for (const entry of report.flips) {
    lines.push(`FLIP ${entry.probe} ${entry.check}: old ${describe(entry.old)} -> new ${describe(entry.new)}; lost ${entry.lost.join(', ')}`);
  }
  for (const entry of report.stricter) {
    lines.push(`STRICTER ${entry.probe} ${entry.check}: old ${describe(entry.old)} -> new ${describe(entry.new)}; gained ${entry.gained.join(', ')}`);
  }
  for (const entry of report.errors) {
    const where = [entry.probe, entry.check, entry.root && `(${entry.root} root)`].filter(Boolean).join(' ');
    lines.push(`ERROR ${where}: ${entry.error}`);
  }
  lines.push(verdict(report));
  return `${lines.map(clean).join('\n')}\n`;
};

const SELF = fileURLToPath(import.meta.url);
const FIXTURES = fileURLToPath(new URL('./probes/replay/', import.meta.url));
const LIB = fileURLToPath(new URL('./lib/', import.meta.url));
const STRICT = {
  gateFiles: 'stand-in/gate-files.mjs',
  tripwire: 'stand-in/tripwire.mjs',
  list: 'strict/gate-files.txt',
  rules: 'strict/rules.json',
};

const CASES = [
  { name: 'identical roots', old: STRICT, new: STRICT, code: 0, flips: [], expect: true },
  {
    name: 'loosened tripwire (one rule removed)',
    old: STRICT,
    new: { ...STRICT, rules: 'loose-rules/rules.json' },
    code: 1,
    flips: ['workflow-or-true tripwire'],
  },
  {
    name: 'shortened gate-file list',
    old: STRICT,
    new: { ...STRICT, list: 'loose-list/gate-files.txt' },
    code: 1,
    flips: ['agent-build-script gate-files', 'workflow-or-true gate-files'],
  },
  {
    name: 'stricter new version',
    old: STRICT,
    new: { ...STRICT, rules: 'stricter/rules.json' },
    code: 0,
    flips: [],
    stricter: ['workflow-sleep tripwire'],
  },
  {
    name: 'crashing new script',
    old: STRICT,
    new: { ...STRICT, tripwire: 'stand-in/crash.mjs' },
    code: 2,
    error: 'stand-in crash',
  },
  {
    name: 'old root without tripwire.mjs allows everything',
    old: { ...STRICT, tripwire: null },
    new: STRICT,
    code: 0,
    flips: [],
    stricter: ['workflow-or-true tripwire'],
  },
  {
    name: 'new root without tripwire.mjs',
    old: STRICT,
    new: { ...STRICT, tripwire: null },
    code: 2,
    error: 'tripwire.mjs is missing',
  },
  {
    name: 'new script cannot write files',
    old: STRICT,
    new: { ...STRICT, tripwire: 'stand-in/tamper.mjs' },
    code: 2,
    error: 'ERR_ACCESS_DENIED',
    absent: '.github/gate/tampered.txt',
  },
  {
    name: 'new script whose exit code disagrees with its JSON',
    old: STRICT,
    new: { ...STRICT, tripwire: 'stand-in/liar.mjs' },
    code: 2,
    error: 'exited 0 but its JSON says flag',
  },
  {
    name: 'symlink in the new root',
    old: STRICT,
    new: { ...STRICT, symlink: true },
    code: 2,
    error: 'symlink in the new root',
  },
  {
    name: 'hanging new script',
    old: STRICT,
    new: { ...STRICT, tripwire: 'stand-in/hang.mjs' },
    code: 2,
    error: 'timed out',
    args: ['--timeout', '1'],
  },
  {
    name: 'gate scripts see no inherited variable',
    old: { ...STRICT, tripwire: 'stand-in/env.mjs' },
    new: { ...STRICT, tripwire: 'stand-in/env.mjs' },
    code: 0,
    flips: [],
    env: { PROBE_REPLAY_CANARY: 'visible' },
  },
];

const buildRoot = (dir, spec) => {
  const gate = join(dir, '.github', 'gate');
  mkdirSync(gate, { recursive: true });
  cpSync(LIB, join(gate, 'lib'), { recursive: true });
  cpSync(join(FIXTURES, spec.list), join(dir, '.github', 'gate-files.txt'));
  cpSync(join(FIXTURES, spec.rules), join(gate, 'stand-in-rules.json'));
  if (spec.gateFiles !== null) cpSync(join(FIXTURES, spec.gateFiles), join(gate, 'gate-files.mjs'));
  if (spec.tripwire !== null) cpSync(join(FIXTURES, spec.tripwire), join(gate, 'tripwire.mjs'));
  if (spec.symlink) symlinkSync(join(FIXTURES, spec.list), join(gate, 'linked.txt'));
  return dir;
};

const names = (entries) => entries.map((entry) => `${entry.probe} ${entry.check}`).sort().join(', ');

const expectProblems = (report) =>
  report.probes.flatMap((probe) => {
    const expect = JSON.parse(readFileSync(join(FIXTURES, probe, 'expect.json'), 'utf8'));
    const seen = (id) => report.results.find((entry) => entry.probe === probe && entry.check === id)?.old;
    const gate = seen('gate-files');
    const trip = seen('tripwire');
    const problems = [];
    if (gate?.result !== expect.gateFiles) problems.push(`${probe} gate-files is ${gate?.result}, expect.json says ${expect.gateFiles}`);
    if (trip?.result !== expect.tripwire) problems.push(`${probe} tripwire is ${trip?.result}, expect.json says ${expect.tripwire}`);
    const rules = unique(expect.rules ?? []).join(', ');
    if ((trip?.rules ?? []).join(', ') !== rules) problems.push(`${probe} rules are [${trip?.rules}], expect.json says [${rules}]`);
    return problems;
  });

const caseProblems = (test, run, report, newRoot) => {
  const problems = run.status === test.code ? [] : [`exit ${run.status ?? run.signal}, expected ${test.code}`];
  if (report === null) return [...problems, `no JSON report${brief(run.stderr)}`];
  if (test.flips !== undefined && names(report.flips) !== [...test.flips].sort().join(', ')) {
    problems.push(`flips [${names(report.flips)}], expected [${test.flips.join(', ')}]`);
  }
  if (test.stricter !== undefined && names(report.stricter) !== [...test.stricter].sort().join(', ')) {
    problems.push(`stricter [${names(report.stricter)}], expected [${test.stricter.join(', ')}]`);
  }
  if (test.error !== undefined && !report.errors.some((entry) => entry.error.includes(test.error))) {
    problems.push(`no error mentions "${test.error}": ${report.errors.map((entry) => entry.error).join('; ')}`);
  }
  if (test.code !== 2 && report.errors.length > 0) problems.push(`errors: ${report.errors.map((entry) => entry.error).join('; ')}`);
  if (test.expect) problems.push(...expectProblems(report));
  if (test.absent !== undefined && existsSync(join(newRoot, test.absent))) problems.push(`${test.absent} was written`);
  return problems;
};

const parseReport = (stdout) => {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
};

const outcomeLine = (report) => {
  if (report.flips.length > 0) return `; flips ${names(report.flips)}`;
  if (report.errors.length > 0) return `; error ${report.errors[0].error}`;
  if (report.stricter.length > 0) return `; stricter ${names(report.stricter)}`;
  return '';
};

const selftest = () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'probe-replay-')));
  let failed = 0;
  try {
    CASES.forEach((test, index) => {
      const oldRoot = buildRoot(join(tmp, String(index), 'old'), test.old);
      const newRoot = buildRoot(join(tmp, String(index), 'new'), test.new);
      const run = spawnSync(
        process.execPath,
        [SELF, '--old', oldRoot, '--new', newRoot, '--probes', FIXTURES, '--json', ...(test.args ?? [])],
        { encoding: 'utf8', env: { ...process.env, ...test.env } },
      );
      const report = parseReport(run.stdout);
      const problems = caseProblems(test, run, report, newRoot);
      if (problems.length > 0) failed += 1;
      const status = problems.length === 0 ? 'ok  ' : 'FAIL';
      const detail = problems.length === 0 ? outcomeLine(report) : `; ${problems.join('; ')}`;
      process.stdout.write(`${status} ${test.name}: exit ${run.status ?? run.signal}${clean(detail)}\n`);
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  process.stdout.write(`selftest: ${CASES.length - failed} of ${CASES.length} cases passed\n`);
  return failed === 0 ? 0 : 1;
};

const usage = (message) => {
  process.stderr.write(`probe-replay: ${message}\n${USAGE}\n`);
  return 2;
};

const main = (args) => {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      options: {
        old: { type: 'string' },
        new: { type: 'string' },
        probes: { type: 'string' },
        json: { type: 'boolean', default: false },
        timeout: { type: 'string', default: '30' },
        selftest: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    return usage(error.message);
  }
  if (values.selftest) return selftest();
  if (values.old === undefined || values.new === undefined || values.probes === undefined) {
    return usage('--old, --new and --probes are required');
  }
  const seconds = Number(values.timeout);
  if (!Number.isFinite(seconds) || seconds <= 0) return usage(`--timeout takes a positive number of seconds, not ${values.timeout}`);
  let paths;
  try {
    paths = { oldRoot: realpathSync(values.old), newRoot: realpathSync(values.new), probesDir: realpathSync(values.probes) };
  } catch (error) {
    return usage(error.message);
  }
  for (const root of [paths.oldRoot, paths.newRoot]) {
    if (!statSync(join(root, '.github', 'gate'), { throwIfNoEntry: false })?.isDirectory()) {
      return usage(`${root} has no .github/gate folder`);
    }
  }
  if (!statSync(paths.probesDir).isDirectory()) return usage(`${paths.probesDir} is not a folder`);
  const report = replay({ ...paths, timeoutMs: seconds * 1000 });
  process.stdout.write(values.json ? `${JSON.stringify(report, null, 2)}\n` : render(report));
  if (report.errors.length > 0) return 2;
  return report.flips.length > 0 ? 1 : 0;
};

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`probe-replay: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
}
