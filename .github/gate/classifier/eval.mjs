import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseDiff } from '../lib/diff.mjs';

const CLASSIFY = fileURLToPath(new URL('./classify.mjs', import.meta.url));
const DEFAULT_CASES = fileURLToPath(new URL('./eval/cases', import.meta.url));
const KINDS = ['seeded', 'sneaky', 'negative'];
const USAGE = 'usage: node .github/gate/classifier/eval.mjs --max-usd <n> [--runs <n>] [--ledger <file>] [--cases <dir>] [--config <model.json>] [--gate-files <list>] [--test-files <list>] [--json] [--dry-run]';
const PASSED_TO_CLASSIFY = ['config', 'gate-files', 'test-files'];

class Failure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const usd = (value) => `US$${value.toFixed(value < 1 ? 4 : 2)}`;
const roundUsd = (value) => Math.round(value * 1e6) / 1e6;
const count = (n) => n.toLocaleString('en-US');

const readArgs = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        runs: { type: 'string', default: '20' },
        'max-usd': { type: 'string' },
        ledger: { type: 'string' },
        cases: { type: 'string' },
        config: { type: 'string' },
        'gate-files': { type: 'string' },
        'test-files': { type: 'string' },
        json: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new Failure(2, `${error.message}\n${USAGE}`);
  }
  if (values['max-usd'] === undefined) throw new Failure(2, `refusing to start: --max-usd <n> is required, it caps the total spend on model calls\n${USAGE}`);
  const maxUsd = Number(values['max-usd']);
  if (!Number.isFinite(maxUsd) || maxUsd <= 0) throw new Failure(2, `--max-usd must be a positive number, got ${values['max-usd']}`);
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Failure(2, `--runs must be a positive integer, got ${values.runs}`);
  return {
    runs,
    maxUsd,
    ledger: values.ledger === undefined ? null : resolve(values.ledger),
    cases: resolve(values.cases ?? DEFAULT_CASES),
    classifyArgs: PASSED_TO_CLASSIFY.flatMap((name) => (values[name] === undefined ? [] : [`--${name}`, resolve(values[name])])),
    json: values.json,
    dryRun: values['dry-run'],
  };
};

const hunkProblems = (text) => {
  const problems = [];
  let header = null;
  let oldLeft = 0;
  let newLeft = 0;
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const match = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/);
    if (match) {
      if (oldLeft !== 0 || newLeft !== 0) problems.push(`hunk "${header}" has fewer lines than its header says`);
      header = line;
      oldLeft = match[1] === undefined ? 1 : Number(match[1]);
      newLeft = match[2] === undefined ? 1 : Number(match[2]);
      continue;
    }
    if ((oldLeft === 0 && newLeft === 0) || line.startsWith('\\')) continue;
    if (line.startsWith(' ')) {
      oldLeft -= 1;
      newLeft -= 1;
    } else if (line.startsWith('-')) oldLeft -= 1;
    else if (line.startsWith('+')) newLeft -= 1;
    else {
      problems.push(`hunk "${header}" has fewer lines than its header says`);
      oldLeft = 0;
      newLeft = 0;
      continue;
    }
    if (oldLeft < 0 || newLeft < 0) {
      problems.push(`hunk "${header}" has more lines than its header says`);
      oldLeft = 0;
      newLeft = 0;
    }
  }
  if (oldLeft !== 0 || newLeft !== 0) problems.push(`hunk "${header}" has fewer lines than its header says`);
  return problems;
};

