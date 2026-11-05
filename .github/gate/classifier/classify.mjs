import { createHash } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { addedLines, filePath, parseDiff, removedLines, touchedPaths } from '../lib/diff.mjs';
import { loadPatterns, matcher } from '../lib/patterns.mjs';

const here = (relative) => fileURLToPath(new URL(relative, import.meta.url));

const PROMPT_FILE = here('./prompt.md');
const DEFAULT_CONFIG = here('./model.json');
const DEFAULT_GATE_FILES = here('../../gate-files.txt');
const DEFAULT_TEST_FILES = here('../test-files.txt');
const KEY_NAME = 'GATE_CLASSIFIER_API_KEY';
const BOUNDARY_SLOT = '{{BOUNDARY}}';
const BYTES_PER_TOKEN = 3;
const OVERHEAD_TOKENS = 1000;
const TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CALLS = 5;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const HISTORY_FILE = 'history.json';
const OUTCOME_FILE = 'outcome.json';
const VERDICTS = new Set(['clear', 'escalate']);

const USAGE = 'usage: node .github/gate/classifier/classify.mjs --diff <file> [--config <model.json>] [--gate-files <list>] [--test-files <list>] [--state <dir> --sha <head-sha> --base <base-sha> [--max-calls <n>]] [--json] [--dry-run]';

const QUESTIONS = {
  easesGate: 'Does the change ease a gate or a check?',
  untestedCode: 'Does added code come without tests?',
  weakensTests: 'Does it weaken existing tests to get around them?',
};
const QUESTION_KEYS = Object.keys(QUESTIONS);

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: { type: 'string', enum: ['yes', 'no'] },
    why: { type: 'string' },
  },
  required: ['answer', 'why'],
  additionalProperties: false,
};

const ANSWERS_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(QUESTION_KEYS.map((key) => [key, ANSWER_SCHEMA])),
  required: QUESTION_KEYS,
  additionalProperties: false,
};

const PROVIDERS = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    path: '/v1/messages',
    headers: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    body: (config, system, user) => ({
      model: config.model,
      'max_tokens': config.maxOutputTokens,
      temperature: config.temperature,
      system,
      messages: [{ role: 'user', content: user }],
      'output_config': { format: { type: 'json_schema', schema: ANSWERS_SCHEMA } },
    }),
    read: (data) => ({
      text: Array.isArray(data?.content)
        ? data.content.filter((block) => block?.type === 'text').map((block) => block.text).join('')
        : null,
      stop: data?.stop_reason ?? null,
      inputTokens: data?.usage?.input_tokens,
      outputTokens: data?.usage?.output_tokens,
    }),
  },
  openai: {
    baseUrl: 'https://api.openai.com',
    path: '/v1/chat/completions',
    headers: (key) => ({ authorization: `Bearer ${key}` }),
    body: (config, system, user) => ({
      model: config.model,
      temperature: config.temperature,
      'max_completion_tokens': config.maxOutputTokens,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      'response_format': { type: 'json_schema', 'json_schema': { name: 'easing_answers', strict: true, schema: ANSWERS_SCHEMA } },
    }),
    read: (data) => {
      const choice = data?.choices?.[0];
      return {
        text: choice?.message?.content ?? null,
        stop: choice?.message?.refusal ? 'refusal' : (choice?.finish_reason ?? null),
        inputTokens: data?.usage?.prompt_tokens,
        outputTokens: data?.usage?.completion_tokens,
      };
    },
  },
};

const CONFIG_KEYS = new Set(['provider', 'model', 'temperature', 'maxOutputTokens', 'maxInputTokens', 'usdPerMillionTokens', 'baseUrl']);
const KIND_LABELS = { gate: 'gate file', test: 'test file', source: 'source file' };

class Failure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPositiveInteger = (value) => Number.isInteger(value) && value > 0;
const isTokenCount = (value) => Number.isInteger(value) && value >= 0;
const isPrice = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const estimateTokens = (byteCount) => Math.ceil(byteCount / BYTES_PER_TOKEN) + OVERHEAD_TOKENS;
const worstCaseTokens = (byteCount) => byteCount + OVERHEAD_TOKENS;
const roundUsd = (value) => Math.round(value * 1e6) / 1e6;
const priceUsd = (inputTokens, outputTokens, prices) => roundUsd((inputTokens * prices.input + outputTokens * prices.output) / 1e6);
const SCHEMA_BYTES = bytes(JSON.stringify(ANSWERS_SCHEMA));

