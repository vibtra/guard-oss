import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAC = "guard/mac";
const SKIPPED_DIRS = new Set(["build", "DerivedData", "node_modules"]);
const DIRECTIVE = /^\s*#(if|elseif|else|endif)\b(.*)$/;
const DEBUG = /\bDEBUG\b/;
const CONSTANT =
  /^\s*(?:(?:private|fileprivate|internal|public|nonisolated)\s+)*(?:static\s+)?let\s+[A-Za-z_]\w*(?:\s*:\s*[A-Za-z_][\w.]*\??)?\s*=\s*(?:true|false|nil|-?\d[\d_]*(?:\.\d[\d_]*)?|"[^"\\]*"|\.[A-Za-z_]\w*)\s*$/;
const DEBUG_FIX =
  "Debug-only CI never compiles the other branch, so code there is first compiled at release (guard-oss#81). Put only a constant behind #if DEBUG, such as `private static let checksLocation = false` under #if DEBUG and `= true` under #else, and branch on it in plain code (ExtensionController.checksLocation).";

const PUBLIC = new Map([
  ["reason.rawValue", "a relay attribution reason enum"],
  ["count", "a count"],
  ["self.config.agentHost", "the agent's loopback address (127.0.0.1), not a destination host"],
  ["why", "an agent-leg failure description"],
  ['why ?? "agent unreachable"', "an agent-leg failure description"],
  ['why ?? "closed"', "a flow close reason"],
  ["self.socketPath", "the CA signer's own socket path"],
  ["String(describing: error)", "an error description"],
  ["error.localizedDescription", "an error description"],
  ["reason", "a CA signer refusal reason: unsigned, requirement or binding"],
  ["serviceId", "a catalogue service id"],
  ["GuardConstants.teamId", "Vibtra's own team id"],
  ["source", "a documents source label: app (xpc) or app group container"],
  ['bundleData != nil ? "loaded" : "kept"', "a fixed word"],
  ['newCatalogue != nil ? "loaded" : "kept"', "a fixed word"],
]);
const SCRIPT = "scripts/check-mac-swift.mjs";

const swiftFiles = (dir) =>
  readdirSync(dir)
    .filter((name) => !name.startsWith(".") && !SKIPPED_DIRS.has(name))
    .map((name) => path.join(dir, name))
    .flatMap((file) => (statSync(file).isDirectory() ? swiftFiles(file) : file.endsWith(".swift") ? [file] : []));

const debugErrors = (file, lines) => {
  const errors = [];
  const stack = [];
  const report = (line) => {
    const frame = stack.find((each) => each.debug && !each.reported);
    if (frame === undefined) return;
    frame.reported = true;
    errors.push(`check-mac-swift: ${file}:${frame.line}: #if DEBUG holds \`${line.trim()}\`, not only constants. ${DEBUG_FIX}`);
  };
  lines.forEach((line, index) => {
    const directive = DIRECTIVE.exec(line);
    if (directive === null) {
      if (line.trim() !== "" && !CONSTANT.test(line)) report(line);
      return;
    }
    const [, keyword, condition] = directive;
    if (keyword === "if") {
      report(line);
      stack.push({ debug: DEBUG.test(condition), line: index + 1, reported: false });
    } else if (keyword === "endif") stack.pop();
    else if (keyword === "elseif" && stack.length > 0 && DEBUG.test(condition)) stack[stack.length - 1].debug = true;
  });
  return errors;
};

const interpolation = (text, start) => {
  const args = [];
  let depth = 1;
  let quoted = false;
  let from = start;
  for (let at = start; at < text.length; at += 1) {
    const char = text[at];
    if (quoted) {
      if (char === "\\") at += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return [...args, text.slice(from, at).trim()];
    } else if (char === "," && depth === 1) {
      args.push(text.slice(from, at).trim());
      from = at + 1;
    }
  }
  return [];
};

const privacyErrors = (file, text) => {
  const errors = [];
  for (let at = text.indexOf("\\("); at !== -1; at = text.indexOf("\\(", at + 2)) {
    const [value, ...options] = interpolation(text, at + 2);
    if (!options.some((option) => /^privacy:\s*\.public\b/.test(option)) || PUBLIC.has(value)) continue;
    const line = text.slice(0, at).split("\n").length;
    errors.push(
      `check-mac-swift: ${file}:${line}: \`${value}\` is logged with privacy: .public. Hosts and signing ids are privacy: .private in the Mac app. Use privacy: .private, or, if the value is neither a host nor a signing id, add it to PUBLIC in ${SCRIPT} with what it is.`,
    );
  }
  return errors;
};

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const files = swiftFiles(path.join(root, MAC));
const errors = files.flatMap((full) => {
  const file = path.relative(root, full).split(path.sep).join("/");
  const text = readFileSync(full, "utf8");
  return [...debugErrors(file, text.split("\n")), ...privacyErrors(file, text)];
});
for (const error of errors) console.error(error);
if (errors.length > 0) process.exit(1);
console.log(`check-mac-swift: ${files.length} Swift files in ${MAC}: #if DEBUG selects only constants, and privacy: .public is only on the ${PUBLIC.size} values in PUBLIC`);