const expectProblems = (expect) => {
  if (!isObject(expect)) return ['expect.json must be a JSON object'];
  const problems = [];
  const keys = Object.keys(expect).sort().join();
  if (keys !== 'escalate,kind,note') problems.push(`expect.json keys must be escalate, kind, note; got ${keys || 'none'}`);
  if (typeof expect.escalate !== 'boolean') problems.push('escalate must be true or false');
  if (!KINDS.includes(expect.kind)) problems.push(`kind must be one of ${KINDS.join(', ')}`);
  if (typeof expect.note !== 'string' || expect.note.trim() === '') problems.push('note must be a non-empty string');
  if (KINDS.includes(expect.kind) && typeof expect.escalate === 'boolean' && expect.escalate !== (expect.kind !== 'negative')) {
    problems.push(`a ${expect.kind} case must have escalate ${expect.kind !== 'negative'}`);
  }
  return problems;
};

const loadCases = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Failure(2, `cannot read the cases folder ${dir}: ${error.message}`);
  }
  const cases = [];
  const problems = [];
  for (const entry of entries.filter((item) => !item.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) {
      problems.push(`${entry.name}: not a case folder`);
      continue;
    }
    const caseDir = join(dir, entry.name);
    const diffPath = join(caseDir, 'pr.diff');
    const found = [];
    let expect = null;
    try {
      expect = JSON.parse(readFileSync(join(caseDir, 'expect.json'), 'utf8'));
      found.push(...expectProblems(expect));
    } catch (error) {
      found.push(`expect.json: ${error.message}`);
    }
    let diff = '';
    try {
      diff = readFileSync(diffPath, 'utf8');
    } catch (error) {
      found.push(`pr.diff: ${error.message}`);
    }
    if (diff !== '' || found.length === 0) {
      if (!diff.startsWith('diff --git ')) found.push('pr.diff must start with a "diff --git" line');
      else if (parseDiff(diff).length === 0) found.push('pr.diff has no file');
      found.push(...hunkProblems(diff));
    }
    problems.push(...found.map((problem) => `${entry.name}: ${problem}`));
    if (found.length === 0) cases.push({ id: entry.name, diffPath, ...expect });
  }
  if (problems.length > 0) throw new Failure(2, `invalid eval cases in ${dir}:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
  if (cases.length === 0) throw new Failure(2, `no eval cases in ${dir}`);
  return cases;
};

const readLedger = (path) => {
  if (path === null || !existsSync(path)) return { spentUsd: 0, calls: 0 };
  let ledger;
  try {
    ledger = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Failure(2, `bad ledger ${path}: ${error.message}`);
  }
  const valid = isObject(ledger) && typeof ledger.spentUsd === 'number' && Number.isFinite(ledger.spentUsd) && ledger.spentUsd >= 0 && Number.isInteger(ledger.calls) && ledger.calls >= 0;
  if (!valid) throw new Failure(2, `bad ledger ${path}: want {"spentUsd": <number>, "calls": <integer>}`);
  return ledger;
};

const writeLedger = (path, ledger) => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
};

const runClassify = (args) =>
  new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLASSIFY, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });

const parseOutput = (run) => {
  try {
    return JSON.parse(run.stdout);
  } catch {
    return null;
  }
};

const renderAll = async (cases, classifyArgs) => {
  const problems = [];
  for (const item of cases) {
    const run = await runClassify(['--diff', item.diffPath, '--json', '--dry-run', ...classifyArgs]);
    if (run.code === 3) throw new Failure(3, run.stderr.trim());
    const output = parseOutput(run);
    if (run.code !== 0 || output === null) {
      problems.push(`${item.id}: the dry run exited ${run.code}: ${run.stderr.trim()}`);
      continue;
    }
    if (!output.wouldCall) problems.push(`${item.id}: the prompt does not reach the model: ${output.reasons.join('; ')}`);
    item.model = output.model;
    item.estimate = output.estimate;
  }
  if (problems.length > 0) throw new Failure(2, `eval cases that do not render:\n${problems.map((problem) => `- ${problem}`).join('\n')}`);
};

const kindCounts = (cases) => Object.fromEntries(KINDS.map((kind) => [kind, cases.filter((item) => item.kind === kind).length]));

const plan = (cases, runs, maxUsd, ledger) => {
  const sum = (pick) => cases.reduce((total, item) => total + pick(item.estimate), 0);
  return {
    dryRun: true,
    model: cases[0].model,
    cases: cases.length,
    kinds: kindCounts(cases),
    runs,
    calls: runs * cases.length,
    inputTokensPerRun: sum((estimate) => estimate.inputTokens),
    worstInputTokensPerRun: sum((estimate) => estimate.worstInputTokens),
    maxOutputTokensPerCall: cases[0].estimate.maxOutputTokens,
    costUsd: roundUsd(runs * sum((estimate) => estimate.costUsd)),
    worstCostUsd: roundUsd(runs * sum((estimate) => estimate.worstCostUsd)),
    maxUsd,
    ledgerUsd: ledger.spentUsd,
    perCase: cases.map((item) => ({ id: item.id, kind: item.kind, escalate: item.escalate, inputTokens: item.estimate.inputTokens, worstCostUsd: item.estimate.worstCostUsd })),
  };
};

const planText = (summary) => {
  const averageInput = Math.round(summary.inputTokensPerRun / summary.cases);
  const lines = [
    `Eval cases: ${summary.cases} (seeded ${summary.kinds.seeded}, sneaky ${summary.kinds.sneaky}, negative ${summary.kinds.negative}). All cases are valid and ${summary.cases} prompts rendered.`,
    '',
    ...summary.perCase.map((item) => `  ${item.id.padEnd(48)} ${item.kind.padEnd(9)} ${item.escalate ? 'escalate' : 'clear   '} about ${count(item.inputTokens)} input tokens`),
    '',
    `Model ${summary.model}. Plan: ${summary.runs} runs x ${summary.cases} cases = ${count(summary.calls)} calls.`,
    `Expected cost: ${count(summary.calls)} calls x about ${count(averageInput)} input tokens and at most ${count(summary.maxOutputTokensPerCall)} output tokens = about ${usd(summary.costUsd)}. Worst case: ${usd(summary.worstCostUsd)}.`,
    `Cap: ${usd(summary.maxUsd)}. Ledger: ${usd(summary.ledgerUsd)} spent. The run stops before any call whose worst case could pass the cap.`,
    ...(summary.ledgerUsd + summary.worstCostUsd > summary.maxUsd ? ['The worst case of the full plan is above the cap, so a real run can stop early, but its spend cannot pass the cap.'] : []),
    'Dry run: no model call made.',
  ];
  return lines.join('\n');
};

const evaluate = async (cases, args) => {
  let ledger = readLedger(args.ledger);
  const startUsd = ledger.spentUsd;
  const current = () => (args.ledger === null ? ledger : readLedger(args.ledger));
  const verdicts = new Map(cases.map((item) => [item.id, []]));
  let invalidAnswers = 0;
  let completedRuns = 0;
  let stopped = null;
  for (let run = 1; run <= args.runs && stopped === null; run += 1) {
    for (const item of cases) {
      ledger = current();
      if (ledger.spentUsd + item.estimate.worstCostUsd > args.maxUsd) {
        stopped = `stopped before run ${run}, case ${item.id}: ${usd(ledger.spentUsd)} spent plus a worst case of ${usd(item.estimate.worstCostUsd)} could pass the cap of ${usd(args.maxUsd)}`;
        break;
      }
      const outcome = await runClassify(['--diff', item.diffPath, '--json', ...args.classifyArgs]);
      if (outcome.code === 2 || outcome.code === 3) throw new Failure(outcome.code, `${item.id}: ${outcome.stderr.trim()}`);
      const result = parseOutput(outcome);
      const costUsd = result?.call === 'ok' ? result.costUsd : result?.call === 'skipped' ? 0 : item.estimate.worstCostUsd;
      const before = current();
      ledger = { spentUsd: roundUsd(before.spentUsd + costUsd), calls: before.calls + 1 };
      if (args.ledger !== null) writeLedger(args.ledger, ledger);
      if (result === null || result.answers === null) invalidAnswers += 1;
      verdicts.get(item.id).push(outcome.code === 0 ? 'clear' : 'escalate');
    }
    if (stopped === null) completedRuns = run;
  }
  const perCase = cases.map((item) => {
    const list = verdicts.get(item.id);
    const escalations = list.filter((verdict) => verdict === 'escalate').length;
    return { id: item.id, kind: item.kind, escalate: item.escalate, runs: list.length, escalations, clears: list.length - escalations };
  });
  const missCases = perCase.filter((item) => item.escalate && item.clears > 0).map((item) => ({ id: item.id, count: item.clears, runs: item.runs }));
  const alarmCases = perCase.filter((item) => !item.escalate && item.escalations > 0).map((item) => ({ id: item.id, count: item.escalations, runs: item.runs }));
  const judged = perCase.filter((item) => item.runs > 0);
  return {
    model: cases[0].model,
    cases: cases.length,
    kinds: kindCounts(cases),
    runs: { planned: args.runs, completed: completedRuns },
    misses: {
      verdicts: missCases.reduce((sum, item) => sum + item.count, 0),
      of: perCase.filter((item) => item.escalate).reduce((sum, item) => sum + item.runs, 0),
      cases: missCases,
    },
    falseAlarms: {
      verdicts: alarmCases.reduce((sum, item) => sum + item.count, 0),
      of: perCase.filter((item) => !item.escalate).reduce((sum, item) => sum + item.runs, 0),
      cases: alarmCases,
    },
    invalidAnswers,
    stability: { stable: judged.filter((item) => item.escalations === 0 || item.clears === 0).length, cases: judged.length },
    spendUsd: { thisRun: roundUsd(ledger.spentUsd - startUsd), ledger: ledger.spentUsd, cap: args.maxUsd },
    stopped,
    perCase,
  };
};

const reportText = (report) => {
  const list = (items) => items.map((item) => `  ${item.id} ${item.count}/${item.runs}`);
  return [
    `Eval of ${report.model} on ${report.cases} cases (seeded ${report.kinds.seeded}, sneaky ${report.kinds.sneaky}, negative ${report.kinds.negative}): ${report.runs.completed}/${report.runs.planned} runs complete.`,
    ...(report.stopped ? [`Stopped at the cap: ${report.stopped}.`] : []),
    `Misses (expected escalate, got clear): ${report.misses.verdicts} of ${report.misses.of} verdicts.`,
    ...list(report.misses.cases),
    `False alarms (expected clear, got escalate): ${report.falseAlarms.verdicts} of ${report.falseAlarms.of} verdicts.`,
    ...list(report.falseAlarms.cases),
    `No valid model answer (counted as escalate): ${report.invalidAnswers} calls.`,
    `Stability: ${report.stability.stable}/${report.stability.cases} cases gave the same verdict in every run.`,
    `Spend: ${usd(report.spendUsd.thisRun)} in this run, ${usd(report.spendUsd.ledger)} in the ledger, cap ${usd(report.spendUsd.cap)}.`,
  ].join('\n');
};

const main = async (argv) => {
  const args = readArgs(argv);
  const ledger = readLedger(args.ledger);
  const cases = loadCases(args.cases);
  await renderAll(cases, args.classifyArgs);
  if (args.dryRun) {
    const summary = plan(cases, args.runs, args.maxUsd, ledger);
    process.stdout.write(`${args.json ? JSON.stringify(summary, null, 2) : planText(summary)}\n`);
    return 0;
  }
  const report = await evaluate(cases, args);
  process.stdout.write(`${args.json ? JSON.stringify(report, null, 2) : reportText(report)}\n`);
  return report.stopped ? 1 : 0;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`eval: ${error instanceof Failure ? error.message : error.stack}\n`);
    process.exitCode = error instanceof Failure ? error.exitCode : 1;
  },
);
