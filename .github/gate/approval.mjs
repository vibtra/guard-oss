import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadApprovers } from './lib/approvers.mjs';

const USAGE = 'usage: node .github/gate/approval.mjs --repo <owner/name> --pr <n> --sha <head-sha> [--approvers <file>]';
const STATES = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const PAGE = 100;

const options = {
  repo: { type: 'string' },
  pr: { type: 'string' },
  sha: { type: 'string' },
  approvers: { type: 'string', default: fileURLToPath(new URL('../gate-approvers.txt', import.meta.url)) },
};

const getJson = async (url, token) => {
  const response = await fetch(url, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'vibtra-guard-gate',
      'x-github-api-version': '2022-11-28',
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${response.status}`);
  return response.json();
};

const allReviews = async (url, token) => {
  const reviews = [];
  for (let page = 1; ; page++) {
    const batch = await getJson(`${url}/reviews?per_page=${PAGE}&page=${page}`, token);
    if (!Array.isArray(batch)) throw new Error(`GET ${url}/reviews: not a list`);
    reviews.push(...batch);
    if (batch.length < PAGE) return reviews;
  }
};

const main = async () => {
  const { repo, pr, sha, approvers } = parseArgs({ options }).values;
  if (!/^[\w-]+\/[\w.-]+$/.test(repo ?? '') || !/^[1-9]\d*$/.test(pr ?? '') || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(sha ?? '')) {
    throw new Error(USAGE);
  }
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is not set');
  const logins = loadApprovers(approvers);
  const api = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
  const url = `${api}/repos/${repo}/pulls/${pr}`;
  const author = (await getJson(url, token))?.user?.login;
  if (typeof author !== 'string') throw new Error(`GET ${url}: no author login`);
  const latest = new Map();
  for (const review of await allReviews(url, token)) {
    const login = review?.user?.login;
    if (typeof login === 'string' && STATES.has(review.state)) latest.set(login.toLowerCase(), review);
  }
  console.log(`head ${sha}, author ${author}`);
  let approvedBy = null;
  for (const login of logins) {
    const review = latest.get(login.toLowerCase());
    const isAuthor = login.toLowerCase() === author.toLowerCase();
    console.log(`${login}: ${review ? `${review.state} on ${review.commit_id}` : 'no review'}${isAuthor ? ' (author, not counted)' : ''}`);
    if (!isAuthor && review?.state === 'APPROVED' && review.commit_id === sha) approvedBy ??= login;
  }
  console.log(approvedBy ? `approved on the head SHA by ${approvedBy}` : 'no approval on the head SHA from an approver who is not the author');
  return approvedBy ? 0 : 1;
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error.code?.startsWith('ERR_PARSE_ARGS') ? `${error.message}\n${USAGE}` : error.message);
    process.exitCode = 2;
  },
);
