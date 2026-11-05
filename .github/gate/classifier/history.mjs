import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const WORKFLOW_FILE = 'easing-classifier.yml';
const JOB_NAME = 'classifier';
const RECORD_PREFIX = 'Record verdict ';
const RECORD_STEP = /^Record verdict (escalate|clear) for head ([0-9a-f]{40}) on base ([0-9a-f]{40})$/;
const HISTORY_FILE = 'history.json';
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PER_PAGE = 100;
const MAX_PAGES = 10;
const TIMEOUT_MS = 30_000;

const USAGE = 'usage: node .github/gate/classifier/history.mjs --repo <owner/name> --pr <n> --branch <head-ref> --sha <head-sha> --base <base-sha> --out <dir>';

class Failure extends Error {
  constructor(exitCode, message) {
    super(message);
    this.exitCode = exitCode;
  }
}

const readArgs = (argv) => {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      allowPositionals: false,
      options: {
        repo: { type: 'string' },
        pr: { type: 'string' },
        branch: { type: 'string' },
        sha: { type: 'string' },
        base: { type: 'string' },
        out: { type: 'string' },
      },
    }));
  } catch (error) {
    throw new Failure(2, `${error.message}\n${USAGE}`);
  }
  const pr = Number(values.pr);
  if (!values.repo || !REPO_PATTERN.test(values.repo)) throw new Failure(2, `--repo <owner/name> is required\n${USAGE}`);
  if (!Number.isInteger(pr) || pr <= 0) throw new Failure(2, `--pr must be a positive integer\n${USAGE}`);
  if (!values.branch) throw new Failure(2, `--branch <head-ref> is required\n${USAGE}`);
  if (!values.sha || !SHA_PATTERN.test(values.sha)) throw new Failure(2, `--sha must be a full 40-character commit SHA\n${USAGE}`);
  if (!values.base || !SHA_PATTERN.test(values.base)) throw new Failure(2, `--base must be a full 40-character commit SHA\n${USAGE}`);
  if (!values.out) throw new Failure(2, `--out <dir> is required\n${USAGE}`);
  return { repo: values.repo, pr, branch: values.branch, sha: values.sha, base: values.base, out: values.out };
};

const readToken = () => {
  const token = process.env.GITHUB_TOKEN?.trim();
  if (!token) throw new Failure(3, 'GITHUB_TOKEN is not set. The history of earlier classifier runs cannot be read.');
  return token;
};

const getJson = async (token, path) => {
  const url = `${(process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/+$/, '')}${path}`;
  let response;
  let text;
  try {
    response = await fetch(url, {
      headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new Failure(3, `${url}: ${error.cause?.message ?? error.message}`);
  }
  if (!response.ok) throw new Failure(3, `HTTP ${response.status} from ${url}: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new Failure(3, `the response from ${url} is not JSON`);
  }
};

const listAll = async (token, path, key) => {
  const items = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const data = await getJson(token, `${path}${path.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`);
    const batch = data?.[key];
    if (!Array.isArray(batch)) throw new Failure(3, `the response for ${path} has no ${key} list`);
    items.push(...batch);
    if (batch.length < PER_PAGE) return items;
  }
  throw new Failure(3, `more than ${MAX_PAGES * PER_PAGE} ${key} for ${path}, so the history cannot be read in full`);
};

const belongsToPr = (run, pr) => !Array.isArray(run.pull_requests) || run.pull_requests.length === 0 || run.pull_requests.some((item) => item?.number === pr);

const fromRepo = (run, repo) => typeof run?.head_repository?.full_name !== 'string' || run.head_repository.full_name === repo;

const recordsOf = (jobs) =>
  jobs
    .filter((job) => job?.name === JOB_NAME)
    .flatMap((job) => (Array.isArray(job.steps) ? job.steps : []))
    .filter((step) => step?.conclusion === 'success' && typeof step.name === 'string' && step.name.startsWith(RECORD_PREFIX))
    .map((step) => {
      const [, verdict, head, base] = step.name.match(RECORD_STEP) ?? [];
      return { verdict, head, base };
    });

const readHistory = async (token, args) => {
  const runsPath = `/repos/${args.repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=pull_request&branch=${encodeURIComponent(args.branch)}`;
  const runs = (await listAll(token, runsPath, 'workflow_runs')).filter((run) => fromRepo(run, args.repo) && belongsToPr(run, args.pr));
  let calls = 0;
  const verdicts = [];
  for (const run of runs) {
    if (!Number.isInteger(run?.id)) throw new Failure(3, `a run in ${runsPath} has no numeric id`);
    const records = recordsOf(await listAll(token, `/repos/${args.repo}/actions/runs/${run.id}/jobs?filter=all`, 'jobs'));
    calls += records.length;
    const from = typeof run.html_url === 'string' ? run.html_url : `run ${run.id}`;
    const same = records.filter((record) => record.verdict && run.head_sha === args.sha && record.head === args.sha && record.base === args.base);
    verdicts.push(...same.map(({ verdict }) => ({ verdict, from })));
  }
  const saved = verdicts.find((item) => item.verdict === 'escalate') ?? verdicts[0] ?? null;
  return { sha: args.sha, base: args.base, calls, verdict: saved?.verdict ?? null, from: saved?.from ?? null, runs: runs.length };
};

const writeHistory = (dir, history) => {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, HISTORY_FILE);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(history, null, 2)}\n`);
  renameSync(temporary, path);
};

const main = async (argv) => {
  const args = readArgs(argv);
  const history = await readHistory(readToken(), args);
  writeHistory(args.out, history);
  process.stdout.write(`history: ${history.runs} earlier ${WORKFLOW_FILE} runs for PR #${args.pr}, ${history.calls} model calls so far, saved verdict for head ${args.sha} on base ${args.base}: ${history.verdict ?? 'none'}\n`);
  return 0;
};

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`history: ${error instanceof Failure ? error.message : error.stack}\n`);
    process.exitCode = error instanceof Failure ? error.exitCode : 1;
  },
);
