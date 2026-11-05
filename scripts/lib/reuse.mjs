const unquote = (v) => {
  const s = v.trim();
  if (!/^".*"$/.test(s)) throw new Error(`REUSE.toml: expected a "string", got ${s}`);
  return JSON.parse(s);
};
const list = (v) => {
  const s = v.trim();
  if (s.startsWith("[")) {
    const inner = s.slice(1, s.lastIndexOf("]"));
    return [...inner.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  }
  return [unquote(s)];
};

/** @returns {{ version: number, annotations: Array<{ paths: string[], precedence: string, copyright: string[], licence: string }> }} */
export const parseReuseToml = (text) => {
  const annotations = [];
  let version;
  let cur;
  const lines = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) continue;
    const last = lines.at(-1);
    if (last !== undefined && last.open) {
      last.text += ` ${line}`;
      if (line.includes("]")) last.open = false;
      continue;
    }
    lines.push({ text: line, open: /=\s*\[/.test(line) && !line.includes("]") });
  }
  for (const { text: line } of lines) {
    if (line === "[[annotations]]") {
      cur = { paths: [], precedence: "closest", copyright: [], licence: "" };
      annotations.push(cur);
      continue;
    }
    const m = /^([A-Za-z-]+)\s*=\s*(.+)$/.exec(line);
    if (m === null) throw new Error(`REUSE.toml: cannot read line: ${line}`);
    const [, key, value] = m;
    if (cur === undefined) {
      if (key !== "version") throw new Error(`REUSE.toml: ${key} outside an [[annotations]] table`);
      version = Number(value);
      continue;
    }
    if (key === "path") cur.paths = list(value);
    else if (key === "precedence") cur.precedence = unquote(value);
    else if (key === "SPDX-FileCopyrightText") cur.copyright = list(value);
    else if (key === "SPDX-License-Identifier") cur.licence = unquote(value);
    else throw new Error(`REUSE.toml: unknown key ${key}`);
  }
  return { version, annotations };
};

export const globToRegExp = (glob) => {
  let re = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "\\" && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    else if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i += 1;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
};

export const resolveAnnotation = (annotations, rel) => {
  let hit;
  for (const a of annotations) if (a.paths.some((p) => globToRegExp(p).test(rel))) hit = a;
  return hit;
};

const OWN_HEADER = new RegExp(`${"SPDX-"}License-Identifier:\\s*([^\\s*]+(?:\\s+(?:AND|OR|WITH)\\s+[^\\s*]+)*)`);

export const effectiveLicence = (annotations, rel, text) => {
  const a = resolveAnnotation(annotations, rel);
  const own = OWN_HEADER.exec(text.slice(0, 800))?.[1];
  if (own !== undefined && (a === undefined || a.precedence !== "override")) return own;
  return a?.licence;
};
