import { readFileSync } from 'node:fs';

const escape = (ch) => (/[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch);

export const globToRegExp = (glob) => {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { out += '(?:.*/)?'; i += 2; }
      else { out += '.*'; i += 1; }
    } else if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escape(ch);
  }
  return new RegExp(`^${out}$`);
};

export const parsePatterns = (text) =>
  text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'));

export const loadPatterns = (file) => parsePatterns(readFileSync(file, 'utf8'));

export const matcher = (patterns) => {
  const compiled = patterns.map((p) => ({ pattern: p, re: globToRegExp(p) }));
  return (path) => compiled.find(({ re }) => re.test(path))?.pattern ?? null;
};
