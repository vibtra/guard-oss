import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/engine-done.mjs", import.meta.url));
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = (root: string, ...args: string[]): string => {
  const result = spawnSync("git", ["-C", root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
};

const write = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
};

const commit = async (root: string, files: Readonly<Record<string, string>>, message: string): Promise<string> => {
  await write(root, files);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(root, "rev-parse", "HEAD");
};

const repo = async (files: Readonly<Record<string, string>>): Promise<{ root: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-done-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  const base = await commit(root, files, "base");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  return { root };
};

const engineDone = (root: string, ...args: string[]) => spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8", timeout: 240_000 });

const withStubLint = async (root: string, output: string, code: number) => {
  const bin = await mkdtemp(path.join(os.tmpdir(), "engine-done-lint-"));
  roots.push(bin);
  const stub = path.join(bin, "golangci-lint");
  await writeFile(stub, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "golangci-lint stub"; exit 0; fi\ntest -f proxy_violation.go || { echo "stub: no planted proxy_violation.go in $PWD"; exit 7; }\ncat <<'OUT'\n${output}\nOUT\nexit ${code}\n`);
  await chmod(stub, 0o755);
  return spawnSync(process.execPath, [SCRIPT, "--root", root, "--only", "2b"], { encoding: "utf8", timeout: 120_000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } });
};

const stepLines = (stdout: string): string[] => stdout.split("\n").filter((line) => /^(PASS|FAIL) /.test(line));

const verdictOf = (stdout: string, id: string): string | undefined => stepLines(stdout).find((line) => line.split(" ")[1] === id);

const TODAY: Record<string, string> = {
  "guard/agent-go/go.mod": "module example.test/agent\n\ngo 1.24\n",
  "guard/agent-go/main.go": "package main\n\nfunc main() {}\n",
  "CONTRIBUTING.md": "# Contributing\n\nRun the tests.\n",
  "tests/integration/agent-go/proxy-http.test.ts": "export {};\n",
};

const TOY_ENGINE = (pkg: string, name: string, check: number): string =>
  `package ${pkg}\n\ntype Engine struct{}\n\nfunc New() Engine { return Engine{} }\n\nfunc (Engine) Name() string { return "${name}" }\n\nfunc (Engine) Check() int { return ${check} }\n`;

const plannedMain = (bench: Readonly<Record<string, readonly number[]>> = { detectors: [250, 250, 250, 250, 250] }): string =>
  [
    "package main",
    "",
    "import (",
    '\t"fmt"',
    '\t"os"',
    '\t"path/filepath"',
    "",
    '\t"example.test/agent/engine"',
    '\t"example.test/agent/engine/rules"',
    ")",
    "",
    `var benchSets = []struct {\n\tname string\n\tns   []int\n}{${Object.entries(bench)
      .map(([name, ns]) => `{"${name}", []int{${ns.join(", ")}}}`)
      .join(", ")}}`,
    "",
    "func main() {",
    "\tvar eng engine.Engine = rules.New()",
    '\targs := append(os.Args[1:], "", "")',
    "\tswitch {",
    '\tcase args[0] == "--version":',
    '\t\tfmt.Println("engine: " + eng.Name())',
    '\tcase args[0] == "status":',
    '\t\tfmt.Printf("{\\n  \\"engine\\": %q\\n}\\n", eng.Name())',
    '\tcase args[0] == "engine" && args[1] == "check":',
    "\t\tos.Exit(eng.Check())",
    '\tcase args[0] == "engine" && args[1] == "bench":',
    '\t\tcounter := filepath.Join(os.Getenv("VIBTRA_GUARD_DIR"), "bench-runs")',
    "\t\tseen, _ := os.ReadFile(counter)",
    "\t\t_ = os.WriteFile(counter, append(seen, 'x'), 0o600)",
    "\t\tfor _, set := range benchSets {",
    '\t\t\tfmt.Printf("%s\\t1000\\t%d ns/op\\t0 B/op\\t0 allocs/op\\n", set.name, set.ns[len(seen)%len(set.ns)])',
    "\t\t}",
    "\t}",
    "}",
    "",
  ].join("\n");

const PLANNED: Record<string, string> = {
  ...TODAY,
  "guard/agent-go/main.go": plannedMain(),
  "guard/agent-go/engine/engine.go": "package engine\n\ntype Engine interface {\n\tName() string\n\tCheck() int\n}\n",
  "guard/agent-go/engine/rules/rules.go": TOY_ENGINE("rules", "rules", 0),
  "guard/agent-go/engine/example/example.go": TOY_ENGINE("example", "example", 0),
  "guard/agent-go/engine/README.md": "# Engines\n\n```sh\ntest -f guard/agent-go/main.go\n```\n\n```text\nnot a command\n```\n",
  "tests/fixtures/engines/blocks-in-monitor/engine.go": TOY_ENGINE("blocksinmonitor", "blocks-in-monitor", 1),
  "tests/fixtures/engines/body-in-event/engine.go": TOY_ENGINE("bodyinevent", "body-in-event", 1),
  "CONTRIBUTING.md": "# Contributing\n\n## Engines\n\n```sh\ntrue\n```\n\n## Other\n\n```sh\nexit 1\n```\n",
  "AGENTS.md": "# Agents\n\n```sh\ntest -f CONTRIBUTING.md\n```\n",
};

describe("engine-done", () => {
  it("passes no-swift on today's tree and fails every other step as not built yet", async () => {
    const { root } = await repo(TODAY);
    const result = engineDone(root);
    expect(result.status).toBe(1);
    const lines = stepLines(result.stdout);
    expect(lines.map((line) => line.split(" ").slice(0, 2).join(" "))).toEqual(["PASS no-swift", "FAIL 2a", "FAIL 2b", "FAIL 3", "FAIL 4", "FAIL 5", "FAIL 7"]);
    for (const line of lines.filter((line) => line.startsWith("FAIL"))) expect(line).toContain("not built yet");
  });

  it("passes every step but the lint plant on a toy tree that uses the planned names", async () => {
    const { root } = await repo(PLANNED);
    const result = engineDone(root);
    expect(result.status).toBe(1);
    for (const id of ["no-swift", "2a", "3", "4", "5", "7"]) expect(verdictOf(result.stdout, id), result.stdout).toMatch(/^PASS /);
    expect(verdictOf(result.stdout, "2b")).toMatch(/^FAIL /);
  }, 240_000);

  it("fails step 2a on a proxy file that imports rules, and step 3 on a monitor-safe fixture engine", async () => {
    const { root } = await repo(PLANNED);
    await commit(
      root,
      {
        "tests/fixtures/engines/blocks-in-monitor/engine.go": TOY_ENGINE("blocksinmonitor", "blocks-in-monitor", 0),
        "guard/agent-go/proxy.go": 'package main\n\nimport _ "example.test/agent/engine/rules"\n',
      },
      "break the boundary",
    );
    const result = engineDone(root);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "2a")).toMatch(/^FAIL /);
    expect(result.stdout).toMatch(/^proxy\.go$/m);
    expect(verdictOf(result.stdout, "3")).toMatch(/^FAIL .*blocks-in-monitor: `engine check` exited 0, expected 1/);
  }, 240_000);
});

describe("engine-done step 4 (bench spread)", () => {
  it("passes noisy runs whose median stays within 35% of the fastest run, and names the limit and run count", async () => {
    const { root } = await repo({ ...PLANNED, "guard/agent-go/main.go": plannedMain({ views: [100, 104, 96, 135, 101] }) });
    const result = engineDone(root, "--only", "4");
    expect(result.status, result.stdout).toBe(0);
    expect(verdictOf(result.stdout, "4")).toBe("PASS 4 engine bench on rules: (median - min) / min within 35% over 5 runs: views 5.2%");
  });

  it("fails a set whose median is twice its fastest run, and names only that set", async () => {
    const { root } = await repo({ ...PLANNED, "guard/agent-go/main.go": plannedMain({ views: [100, 104, 96, 135, 101], context: [100, 102, 200, 205, 210] }) });
    const result = engineDone(root, "--only", "4");
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "4")).toBe("FAIL 4 engine bench on rules: (median - min) / min within 35% over 5 runs: context: (median - min) / min is 100.0%, over 35% (100, 102, 200, 205, 210 ns/op)");
    expect(result.stdout).not.toContain("views: (median - min)");
  });
});

describe("engine-done step 2b (planted violation)", () => {
  it.each([
    ["lint passes the planted file", "", 0, /^FAIL 2b .*golangci-lint passed a proxy file that imports engine\/rules/],
    ["lint fails for another reason", "main.go:1:1: Error return value is not checked (errcheck)", 1, /^FAIL 2b .*not with a depguard finding on proxy_violation\.go/],
    ["lint fails with a depguard finding on the planted file", "proxy_violation.go:3:8: import 'example.test/agent/engine/rules' is not allowed from list 'proxy-rules': only main.go (depguard)", 1, /^PASS 2b .*lint rejects the planted import: proxy_violation\.go:3:8/],
  ])("%s", async (_name, output, code, expected) => {
    const { root } = await repo(PLANNED);
    const result = await withStubLint(root, output, code);
    expect(stepLines(result.stdout), result.stdout).toEqual([expect.stringMatching(expected)]);
    expect(result.status).toBe(expected.source.startsWith("^PASS") ? 0 : 1);
  });
});

describe("engine-done step 7 (docs)", () => {
  it("rejects a bash fence indented inside a list", async () => {
    const { root } = await repo({ ...PLANNED, "AGENTS.md": "# Agents\n\n```sh\ntrue\n```\n\n1. Build:\n\n   ```bash\n   true\n   ```\n" });
    const result = engineDone(root, "--only", "7");
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "7")).toContain('AGENTS.md: 1 code block(s) tagged "bash"');
  });

  it("rejects a bash fence inside a blockquote", async () => {
    const { root } = await repo({ ...PLANNED, "AGENTS.md": "# Agents\n\n```sh\ntrue\n```\n\n> Note:\n>\n> ```bash\n> true\n> ```\n" });
    const result = engineDone(root, "--only", "7");
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "7")).toContain('AGENTS.md: 1 code block(s) tagged "bash"');
  });

  it.each([
    ["a tilde fence", "~~~sh\nexit 3\n~~~\n", 3],
    ["a fence inside a blockquote", "> ```sh\n> exit 5\n> ```\n", 5],
    ["a fence indented inside a list", "- Check:\n\n  ```sh\n  exit 4\n  ```\n", 4],
  ])("runs the sh command in %s", async (_name, block, code) => {
    const { root } = await repo({ ...PLANNED, "AGENTS.md": `# Agents\n\n${block}` });
    const result = engineDone(root, "--only", "7");
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "7")).toContain(`AGENTS.md: this sh block exited ${code} when run from the clone root`);
    expect(result.stdout).toMatch(new RegExp(`^exit ${code}$`, "m"));
  });
});