const isHttpUrl = (value) => {
  if (typeof value !== 'string') return false;
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const readArgs = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        diff: { type: 'string' },
        config: { type: 'string' },
        'gate-files': { type: 'string' },
        'test-files': { type: 'string' },
        state: { type: 'string' },
        sha: { type: 'string' },
        base: { type: 'string' },
        'max-calls': { type: 'string' },
        json: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    throw new Failure(2, `${error.message}\n${USAGE}`);
  }
  if (!values.diff) throw new Failure(2, `--diff <file> is required\n${USAGE}`);
  if (Boolean(values.state) !== Boolean(values.sha) || Boolean(values.state) !== Boolean(values.base)) throw new Failure(2, `--state, --sha and --base go together\n${USAGE}`);
  if (values.sha && !SHA_PATTERN.test(values.sha)) throw new Failure(2, `--sha must be a full 40-character commit SHA\n${USAGE}`);
  if (values.base && !SHA_PATTERN.test(values.base)) throw new Failure(2, `--base must be a full 40-character commit SHA\n${USAGE}`);
  if (values['max-calls'] !== undefined && !values.state) throw new Failure(2, `--max-calls needs --state\n${USAGE}`);
  const maxCalls = values['max-calls'] === undefined ? DEFAULT_MAX_CALLS : Number(values['max-calls']);
  if (!isPositiveInteger(maxCalls)) throw new Failure(2, `--max-calls must be a positive integer\n${USAGE}`);
  return {
    state: values.state ? { dir: values.state, sha: values.sha, base: values.base, maxCalls } : null,
    diff: values.diff,
    config: values.config ?? DEFAULT_CONFIG,
    gateFiles: values['gate-files'] ?? DEFAULT_GATE_FILES,
    testFiles: values['test-files'] ?? DEFAULT_TEST_FILES,
    json: values.json,
    dryRun: values['dry-run'],
  };
};

const readKey = () => {
  const key = process.env[KEY_NAME]?.trim();
  if (!key) {
    throw new Failure(3, `${KEY_NAME} is not set, so the model was not called and this PR goes to a human approver. A fork PR gets no secrets on pull_request. Outside CI, set ${KEY_NAME} to the API key of the provider in the config (in CI it is the repository secret ${KEY_NAME}).`);
  }
  return key;
};

const readHistory = (state) => {
  const path = join(state.dir, HISTORY_FILE);
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Failure(3, `bad classifier state: cannot read ${path} (history.mjs writes it): ${error.message}`);
  }
  const valid =
    isObject(value) &&
    value.sha === state.sha &&
    value.base === state.base &&
    isTokenCount(value.calls) &&
    (value.verdict === null || VERDICTS.has(value.verdict)) &&
    (value.from === null || typeof value.from === 'string');
  if (!valid) throw new Failure(3, `bad classifier state ${path}: want {"sha": "${state.sha}", "base": "${state.base}", "calls": <integer>, "verdict": null | "clear" | "escalate", "from": <string> | null}`);
  return value;
};

const writeOutcome = (state, escalate) => {
  const path = join(state.dir, OUTCOME_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify({ sha: state.sha, base: state.base, escalate })}\n`);
  renameSync(temporary, path);
};

const savedResult = (state, config) => {
  const { verdict, from } = state.history;
  const reasons = verdict === 'escalate' ? [`an earlier run for head ${state.sha} on base ${state.base} escalated${from ? ` (${from})` : ''}`] : [];
  return {
    escalate: verdict === 'escalate',
    answers: null,
    reasons,
    call: 'saved',
    model: `${config.provider}/${config.model}`,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    shortened: [],
    savedFrom: from,
  };
};

const configProblems = (config) => {
  if (!isObject(config)) return ['the config must be a JSON object'];
  const problems = Object.keys(config).filter((key) => !CONFIG_KEYS.has(key)).map((key) => `unknown key "${key}"`);
  if (!Object.hasOwn(PROVIDERS, config.provider)) problems.push(`provider must be one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (typeof config.model !== 'string' || config.model.trim() === '') problems.push('model must be a non-empty string');
  if (typeof config.temperature !== 'number' || !(config.temperature >= 0 && config.temperature <= 2)) problems.push('temperature must be a number from 0 to 2');
  if (!isPositiveInteger(config.maxOutputTokens)) problems.push('maxOutputTokens must be a positive integer');
  if (!isPositiveInteger(config.maxInputTokens)) problems.push('maxInputTokens must be a positive integer');
  const prices = config.usdPerMillionTokens;
  if (!isObject(prices) || Object.keys(prices).sort().join() !== 'input,output' || !isPrice(prices.input) || !isPrice(prices.output)) {
    problems.push('usdPerMillionTokens must be {"input": <number>, "output": <number>}');
  }
  if (config.baseUrl !== undefined && !isHttpUrl(config.baseUrl)) problems.push('baseUrl must be an http or https URL');
  return problems;
};

