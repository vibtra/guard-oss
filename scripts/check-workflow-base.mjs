import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const ACTION = ".github/actions/pr-base/action.yml";
const BASE_READS = [/(?<![\w-])base\s*\.\s*(?:sha|ref)(?![\w-])/, /\[\s*['"]base['"]\s*\]/, /(?<![\w-])github\s*\.\s*base_ref(?![\w-])/];
const FIX = `Only ${ACTION} reads the PR's base. Add a step with \`id: base\` and \`uses: ./.github/actions/pr-base\`, then diff from \`steps.base.outputs.merge_base\` (the branch name is \`steps.base.outputs.base_ref\`). A base SHA from the event payload or the pulls API is a snapshot from when the PR was opened, pushed or retargeted, and the event's base branch is the one from before a retarget, so both go stale.`;

const yamlIn = (dir, recursive) =>
  existsSync(dir)
    ? readdirSync(dir, { recursive, withFileTypes: true })
        .filter((entry) => !entry.isDirectory() && /\.ya?ml$/.test(entry.name))
        .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    : [];

const files = [...yamlIn(path.join(root, ".github", "workflows"), false), ...yamlIn(path.join(root, ".github", "actions"), true)].sort();
const findings = files
  .filter((file) => file !== ACTION)
  .flatMap((file) =>
    readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .flatMap((line, index) => (BASE_READS.some((read) => read.test(line)) ? [`${file}:${index + 1}: ${line.trim()}`] : [])),
  );
for (const finding of findings) console.error(`workflow-base: ${finding}\n  ${FIX}`);
if (findings.length > 0) process.exit(1);
console.log(`workflow-base: of the ${files.length} workflow and action files, only ${ACTION} reads the PR's base`);
