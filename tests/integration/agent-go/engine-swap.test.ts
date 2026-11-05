import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCleanup } from "../../support/cleanup.ts";
import { contentRule, startOrigin } from "./harness.ts";
import { policyProfile, startRunning, viaTunnel, type Running, type Suite } from "./running.ts";

const run = promisify(execFile);
const AGENT_DIR = fileURLToPath(new URL("../../../guard/agent-go/", import.meta.url));
const PINEAPPLE_DIR = fileURLToPath(new URL("../../fixtures/engines/pineapple/", import.meta.url));
const MODULE = "github.com/vibtra/guard/guard/agent-go";
const RULES_LINE = "var eng engine.Engine = rules.New()";
const RULES_IMPORT = `\t"${MODULE}/engine/rules"\n`;
const TFN = contentRule("gcr_00000000000000a1", { kind: "au-tfn", requireContext: true });
const R1 = '{"messages":[{"content":"My TFN is 123 456 782"}]}';
const R2 = '{"messages":[{"content":"Pack a PINEAPPLE for lunch"}]}';

const cleanup = createCleanup();
afterAll(() => cleanup.run());

const copyAgent = async (name: string): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), `guard-engine-swap-${name}-`));
  cleanup.defer(() => rm(root, { recursive: true, force: true }));
  const tree = path.join(root, "agent-go");
  await cp(AGENT_DIR, tree, { recursive: true, filter: (source) => path.relative(AGENT_DIR, source) !== "build" });
  return tree;
};

const swapInPineapple = async (tree: string): Promise<void> => {
  await cp(PINEAPPLE_DIR, path.join(tree, "engine", "pineapple"), { recursive: true });
  const mainGo = path.join(tree, "main.go");
  const source = await readFile(mainGo, "utf8");
  expect(source.split(RULES_LINE)).toHaveLength(2);
  expect(source.split(RULES_IMPORT)).toHaveLength(2);
  await writeFile(mainGo, source.replace(RULES_LINE, "var eng engine.Engine = pineapple.New()").replace(RULES_IMPORT, `\t"${MODULE}/engine/pineapple"\n${RULES_IMPORT}`));
};

const build = async (tree: string): Promise<string> => {
  const binary = path.join(tree, "vibtra-guard");
  await run("go", ["build", "-o", binary, "."], { cwd: tree, env: process.env, timeout: 600_000 });
  return binary;
};

const goFiles = async (tree: string, dir = ""): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(path.join(tree, dir), { withFileTypes: true })) {
    const relative = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await goFiles(tree, relative)));
    else if (entry.name.endsWith(".go")) out.push(relative);
  }
  return out;
};

const proxyHashes = async (tree: string): Promise<Map<string, string>> => {
  const files = (await goFiles(tree)).filter((file) => file !== "main.go" && !file.startsWith(`engine${path.sep}`)).sort();
  return new Map(await Promise.all(files.map(async (file) => [file, createHash("sha256").update(await readFile(path.join(tree, file))).digest("hex")] as const)));
};

const changedLines = (before: string, after: string): { removed: string[]; added: string[] } => {
  const a = before.split("\n");
  const b = after.split("\n");
  return { removed: a.filter((line) => !b.includes(line)), added: b.filter((line) => !a.includes(line)) };
};

const builds: { rules?: { tree: string; binary: string }; pineapple?: { tree: string; binary: string } } = {};

beforeAll(async () => {
  const [rulesTree, pineappleTree] = await Promise.all([copyAgent("rules"), copyAgent("pineapple")]);
  await swapInPineapple(pineappleTree);
  const [rulesBinary, pineappleBinary] = await Promise.all([build(rulesTree), build(pineappleTree)]);
  builds.rules = { tree: rulesTree, binary: rulesBinary };
  builds.pineapple = { tree: pineappleTree, binary: pineappleBinary };
}, 600_000);

const suiteFor = (binary: string): Suite => ({ cleanup, binary: () => binary });

const startWith = async (binary: string, originUrl: string): Promise<Running> => {
  const suite = suiteFor(binary);
  const profile = await policyProfile(suite, { bundle: { contentRules: [TFN] } });
  return startRunning(suite, profile, { upstreamMap: { "chatgpt.com": originUrl } });
};

describe("engine-swap: the same proxy code decides with whichever engine main.go injects", () => {
  it("changes only main.go's engine line and import, and every other proxy file hashes the same", async () => {
    const rules = builds.rules;
    const pineapple = builds.pineapple;
    if (rules === undefined || pineapple === undefined) throw new Error("the engine builds did not finish");
    const a = await proxyHashes(rules.tree);
    const b = await proxyHashes(pineapple.tree);
    expect(a.size).toBeGreaterThan(20);
    expect(a.has("proxy.go")).toBe(true);
    expect(a.has("websocket_proxy.go")).toBe(true);
    expect(b).toEqual(a);
    const main = changedLines(await readFile(path.join(rules.tree, "main.go"), "utf8"), await readFile(path.join(pineapple.tree, "main.go"), "utf8"));
    expect(main).toEqual({ removed: [`\t${RULES_LINE}`], added: [`\t"${MODULE}/engine/pineapple"`, "\tvar eng engine.Engine = pineapple.New()"] });
  });

  it("blocks R1 (a TFN) only with rules and R2 (PINEAPPLE) only with the PINEAPPLE engine", async () => {
    const verdicts: Record<string, Record<string, number>> = {};
    for (const [name, built] of Object.entries(builds)) {
      if (built === undefined) throw new Error(`the ${name} build did not finish`);
      const origin = await startOrigin(cleanup);
      const agent = await startWith(built.binary, origin.url);
      verdicts[name] = {};
      for (const [label, body] of [["R1", R1], ["R2", R2]] as const) {
        const before = origin.received.length;
        const reply = await viaTunnel(agent, { method: "POST", url: "https://chatgpt.com/backend-api/conversation", headers: { "content-type": "application/json" }, body });
        if (reply.status === 403) {
          expect(reply.json().code, `${name} ${label}`).toBe("GUARD_BLOCKED");
          expect(origin.received.length, `${name} ${label} must not reach the origin`).toBe(before);
        } else {
          expect([reply.status, reply.text], `${name} ${label}`).toEqual([200, body]);
          expect(origin.received.length, `${name} ${label} must reach the origin`).toBe(before + 1);
        }
        verdicts[name][label] = reply.status;
      }
    }
    expect(verdicts).toEqual({ rules: { R1: 403, R2: 200 }, pineapple: { R1: 200, R2: 403 } });
  });
});
