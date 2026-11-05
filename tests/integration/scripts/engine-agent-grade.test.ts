import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../../../scripts/engine-agent-grade.mjs", import.meta.url));
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

const MAIN = [
  "package main",
  "",
  "import (",
  '\t"bufio"',
  '\t"encoding/json"',
  '\t"os"',
  "",
  '\t"example.test/agent/engine"',
  '\t"example.test/agent/engine/rules"',
  ")",
  "",
  "func main() {",
  "\tvar eng engine.Engine = rules.New()",
  '\targs := append(os.Args[1:], "", "")',
  "\tswitch {",
  '\tcase args[0] == "engine" && args[1] == "check":',
  '\tcase args[0] == "policy-scan":',
  "\t\tscanner := bufio.NewScanner(os.Stdin)",
  "\t\tfor scanner.Scan() {",
  "\t\t\tvar row map[string]any",
  "\t\t\t_ = json.Unmarshal(scanner.Bytes(), &row)",
  '\t\t\tbody, _ := row["body"].(string)',
  '\t\t\t_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"id": row["id"], "intercepted": true, "verdict": eng.Decide(body)})',
  "\t\t}",
  "\tdefault:",
  "\t\tos.Exit(1)",
  "\t}",
  "}",
  "",
].join("\n");

const BASE: Record<string, string> = {
  "guard/agent-go/go.mod": "module example.test/agent\n\ngo 1.24\n",
  "guard/agent-go/main.go": MAIN,
  "guard/agent-go/proxy.go": "package main\n",
  "guard/agent-go/engine/engine.go": "package engine\n\ntype Engine interface {\n\tDecide(body string) string\n}\n",
  "guard/agent-go/engine/rules/rules.go": 'package rules\n\ntype Engine struct{}\n\nfunc New() Engine { return Engine{} }\n\nfunc (Engine) Decide(string) string { return "allowed" }\n',
  ".golangci.yml": "run:\n  timeout: 5m\n",
  "scripts/engine-done.mjs": "export {};\n",
};

const AGENT_RESULT: Record<string, string> = {
  "guard/agent-go/engine/pineapple/pineapple.go": [
    "package pineapple",
    "",
    "import (",
    '\t"strings"',
    "",
    '\t"example.test/agent/engine/rules"',
    ")",
    "",
    "type Engine struct{}",
    "",
    "func New() Engine { return Engine{} }",
    "",
    "func (Engine) Decide(body string) string {",
    '\tif strings.Contains(body, "PINEAPPLE") {',
    '\t\treturn "blocked"',
    "\t}",
    "\treturn rules.New().Decide(body)",
    "}",
    "",
  ].join("\n"),
  "guard/agent-go/main.go": MAIN.replace('\t"example.test/agent/engine/rules"', '\t"example.test/agent/engine/pineapple"').replace("rules.New()", "pineapple.New()"),
};

const clone = async (): Promise<{ root: string; base: string }> => {
  const root = await mkdtemp(path.join(os.tmpdir(), "engine-grade-"));
  roots.push(root);
  git(root, "init", "--quiet", "--initial-branch=main");
  await write(root, BASE);
  git(root, "add", "-A");
  git(root, "commit", "--quiet", "-m", "base");
  return { root, base: git(root, "rev-parse", "HEAD") };
};

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

const grade = (root: string, base: string, timeout = 120_000) => spawnSync(process.execPath, [SCRIPT, root, "--base", base], { encoding: "utf8", timeout });

const verdictOf = (stdout: string, step: string): string | undefined => stdout.split("\n").find((line) => line.startsWith(`PASS ${step}:`) || line.startsWith(`FAIL ${step}:`));