const loadConfig = (path) => {
  let config;
  try {
    config = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Failure(3, `bad config ${path}: ${error.message}`);
  }
  const problems = configProblems(config);
  if (problems.length > 0) throw new Failure(3, `bad config ${path}: ${problems.join('; ')}`);
  return config;
};

const loadPrompt = () => {
  let text;
  try {
    text = readFileSync(PROMPT_FILE, 'utf8');
  } catch (error) {
    throw new Failure(3, `bad config: cannot read the prompt ${PROMPT_FILE}: ${error.message}`);
  }
  if (!text.includes(BOUNDARY_SLOT)) throw new Failure(3, `bad config: the prompt ${PROMPT_FILE} has no ${BOUNDARY_SLOT} slot`);
  return text;
};

const loadList = (path, name) => {
  try {
    return matcher(loadPatterns(path));
  } catch (error) {
    throw new Failure(3, `bad config: cannot read the ${name} ${path}: ${error.message}`);
  }
};

const readDiff = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch (error) {
    throw new Failure(2, `cannot read the diff ${path}: ${error.message}`);
  }
};

const splitFiles = (text) => {
  const chunks = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) chunks.push([line]);
    else if (chunks.length > 0) chunks.at(-1).push(line);
    else if (line.trim() !== '') throw new Failure(2, 'the diff must be `git diff` output: found text before the first "diff --git" line');
  }
  return chunks.map((lines) => lines.join('\n').replace(/\n+$/, ''));
};

const describeFile = (text, isGate, isTest) => {
  const [file] = parseDiff(text);
  const paths = touchedPaths(file);
  const kind = paths.some((path) => isGate(path) !== null) ? 'gate' : paths.some((path) => isTest(path) !== null) ? 'test' : 'source';
  return {
    text,
    kind,
    path: filePath(file),
    oldPath: file.oldPath,
    status: file.status,
    binary: file.binary,
    added: addedLines(file).length,
    removed: removedLines(file).length,
  };
};

const headerLine = (file, index, count, shortened) => {
  const facts = [KIND_LABELS[file.kind], file.status === 'renamed' ? `renamed from ${JSON.stringify(file.oldPath)}` : file.status];
  if (file.binary) facts.push('binary');
  facts.push(`+${file.added} -${file.removed}`);
  if (shortened) facts.push('shortened');
  return `=== file ${index + 1} of ${count}: ${JSON.stringify(file.path)} (${facts.join(', ')})`;
};

const openLine = (boundary) => `<<<PR-DATA ${boundary}`;
const closeLine = (boundary) => `PR-DATA ${boundary}>>>`;

const renderData = (files, shortened, boundary) => {
  const parts = [openLine(boundary)];
  files.forEach((file, index) => {
    const short = shortened.has(index);
    parts.push(headerLine(file, index, files.length, short));
    if (!short) parts.push(file.text);
  });
  parts.push(closeLine(boundary));
  return parts.join('\n');
};

const shortenToBudget = (files, fixedBytes, budgetTokens) => {
  const shortened = new Set();
  const sizes = files.map((file, index) => ({
    whole: bytes(headerLine(file, index, files.length, false)) + 1 + bytes(file.text) + 1,
    short: bytes(headerLine(file, index, files.length, true)) + 1,
  }));
  let total = fixedBytes + sizes.reduce((sum, size) => sum + size.whole, 0);
  const sources = files
    .map((file, index) => index)
    .filter((index) => files[index].kind === 'source')
    .sort((a, b) => sizes[b].whole - sizes[a].whole);
  for (const index of sources) {
    if (estimateTokens(total) <= budgetTokens) break;
    shortened.add(index);
    total -= sizes[index].whole - sizes[index].short;
  }
  return { shortened, fits: estimateTokens(total) <= budgetTokens, tokens: estimateTokens(total) };
};

