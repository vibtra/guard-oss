import { readFileSync } from 'node:fs';
import { parsePatterns } from './patterns.mjs';

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

export const loadApprovers = (file) => {
  const logins = parsePatterns(readFileSync(file, 'utf8'));
  const bad = logins.find((login) => !LOGIN.test(login));
  if (bad !== undefined) throw new Error(`${file}: not a GitHub login: ${bad}`);
  if (logins.length === 0) throw new Error(`${file}: no approver login`);
  return logins;
};
