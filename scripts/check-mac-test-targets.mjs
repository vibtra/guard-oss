import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED = "VibtraGuardIntegrationTests";
const XCODEPROJ = "guard/mac/VibtraGuard.xcodeproj";
const PROJECT = `${XCODEPROJ}/project.pbxproj`;
const SCHEMES = `${XCODEPROJ}/xcshareddata/xcschemes`;
const TESTS_SCHEME = `${SCHEMES}/${ALLOWED}.xcscheme`;
const SCHEME_FILE = /\.xcscheme$/iu;
const NOT_SHARED = /(^|\/)(xcuserdata|project\.xcworkspace)\//iu;
const NON_ASCII = /[^\x00-\x7F]/u;
const CONTAINER = "container:VibtraGuard.xcodeproj";
const WHERE = `${ALLOWED} is the only Mac test target. Put new Mac tests in tests/mac/ or in ${ALLOWED}.`;
const UNQUOTED = /[A-Za-z0-9_$+/:.-]+/y;
const ESCAPES = { n: "\n", t: "\t", r: "\r" };
const XML_NAME = /[A-Za-z_][A-Za-z0-9_.:-]*/y;
const XML_ENTITY = /&(#x[0-9A-Fa-f]+|#[0-9]+|lt|gt|amp|quot|apos);/g;
const XML_ENTITIES = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

const parse = (text) => {
  let at = 0;
  const fail = (what) => {
    throw new Error(`${PROJECT}: ${what} at offset ${at}`);
  };
  const skip = () => {
    for (;;) {
      while (/\s/.test(text[at] ?? "")) at += 1;
      if (text.startsWith("//", at)) {
        const end = text.indexOf("\n", at);
        at = end === -1 ? text.length : end;
      } else if (text.startsWith("/*", at)) {
        const end = text.indexOf("*/", at + 2);
        if (end === -1) fail("unclosed comment");
        at = end + 2;
      } else return;
    }
  };
  const take = (char) => {
    skip();
    if (text[at] !== char) fail(`expected "${char}"`);
    at += 1;
  };
  const value = () => {
    skip();
    if (at >= text.length) fail("unexpected end of file");
    if (text[at] === "{") {
      at += 1;
      const dict = Object.create(null);
      for (skip(); text[at] !== "}"; skip()) {
        const key = value();
        if (typeof key !== "string") fail("a key is not a string");
        if (key in dict) fail(`duplicate key ${key}`);
        take("=");
        dict[key] = value();
        take(";");
      }
      at += 1;
      return dict;
    }
    if (text[at] === "(") {
      at += 1;
      const list = [];
      for (skip(); text[at] !== ")"; skip()) {
        list.push(value());
        skip();
        if (text[at] === ",") at += 1;
        else if (text[at] !== ")") fail('expected "," or ")"');
      }
      at += 1;
      return list;
    }
    if (text[at] === '"') {
      let out = "";
      for (at += 1; text[at] !== '"'; at += 1) {
        if (at >= text.length) fail("unclosed string");
        if (text[at] === "\\") {
          at += 1;
          out += ESCAPES[text[at]] ?? text[at];
        } else out += text[at];
      }
      at += 1;
      return out;
    }
    UNQUOTED.lastIndex = at;
    const word = UNQUOTED.exec(text);
    if (word === null) fail("unexpected text");
    at = UNQUOTED.lastIndex;
    return word[0];
  };
  const root = value();
  skip();
  if (at !== text.length) fail("trailing text");
  return root;
};

const parseXml = (text, file) => {
  let at = text.startsWith("\uFEFF") ? 1 : 0;
  const fail = (what) => {
    throw new Error(`${file}: ${what} at offset ${at}`);
  };
  const space = () => {
    while (/\s/.test(text[at] ?? "")) at += 1;
  };
  const comments = () => {
    for (space(); text.startsWith("<!--", at); space()) {
      const end = text.indexOf("-->", at + 4);
      if (end === -1) fail("unclosed comment");
      at = end + 3;
    }
  };
  const name = () => {
    XML_NAME.lastIndex = at;
    const word = XML_NAME.exec(text);
    if (word === null) fail("expected a name");
    at = XML_NAME.lastIndex;
    return word[0];
  };
  const decode = (raw) => {
    if (raw.replace(XML_ENTITY, "").includes("&")) fail("unknown entity");
    return raw.replace(XML_ENTITY, (_, entity) =>
      entity.startsWith("#") ? String.fromCodePoint(Number(entity.startsWith("#x") ? `0x${entity.slice(2)}` : entity.slice(1))) : XML_ENTITIES[entity],
    );
  };
  const element = () => {
    if (text[at] !== "<") fail('expected "<"');
    at += 1;
    const tag = name();
    const attrs = Object.create(null);
    for (;;) {
      space();
      if (text.startsWith("/>", at)) {
        at += 2;
        return { tag, attrs, children: [] };
      }
      if (text[at] === ">") break;
      const key = name();
      if (key in attrs) fail(`duplicate attribute ${key}`);
      space();
      if (text[at] !== "=") fail('expected "="');
      at += 1;
      space();
      const quote = text[at];
      if (quote !== '"' && quote !== "'") fail("expected a quoted value");
      const end = text.indexOf(quote, at + 1);
      if (end === -1) fail("unclosed value");
      const raw = text.slice(at + 1, end);
      if (raw.includes("<")) fail('"<" in a value');
      attrs[key] = decode(raw);
      at = end + 1;
    }
    at += 1;
    const children = [];
    for (;;) {
      at = text.indexOf("<", at);
      if (at === -1) {
        at = text.length;
        fail("unexpected end of file");
      }
      if (text.startsWith("<!--", at)) comments();
      else if (text.startsWith("</", at)) {
        at += 2;
        if (name() !== tag) fail(`expected </${tag}>`);
        space();
        if (text[at] !== ">") fail('expected ">"');
        at += 1;
        return { tag, attrs, children };
      } else if (text.startsWith("<!", at) || text.startsWith("<?", at)) fail("unsupported markup");
      else children.push(element());
    }
  };
  if (text.startsWith("<?xml", at)) {
    const end = text.indexOf("?>", at);
    if (end === -1) fail("unclosed XML declaration");
    at = end + 2;
  }
  comments();
  if (text.startsWith("<!", at) || text.startsWith("<?", at)) fail("unsupported markup");
  const top = element();
  comments();
  if (at !== text.length) fail("trailing text");
  return top;
};

const descendants = (element) => [element, ...element.children.flatMap(descendants)];

const schemeErrors = (file, scheme) => {
  if (scheme.tag !== "Scheme") throw new Error(`${file}: the root element is ${scheme.tag}, not Scheme`);
  return descendants(scheme).flatMap((element) => {
    if (element.tag === "PreActions" || element.tag === "PostActions") {
      return [`test-locations: ${file}: the scheme has ${element.tag}, a script Xcode runs around an action. Schemes may not run scripts. ${WHERE}`];
    }
    if (element.tag === "TestPlanReference") {
      return [`test-locations: ${file}: the scheme runs the test plan ${element.attrs.reference ?? "(no reference)"}, which lists its tests outside the project. ${WHERE}`];
    }
    if (element.tag !== "TestableReference") return [];
    return element.children
      .filter((child) => child.tag === "BuildableReference")
      .map((buildable) => buildable.attrs)
      .filter((attrs) => attrs.BlueprintName !== ALLOWED || attrs.BuildableName !== `${ALLOWED}.xctest` || attrs.ReferencedContainer !== CONTAINER)
      .map(
        (attrs) =>
          `test-locations: ${file}: the scheme tests ${attrs.BlueprintName ?? "(no BlueprintName)"} (${attrs.BuildableName ?? "no BuildableName"}) in ${attrs.ReferencedContainer ?? "(no container)"}. ${WHERE}`,
      );
  });
};

const files = (dir) =>
  readdirSync(dir)
    .map((name) => path.join(dir, name))
    .flatMap((file) => (statSync(file).isDirectory() ? files(file) : [file]));

const caseless = (dir, names) =>
  names.length === 0
    ? [dir]
    : readdirSync(dir)
        .filter((name) => name.toLowerCase() === names[0].toLowerCase())
        .map((name) => path.join(dir, name))
        .filter((file) => statSync(file).isDirectory())
        .flatMap((file) => caseless(file, names.slice(1)));

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const objects = parse(readFileSync(path.join(root, PROJECT), "utf8")).objects;
if (typeof objects !== "object" || objects === null) throw new Error(`${PROJECT}: no objects`);
const targets = Object.values(objects).filter((object) => object?.isa === "PBXNativeTarget");
if (targets.length === 0) throw new Error(`${PROJECT}: no PBXNativeTarget`);
const projectFiles = caseless(root, XCODEPROJ.split("/"))
  .flatMap(files)
  .map((file) => path.relative(root, file).split(path.sep).join("/"));
const schemeFiles = projectFiles.filter((file) => SCHEME_FILE.test(file));
const schemes = schemeFiles.filter((file) => path.posix.dirname(file) === SCHEMES);
const errors = [
  ...projectFiles
    .filter((file) => NON_ASCII.test(file))
    .map((file) => `test-locations: ${file}: a path with a non-ASCII character, which macOS may read as an ASCII path. Only ASCII paths may be committed in ${XCODEPROJ}. ${WHERE}`),
  ...(schemes.includes(TESTS_SCHEME) ? [] : [`test-locations: ${TESTS_SCHEME} is missing. tests/mac/run.sh runs that shared scheme. ${WHERE}`]),
  ...schemeFiles
    .filter((file) => path.posix.dirname(file) !== SCHEMES)
    .map(
      (file) =>
        `test-locations: ${file}: ${NOT_SHARED.test(file) ? "a committed user or workspace scheme" : "a committed scheme outside the shared scheme folder"}. Only schemes directly in ${SCHEMES} may be committed. ${WHERE}`,
    ),
  ...targets
    .filter((target) => /test/i.test(String(target.productType ?? "")) && target.name !== ALLOWED)
    .map((target) => `test-locations: ${PROJECT}: target ${target.name ?? "(no name)"} has the test product type ${target.productType}. ${WHERE}`),
  ...schemes.flatMap((file) => schemeErrors(file, parseXml(readFileSync(path.join(root, file), "utf8"), file))),
].sort();
for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.log(`test-locations: ${ALLOWED} is the only test target in ${PROJECT} and the only testable in ${schemes.length} shared schemes`);