const prepare = (diffText, promptText, config, isGate, isTest) => {
  const boundary = createHash('sha256').update(diffText).digest('hex').slice(0, 32);
  const system = promptText.replaceAll(BOUNDARY_SLOT, boundary);
  const files = splitFiles(diffText).map((text) => describeFile(text, isGate, isTest));
  const reasons = [];
  if (diffText.includes(boundary)) reasons.push('the diff contains the data boundary marker');
  const fixedBytes = bytes(system) + SCHEMA_BYTES + bytes(openLine(boundary)) + 1 + bytes(closeLine(boundary));
  const fit = shortenToBudget(files, fixedBytes, config.maxInputTokens);
  if (!fit.fits) {
    reasons.push(`the diff does not fit in the input budget with every source file shortened (about ${fit.tokens} tokens, budget ${config.maxInputTokens}); gate-file and test-file hunks are never shortened`);
  }
  const user = renderData(files, fit.shortened, boundary);
  const requestBytes = bytes(system) + bytes(user) + SCHEMA_BYTES;
  return {
    files,
    system,
    user,
    reasons,
    shortened: files.filter((file, index) => fit.shortened.has(index)).map((file) => file.path),
    wouldCall: files.length > 0 && reasons.length === 0,
    inputTokens: estimateTokens(requestBytes),
    worstInputTokens: worstCaseTokens(requestBytes),
  };
};

const parseAnswers = (text) => {
  if (typeof text !== 'string') return { error: 'the reply has no text' };
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'the reply is not JSON' };
  }
  if (!isObject(value)) return { error: 'the reply is not a JSON object' };
  const keys = Object.keys(value).sort().join(', ');
  if (keys !== [...QUESTION_KEYS].sort().join(', ')) return { error: `the keys must be ${QUESTION_KEYS.join(', ')}; got ${keys || 'none'}` };
  const answers = {};
  for (const key of QUESTION_KEYS) {
    const entry = value[key];
    if (!isObject(entry) || Object.keys(entry).sort().join() !== 'answer,why') return { error: `${key} must have exactly the keys answer and why` };
    const answer = typeof entry.answer === 'string' ? entry.answer.toLowerCase() : null;
    if (answer !== 'yes' && answer !== 'no') return { error: `${key}.answer must be yes or no` };
    if (typeof entry.why !== 'string' || entry.why.trim() === '') return { error: `${key}.why must be a non-empty string` };
    answers[key] = { answer, why: entry.why.trim() };
  }
  return { answers };
};

const callModel = async (config, key, system, user) => {
  const provider = PROVIDERS[config.provider];
  const url = `${(config.baseUrl ?? provider.baseUrl).replace(/\/+$/, '')}${provider.path}`;
  let status;
  let text;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...provider.headers(key) },
      body: JSON.stringify(provider.body(config, system, user)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    status = response.status;
    text = await response.text();
  } catch (error) {
    throw new Error(`${url}: ${error.cause?.message ?? error.message}`, { cause: error });
  }
  if (status < 200 || status > 299) throw new Error(`HTTP ${status} from ${url}: ${text.slice(0, 300)}`);
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`the response from ${url} is not JSON`);
  }
  const reply = provider.read(data);
  if (!isTokenCount(reply.inputTokens) || !isTokenCount(reply.outputTokens)) throw new Error(`the response from ${url} has no usage numbers`);
  return reply;
};

const classify = async (prepared, config, key, state) => {
  const base = {
    model: `${config.provider}/${config.model}`,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    shortened: prepared.shortened,
  };
  if (prepared.files.length === 0) return { escalate: false, answers: null, reasons: [], call: 'skipped', ...base };
  if (!prepared.wouldCall) return { escalate: true, answers: null, reasons: prepared.reasons, call: 'skipped', ...base };
  if (state && state.history.calls >= state.maxCalls) {
    const reasons = [`this PR has used its cap of ${state.maxCalls} model calls (${state.history.calls} so far), so the model was not called and a human approver must review this PR`];
    return { escalate: true, answers: null, reasons, call: 'capped', ...base };
  }
  if (state) writeOutcome(state, true);
  let reply;
  try {
    reply = await callModel(config, key, prepared.system, prepared.user);
  } catch (error) {
    return { escalate: true, answers: null, reasons: [`model call failed: ${error.message}`], call: 'failed', ...base };
  }
  const usage = { inputTokens: reply.inputTokens, outputTokens: reply.outputTokens };
  const costUsd = priceUsd(usage.inputTokens, usage.outputTokens, config.usdPerMillionTokens);
  const parsed = parseAnswers(reply.text);
  if (parsed.error) {
    const stop = reply.stop ? ` (stop reason: ${reply.stop})` : '';
    return { escalate: true, answers: null, reasons: [`model output is not valid JSON in the required shape: ${parsed.error}${stop}`], call: 'ok', ...base, usage, costUsd };
  }
  const reasons = QUESTION_KEYS.filter((question) => parsed.answers[question].answer === 'yes').map((question) => `${question} is yes`);
  return { escalate: reasons.length > 0, answers: parsed.answers, reasons, call: 'ok', ...base, usage, costUsd };
};

