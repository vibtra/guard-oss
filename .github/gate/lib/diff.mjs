const C_ESCAPES = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' };

const unquote = (raw) => {
  if (!raw.startsWith('"')) return raw;
  const bytes = [];
  for (const [, octal, escaped, text] of raw.slice(1, -1).matchAll(/\\([0-7]{3})|\\(.)|([^\\]+)/gs)) {
    if (octal !== undefined) bytes.push(Number.parseInt(octal, 8));
    else bytes.push(...Buffer.from(text ?? C_ESCAPES[escaped] ?? escaped));
  }
  return Buffer.from(bytes).toString('utf8');
};

const stripPrefix = (raw) => {
  if (raw === '/dev/null') return null;
  const path = unquote(raw);
  return path.replace(/^[ab]\//, '');
};

const headerPaths = (line) => {
  const rest = line.slice('diff --git '.length);
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
  if (quoted) return [stripPrefix(quoted[1]), stripPrefix(quoted[2])];
  const half = Math.floor(rest.length / 2);
  return [stripPrefix(rest.slice(0, half)), stripPrefix(rest.slice(half + 1))];
};

export const parseDiff = (text) => {
  const files = [];
  let file = null;
  let hunk = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const [oldPath, newPath] = headerPaths(line);
      file = { oldPath, newPath, status: 'modified', binary: false, hunks: [] };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) { file.status = 'added'; file.oldPath = null; continue; }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; file.newPath = null; continue; }
      if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = unquote(line.slice(12)); continue; }
      if (line.startsWith('rename to ')) { file.status = 'renamed'; file.newPath = unquote(line.slice(10)); continue; }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') { file.binary = true; continue; }
      if (line.startsWith('--- ')) { const p = stripPrefix(line.slice(4).replace(/\t.*$/, '')); if (p === null) file.oldPath = null; continue; }
      if (line.startsWith('+++ ')) { const p = stripPrefix(line.slice(4).replace(/\t.*$/, '')); if (p === null) file.newPath = null; continue; }
    }
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      hunk = { oldStart: oldLine, newStart: newLine, context: header[3].trim(), lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    const mark = line[0];
    const body = line.slice(1);
    if (mark === '+') hunk.lines.push({ type: 'add', text: body, oldLine: null, newLine: newLine++ });
    else if (mark === '-') hunk.lines.push({ type: 'del', text: body, oldLine: oldLine++, newLine: null });
    else if (mark === ' ') hunk.lines.push({ type: 'ctx', text: body, oldLine: oldLine++, newLine: newLine++ });
  }
  return files;
};

export const filePath = (file) => file.newPath ?? file.oldPath;

export const touchedPaths = (file) => [file.oldPath, file.newPath].filter((p, i, all) => p !== null && all.indexOf(p) === i);

export const addedLines = (file) => file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add'));

export const removedLines = (file) => file.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'del'));
