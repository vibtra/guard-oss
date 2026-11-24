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

const PUBLIC = {
  "guard/mac/Shared/FlowRelay.swift": {
    "self.config.agentHost": "the agent's loopback address (127.0.0.1), not a destination host",
    agentLegFailure: "the agent leg's failure text in missed(): fixed words, or the NWError of a connection to the loopback agent",
  },
  "guard/mac/Shared/NativeRelayAttribution.swift": {
    "reason.rawValue": "a relay attribution reason enum",
    count: "a count",
  },
  "guard/mac/VibtraGuard/CASigner.swift": {
    "Self.socketName": "the socket's file name, ca-signer.sock, without the directory that holds the user's short name",
    "error.step": "a fixed SocketError step, such as bind or listen",
    refusal: "a CA signer refusal reason: unsigned, requirement or binding",
  },
  "guard/mac/VibtraGuard/ExtensionController.swift": {
    "failure.text": "an OSSystemExtensionError description with its domain and code (NSLog logged it public before)",
  },
  "guard/mac/VibtraGuardExtension/ExtensionState.swift": {
    source: "a documents source label: app (xpc) or app group container",
    "error.localizedDescription": "a GuardPolicyError or decoding error description",
    'bundleData != nil ? "loaded" : "kept"': "a fixed word",
    'newCatalogue != nil ? "loaded" : "kept"': "a fixed word",
  },
  "guard/mac/VibtraGuardExtension/FilterDataProvider.swift": {
    serviceId: "a catalogue service id",
    "error.localizedDescription": "the NEFilterProvider apply(settings) error description",
  },
  "guard/mac/VibtraGuardExtension/SigningIdentity.swift": {
    "GuardConstants.teamId": "Vibtra's own team id",
  },
  "guard/mac/VibtraGuardExtension/TransparentProxyProvider.swift": {
    "error.localizedDescription": "the setTunnelNetworkSettings error description",
  },
};
const PUBLIC_SIZE = Object.values(PUBLIC).reduce((size, values) => size + Object.keys(values).length, 0);
const PRIVACY = /^privacy\s*:/;
const SAFE_PRIVACY = /^privacy\s*:\s*\.(?:private|sensitive|auto)\b/;
const INTERPOLATION = /\\#*\(/g;
const RAW_LOG = /\b(NSLogv?|os_log)\s*\(/g;
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

const lineAt = (text, at) => text.slice(0, at).split("\n").length;

const privacyErrors = (file, text) => {
  const errors = [];
  for (const match of text.matchAll(INTERPOLATION)) {
    const [value, ...options] = interpolation(text, match.index + match[0].length);
    if (!options.some((option) => PRIVACY.test(option) && !SAFE_PRIVACY.test(option)) || Object.hasOwn(PUBLIC[file] ?? {}, value)) continue;
    errors.push(
      `check-mac-swift: ${file}:${lineAt(text, match.index)}: \`${value}\` is logged with privacy: .public. Hosts, signing ids and user paths are privacy: .private in the Mac app. Use privacy: .private, or, if the value is none of those, add it under ${file} in PUBLIC in ${SCRIPT} with what it is.`,
    );
  }
  for (const match of text.matchAll(RAW_LOG)) {
    errors.push(
      `check-mac-swift: ${file}:${lineAt(text, match.index)}: ${match[1]}( bypasses this check, and NSLog logs every argument public. Use Logger, with privacy: .private on hosts, signing ids and user paths.`,
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
console.log(`check-mac-swift: ${files.length} Swift files in ${MAC}: #if DEBUG selects only constants, and privacy: .public is only on the ${PUBLIC_SIZE} values PUBLIC lists for their file, and no NSLog or os_log`);
