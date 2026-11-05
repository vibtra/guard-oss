import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const misplaced = readdirSync(path.join(root, "guard", "agent-go"), { recursive: true, withFileTypes: true })
  .filter((entry) => !entry.isDirectory() && entry.name.endsWith("_test.go"))
  .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
  .sort();
for (const file of misplaced) {
  console.error(`test-locations: ${file} is a Go test file under guard/agent-go. Put agent-go tests in tests/integration/agent-go/ as vitest tests that drive the real agent binary.`);
}
if (misplaced.length > 0) process.exit(1);
console.log("test-locations: no *_test.go file under guard/agent-go");