const dryRun = (prepared, config) => {
  const prices = config.usdPerMillionTokens;
  const calls = prepared.wouldCall ? 1 : 0;
  return {
    dryRun: true,
    model: `${config.provider}/${config.model}`,
    wouldCall: prepared.wouldCall,
    reasons: prepared.reasons,
    shortened: prepared.shortened,
    estimate: {
      inputTokens: prepared.inputTokens,
      worstInputTokens: prepared.worstInputTokens,
      maxOutputTokens: config.maxOutputTokens,
      costUsd: calls * priceUsd(prepared.inputTokens, config.maxOutputTokens, prices),
      worstCostUsd: calls * priceUsd(prepared.worstInputTokens, config.maxOutputTokens, prices),
    },
    request: { system: prepared.system, user: prepared.user },
  };
};

const cell = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>|&]/g, '\\$&');

const NO_ANSWER = {
  ok: 'The model gave no valid answer.',
  failed: 'The model call failed.',
  skipped: 'The model was not called.',
  capped: 'The model was not called: this PR has reached its cap of model calls.',
  saved: 'The model was not called again: an earlier run already judged this head SHA on this base SHA.',
};

const summaryText = (result) => {
  const lines = [`### Easing classifier: ${result.escalate ? 'escalate' : 'clear'}`, ''];
  if (result.answers) {
    lines.push('| Question | Answer | Why |', '| --- | --- | --- |');
    for (const [key, question] of Object.entries(QUESTIONS)) {
      lines.push(`| ${question} | ${result.answers[key].answer} | ${cell(result.answers[key].why)} |`);
    }
  } else {
    lines.push(result.escalate || result.call === 'saved' ? NO_ANSWER[result.call] : 'The diff is empty. No model call.');
  }
  lines.push('');
  if (result.reasons.length > 0) lines.push('Why it escalated:', ...result.reasons.map((reason) => `- ${cell(reason)}`), '');
  lines.push(`Model ${cell(result.model)}, call ${result.call}: ${result.usage.inputTokens} input tokens, ${result.usage.outputTokens} output tokens, cost US$${result.costUsd.toFixed(6)}.`);
  if (result.shortened.length > 0) lines.push('', `Source files shortened to line counts: ${result.shortened.map((path) => cell(JSON.stringify(path))).join(', ')}.`);
  if (result.savedFrom) lines.push('', `Earlier run with the saved verdict: ${cell(result.savedFrom)}`);
  return lines.join('\n');
};

const dryRunText = (result) => {
  const { estimate } = result;
  return [
    `Dry run for ${result.model}. No model call made.`,
    `Would call the model: ${result.wouldCall ? 'yes' : 'no'}.`,
    ...result.reasons.map((reason) => `Escalate without a call: ${reason}.`),
    `Input: about ${estimate.inputTokens} tokens, at most ${estimate.worstInputTokens}. Output: at most ${estimate.maxOutputTokens} tokens.`,
    `Cost: about US$${estimate.costUsd.toFixed(6)}, at most US$${estimate.worstCostUsd.toFixed(6)}.`,
    `Shortened source files: ${result.shortened.length > 0 ? result.shortened.map((path) => JSON.stringify(path)).join(', ') : 'none'}.`,
    '',
    '--- system ---',
    result.request.system,
    '--- user ---',
    result.request.user,
  ].join('\n');
};

const writeResult = (result, json) => process.stdout.write(`${json ? JSON.stringify(result, null, 2) : summaryText(result)}\n`);

const main = async (argv) => {
  const args = readArgs(argv);
  const key = args.dryRun ? null : readKey();
  const config = loadConfig(args.config);
  const prompt = loadPrompt();
  const isGate = loadList(args.gateFiles, 'gate-file list');
  const isTest = loadList(args.testFiles, 'test-file list');
  const prepared = prepare(readDiff(args.diff), prompt, config, isGate, isTest);
  if (args.dryRun) {
    const result = dryRun(prepared, config);
    process.stdout.write(`${args.json ? JSON.stringify(result, null, 2) : dryRunText(result)}\n`);
    return 0;
  }
  const state = args.state ? { ...args.state, history: readHistory(args.state) } : null;
  const result = state?.history.verdict ? savedResult(state, config) : await classify(prepared, config, key, state);
  if (state && result.call === 'ok') writeOutcome(state, result.escalate);
  writeResult(result, args.json);
  return result.escalate ? 1 : 0;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`classify: ${error instanceof Failure ? error.message : error.stack}\n`);
    process.exitCode = error instanceof Failure ? error.exitCode : 1;
  },
);