describe("engine-done --only no-swift", () => {
  it.each(["guard/mac/Shared/GuardModel.swift", "apps/other/View.swift", "apps/other/View.SWIFT", "tests/mac/run.sh", "guard/mac/VibtraGuard.xcodeproj/project.pbxproj", "tools/Some.xcodeproj/x", "apps/project.yml"])("fails on %s and prints every changed name", async (file) => {
    const { root } = await repo(TODAY);
    await commit(root, { [file]: "changed\n", "README.md": "changed\n" }, "touch the mac side");
    const result = engineDone(root, "--only", "no-swift");
    expect(result.status).toBe(1);
    expect(stepLines(result.stdout)).toEqual([expect.stringMatching(/^FAIL no-swift /)]);
    expect(result.stdout).toContain(`  ${file}`);
    expect(result.stdout).toContain("  README.md");
  });

  it("passes a branch with no Swift or Mac path and still prints every changed name", async () => {
    const { root } = await repo(TODAY);
    await commit(root, { "README.md": "changed\n", "guard/agent-go/project.go": "package main\n" }, "clean change");
    const result = engineDone(root, "--only", "no-swift");
    expect(result.status).toBe(0);
    expect(stepLines(result.stdout)).toEqual([expect.stringMatching(/^PASS no-swift /)]);
    expect(result.stdout).toContain("(2):\n  README.md\n  guard/agent-go/project.go");
  });

  it("rejects an unknown step name", async () => {
    const { root } = await repo(TODAY);
    const result = engineDone(root, "--only", "nope");
    expect([result.status, result.stderr]).toEqual([2, expect.stringContaining('unknown step "nope"')]);
  });
});