describe("engine-agent-grade", () => {
  it("passes one new engine directory, a two-line main.go swap and an engine that blocks only PINEAPPLE", async () => {
    const { root, base } = await clone();
    await write(root, AGENT_RESULT);
    const result = grade(root, base);
    expect([result.status, result.stdout.trim().split("\n").map((line) => line.split(":")[0])], result.stdout).toEqual([
      0,
      ["PASS setup", "PASS paths", "PASS main.go", "PASS protected files", "PASS engine source", "PASS build and engine check", "PASS behaviour (policy-scan)", "engine-agent-grade"],
    ]);
    expect(verdictOf(result.stdout, "main.go")).toContain("+2 -2");
  });

  it("fails the behaviour step when the engine still lets PINEAPPLE through", async () => {
    const { root, base } = await clone();
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "behaviour (policy-scan)")).toBe("FAIL behaviour (policy-scan): the row with PINEAPPLE was allowed, not blocked");
  });

  const CHEAT = "guard/agent-go/engine/pineapple/cheat.go";
  const PKG = "example.test/agent/engine/pineapple";
  it.each([
    ["an init that exits 0 for engine check", { [CHEAT]: 'package pineapple\n\nimport "os"\n\nfunc init() {\n\tif len(os.Args) > 2 && os.Args[2] == "check" {\n\t\tos.Exit(0)\n\t}\n}\n' }, [`${PKG} imports os`]],
    ["a go:linkname through unsafe", { [CHEAT]: 'package pineapple\n\nimport _ "unsafe"\n\n//go:linkname exit os.Exit\nfunc exit(int)\n' }, [`${PKG} imports unsafe`]],
    ["a package-level reader of the process arguments", { [CHEAT]: 'package pineapple\n\nimport "flag"\n\nvar checking = flag.Arg(1) == "check"\n' }, [`${PKG} imports flag`]],
    ["expvar's cmdline, used to fall back to rules under engine check", { [CHEAT]: 'package pineapple\n\nimport (\n\t"expvar"\n\t"strings"\n)\n\nvar checking = strings.Contains(expvar.Get("cmdline").String(), `"check"`)\n' }, [`${PKG} imports expvar`]],
    ["io/ioutil reading /proc/self/cmdline", { [CHEAT]: 'package pineapple\n\nimport (\n\t"bytes"\n\t"io/ioutil"\n)\n\nvar raw, _ = ioutil.ReadFile("/proc/self/cmdline")\n\nvar checking = bytes.Contains(raw, []byte("check"))\n' }, [`${PKG} imports io/ioutil`]],
    ["fmt, which can read stdin", { [CHEAT]: 'package pineapple\n\nimport "fmt"\n\nvar label = fmt.Sprint("x")\n' }, [`${PKG} imports fmt`]],
    [
      "a probe hidden in testdata/, which go list ./... skips",
      {
        [CHEAT]: `package pineapple\n\nimport "${PKG}/testdata/probe"\n\nvar checking = probe.Checking\n`,
        "guard/agent-go/engine/pineapple/testdata/probe/probe.go": 'package probe\n\nimport "os"\n\nvar Checking = len(os.Args) > 2 && os.Args[2] == "check"\n',
      },
      [`${PKG}/testdata/probe imports os`],
    ],
    [
      "a probe hidden in an underscore directory",
      {
        [CHEAT]: `package pineapple\n\nimport "${PKG}/_probe"\n\nvar checking = probe.Checking\n`,
        "guard/agent-go/engine/pineapple/_probe/probe.go": 'package probe\n\nimport "flag"\n\nvar Checking = flag.Arg(1) == "check"\n',
      },
      [`${PKG}/_probe imports flag`],
    ],
    ["a regular assembly file", { "guard/agent-go/engine/pineapple/cheat_amd64.S": "TEXT ·cheat(SB),$0\n\tRET\n" }, ["guard/agent-go/engine/pineapple/cheat_amd64.S: only regular .go and .md files"]],
  ] as const)("fails the engine source step on %s, even though the path steps pass", async (_name, cheat, expected) => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, ...cheat });
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "engine source"), result.stdout).toMatch(/^FAIL /);
    for (const hit of expected) expect(result.stdout).toContain(hit);
    for (const step of ["paths", "main.go", "protected files"]) expect(verdictOf(result.stdout, step)).toMatch(/^PASS /);
  });

  it("fails the engine source step on a symlinked .s file, which go build would compile", async () => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, "guard/agent-go/engine/pineapple/exit.go": "package pineapple\n" });
    await symlink("exit.go", path.join(root, "guard/agent-go/engine/pineapple/exit_amd64.s"));
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "engine source"), result.stdout).toMatch(/^FAIL /);
    expect(result.stdout).toContain("guard/agent-go/engine/pineapple/exit_amd64.s: only regular .go and .md files");
    expect(result.stdout).not.toContain("guard/agent-go/engine/pineapple/exit.go: only");
  });

  it("accepts the real signed profile in the real policy-scan: an unmodified clone has both rows intercepted and PINEAPPLE allowed", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "engine-grade-real-"));
    roots.push(root);
    const cloned = spawnSync("git", ["clone", "--quiet", "--depth", "1", `file://${REPO}`, path.join(root, "repo")], { encoding: "utf8" });
    expect(cloned.status, cloned.stderr).toBe(0);
    const repo = path.join(root, "repo");
    const result = grade(repo, git(repo, "rev-parse", "HEAD"), 600_000);
    expect(verdictOf(result.stdout, "behaviour (policy-scan)"), result.stdout).toBe("FAIL behaviour (policy-scan): the row with PINEAPPLE was allowed, not blocked");
  }, 900_000);

  it("rejects a path outside the new engine directory and main.go, tracked or untracked", async () => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, "README.md": "notes\n" });
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "paths")).toMatch(/^FAIL /);
    expect(result.stdout).toMatch(/^README\.md$/m);
  });

  it("rejects a second new engine directory", async () => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, "guard/agent-go/engine/mango/mango.go": "package mango\n" });
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "paths")).toMatch(/^FAIL .*more than one new engine directory: mango, pineapple$/);
  });

  it("rejects a main.go change bigger than the constructor line and its import", async () => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, "guard/agent-go/main.go": `${AGENT_RESULT["guard/agent-go/main.go"]?.replace("\t\tos.Exit(1)", "\t\tos.Exit(2)")}` });
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "main.go")).toContain("changed by +3 -3; at most +2 -2");
  });

  it("rejects an edit under engine/rules, even with an otherwise clean swap", async () => {
    const { root, base } = await clone();
    const rules = path.join(root, "guard/agent-go/engine/rules/rules.go");
    await write(root, AGENT_RESULT);
    await writeFile(rules, `${await readFile(rules, "utf8")}\nfunc Faster() {}\n`);
    const result = grade(root, base);
    expect(result.status).toBe(1);
    expect(verdictOf(result.stdout, "protected files")).toMatch(/^FAIL /);
    expect(result.stdout).toContain("guard/agent-go/engine/rules/rules.go (guard/agent-go/engine/rules/)");
  });

  it("rejects edits to the proxy, .golangci.yml and scripts/ as protected files", async () => {
    const { root, base } = await clone();
    await write(root, { ...AGENT_RESULT, "guard/agent-go/proxy.go": "package main\n\nvar x = 1\n", ".golangci.yml": "run:\n  timeout: 1m\n", "scripts/engine-done.mjs": "process.exit(0);\n" });
    const result = grade(root, base);
    expect(result.status).toBe(1);
    for (const hit of ["guard/agent-go/proxy.go (the proxy files)", ".golangci.yml (.golangci.yml)", "scripts/engine-done.mjs (scripts/)"]) expect(result.stdout).toContain(hit);
  });

  it("exits 2 with usage when the base is missing", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "."], { encoding: "utf8" });
    expect([result.status, result.stderr.trim()]).toEqual([2, "usage: node scripts/engine-agent-grade.mjs <clone> --base <sha>"]);
  });
});
