import { execFile } from "node:child_process";
import { cp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it } from "vitest";
import { bundleDocument, catalogueDocument, contentRule, createProfile, createSigner, jsonLines, jsonObject, runAgentCommand, startOrigin, tempDir, type Json } from "./harness.ts";
import { activityRows, local, policyProfile, queuedEvents, record, startRunning, useAgentSuite, viaProxy } from "./running.ts";

const run = promisify(execFile);
const AGENT_DIR = fileURLToPath(new URL("../../../guard/agent-go/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../fixtures/engines/", import.meta.url));
const MODULE = "github.com/vibtra/guard/guard/agent-go";
const RULES_LINE = "var eng engine.Engine = rules.New()";
const RULES_IMPORT = `\t"${MODULE}/engine/rules"\n`;
const INVARIANTS = ["monitor-never-blocks", "coverage-failure-never-allowed", "missing-capability-never-allowed", "surface-blocks", "valid-decision", "exceptions", "deterministic", "no-content"];
const VECTOR_SETS = ["identifiers", "context", "views", "secrets", "bulk", "body", "compiled"];
const BROKEN: Readonly<Record<string, readonly string[]>> = {
  "blocks-in-monitor": ["monitor-never-blocks", "missing-capability-never-allowed", "surface-blocks"],
  "body-in-event": ["missing-capability-never-allowed", "no-content"],
  pineapple: ["coverage-failure-never-allowed", "missing-capability-never-allowed", "surface-blocks"],
  "never-enforces": ["coverage-failure-never-allowed", "missing-capability-never-allowed", "surface-blocks"],
  "invalid-decision": ["missing-capability-never-allowed", "valid-decision"],
};

const suite = useAgentSuite();
const broken = new Map<string, string>();

const engineCommand = async (binary: string, args: readonly string[]) => {
  const dir = await tempDir(suite.cleanup, "engine");
  return runAgentCommand(binary, ["engine", ...args], { dataDir: path.join(dir, "profile"), timeoutMs: 300_000 });
};

const buildWithFixture = async (name: string): Promise<string> => {
  const tree = path.join(await tempDir(suite.cleanup, `engine-${name}`), "agent-go");
  await cp(AGENT_DIR, tree, { recursive: true, filter: (source) => path.relative(AGENT_DIR, source) !== "build" });
  await cp(path.join(FIXTURES, name), path.join(tree, "engine", name), { recursive: true });
  const mainGo = path.join(tree, "main.go");
  const source = await readFile(mainGo, "utf8");
  expect(source.split(RULES_LINE)).toHaveLength(2);
  expect(source.split(RULES_IMPORT)).toHaveLength(2);
  await writeFile(mainGo, source.replace(RULES_LINE, "var eng engine.Engine = swapped.New()").replace(RULES_IMPORT, `\tswapped "${MODULE}/engine/${name}"\n${RULES_IMPORT}`));
  const binary = path.join(tree, "vibtra-guard");
  await run("go", ["build", "-o", binary, "."], { cwd: tree, env: process.env, timeout: 600_000 });
  return binary;
};

const statusLines = (stdout: string): Map<string, string> =>
  new Map(
    stdout.split("\n").flatMap((line): [string, string][] => {
      const match = /^(ok|FAIL)\s+(\S+) \(\d+ cases\)$/.exec(line);
      return match?.[1] === undefined || match[2] === undefined ? [] : [[match[2], match[1]]];
    }),
  );

beforeAll(async () => {
  await Promise.all(Object.keys(BROKEN).map(async (name) => broken.set(name, await buildWithFixture(name))));
}, 600_000);

describe("engine check runs the conformance checks on the engine main.go wires in", () => {
  it("passes the invariants on rules, and the shared rules vectors with --parity", async () => {
    const plain = await engineCommand(suite.binary(), ["check"]);
    expect([plain.code, plain.stderr]).toEqual([0, ""]);
    expect(plain.stdout).toContain("engine: rules");
    expect(Object.fromEntries(statusLines(plain.stdout))).toEqual(Object.fromEntries(INVARIANTS.map((name) => [name, "ok"])));

    const parity = await engineCommand(suite.binary(), ["check", "--parity"]);
    expect([parity.code, parity.stderr], parity.stdout).toEqual([0, ""]);
    expect(Object.fromEntries(statusLines(parity.stdout))).toEqual(Object.fromEntries([...INVARIANTS, ...VECTOR_SETS.map((set) => `parity/${set}`)].map((name) => [name, "ok"])));
  }, 300_000);

  it("refuses an --engine value that is not the wired-in engine, on every command", async () => {
    for (const args of [["--version"], ["engine", "check"], ["run", "--proxy", "127.0.0.1:0", "--local", "127.0.0.1:0"]]) {
      const result = await runAgentCommand(suite.binary(), [...args, "--engine", "alcatraz"], { dataDir: await tempDir(suite.cleanup, "engine-flag") });
      expect([result.code, result.stdout], args.join(" ")).toEqual([1, ""]);
      expect(result.stderr).toContain('--engine takes rules, not "alcatraz"');
    }
    const named = await runAgentCommand(suite.binary(), ["--version", "--engine", "rules"], { dataDir: await tempDir(suite.cleanup, "engine-flag") });
    expect([named.code, named.stdout]).toEqual([0, "vibtra-guard (Go/client-hello replay)\nengine: rules\n"]);
  });

  it("runs rules with no model state", async () => {
    const agent = await startRunning(suite, await policyProfile(suite));
    const status = (await local(agent, "/status")).json();
    expect([status.engine, status.model]).toEqual(["rules", undefined]);
  });

  it("refuses a vectors directory that does not hold the shared vectors", async () => {
    const dir = await tempDir(suite.cleanup, "no-vectors");
    const result = await engineCommand(suite.binary(), ["check", "--parity", "--vectors", dir]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("detectors.vectors.json");
  });

  it("reads --parity=false as off, and refuses --vectors without --parity and a --parity value it does not know", async () => {
    const off = await engineCommand(suite.binary(), ["check", "--parity=false"]);
    expect([off.code, off.stderr]).toEqual([0, ""]);
    expect([...statusLines(off.stdout).keys()]).toEqual(INVARIANTS);
    const dir = await tempDir(suite.cleanup, "unused-vectors");
    const vectorsAlone = await engineCommand(suite.binary(), ["check", "--vectors", dir]);
    expect([vectorsAlone.code, vectorsAlone.stdout]).toEqual([1, ""]);
    expect(vectorsAlone.stderr).toContain("--vectors DIR is only used with --parity");
    const unknown = await engineCommand(suite.binary(), ["check", "--parity=yes"]);
    expect([unknown.code, unknown.stdout]).toEqual([1, ""]);
    expect(unknown.stderr).toContain("--parity takes no value");
  });

  it.each(Object.entries(BROKEN))("exits 1 on the %s fixture and fails exactly %j", async (name, failing) => {
    const binary = broken.get(name);
    if (binary === undefined) throw new Error(`the ${name} build did not finish`);
    const result = await engineCommand(binary, ["check"]);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stdout).toContain(`engine: ${name}`);
    expect(result.stderr).toContain("engine check failed");
    expect(Object.fromEntries(statusLines(result.stdout))).toEqual(Object.fromEntries(INVARIANTS.map((invariant) => [invariant, failing.includes(invariant) ? "FAIL" : "ok"])));
  }, 300_000);
});

describe("rules blocks a rule whose detector kind the running engine cannot run", () => {
  const signer = createSigner();
  const MISSING = contentRule("gcr_00000000000000c1", { kind: "detector-from-the-future" });

  const decide = async (changes: Json): Promise<Json> => {
    const dir = await tempDir(suite.cleanup, "capability");
    const file = path.join(dir, "bundle.json");
    await writeFile(file, JSON.stringify(bundleDocument(signer, changes)));
    const result = await runAgentCommand(suite.binary(), ["test", "--bundle", file, "--host", "chatgpt.com", "--text", "hello there"], { dataDir: path.join(dir, "profile") });
    expect([result.code, result.stderr]).toEqual([0, ""]);
    return jsonObject(result.stdout);
  };
  const matches = (verdict: Json): Json[] => {
    const list = record(verdict.content).matches;
    if (!Array.isArray(list)) throw new Error("the decision has no content matches");
    return list.map(record);
  };

  it("blocks under enforce and records the would-block under monitor, with Unavailable engine-capability", async () => {
    for (const [clientMode, enforced] of [["enforce", true], ["monitor", false]] as const) {
      const verdict = await decide({ clientMode, contentRules: [MISSING] });
      expect([verdict.verdict, verdict.enforced], clientMode).toEqual(["blocked", enforced]);
      expect(record(verdict.content).action).toBe("block");
      const [hit] = matches(verdict);
      expect(record(hit?.rule).ruleId).toBe(MISSING.ruleId);
      expect([hit?.unavailable, hit?.excepted]).toEqual(["engine-capability", false]);
    }
  });

  it("blocks an ask rule too, changes nothing for an allow rule, and honours a live exception", async () => {
    expect((await decide({ contentRules: [{ ...MISSING, action: "ask" }] })).verdict).toBe("blocked");
    const allow = await decide({ contentRules: [{ ...MISSING, action: "allow" }] });
    expect([allow.verdict, matches(allow)]).toEqual(["allowed", []]);
    const excepted = await decide({ contentRules: [MISSING], exceptions: [{ grantId: "grant_capability", serviceId: "openai-chatgpt", ruleId: MISSING.ruleId, scope: "user" }] });
    expect(excepted.verdict).toBe("allowed");
    expect(matches(excepted).map((hit) => [hit.unavailable, hit.excepted, hit.grantId])).toEqual([["engine-capability", true, "grant_capability"]]);
  });

  it("accepts a signed bundle with the unknown kind and blocks on it, instead of rejecting the whole bundle", async () => {
    const profile = await createProfile(suite.cleanup, {
      signer,
      bundle: bundleDocument(signer, { catalogueVersion: "v1", contentRules: [{ ...MISSING, action: "ask" }] }),
      catalogue: catalogueDocument({ version: "v1", services: [{ serviceId: "chat", name: "Chat", vendor: "Example", category: "chat", domains: ["chatgpt.com"], bundleIds: [], cliNames: [], custom: true }] }),
    });
    const row = { id: "hello", host: "chatgpt.com", contentType: "application/json", body: '{"prompt":"hello there"}' };
    const result = await runAgentCommand(suite.binary(), ["policy-scan"], { dataDir: profile.dataDir, input: `${JSON.stringify(row)}\n` });
    expect([result.code, result.stderr]).toEqual([0, ""]);
    const [scanned] = jsonLines(result.stdout);
    expect([scanned?.verdict, scanned?.enforced]).toEqual(["blocked", true]);
    expect(scanned?.matches).toEqual([{ ruleId: MISSING.ruleId, kind: "detector-from-the-future", count: 0, action: "block", excepted: false, unavailable: "engine-capability" }]);
  });

  it("stops the request at the proxy and records the event with reason engine-capability", async () => {
    const origin = await startOrigin(suite.cleanup, (_request, response) => response.writeHead(200).end());
    const profile = await policyProfile(suite, { bundle: { contentRules: [MISSING] } });
    const agent = await startRunning(suite, profile, { upstreamMap: { "chatgpt.com": origin.url } });
    const reply = await viaProxy(agent, { method: "POST", url: "http://chatgpt.com/backend-api/codex/responses", headers: { "content-type": "application/json" }, body: '{"input":"hello there"}' });
    expect([reply.status, origin.received.length]).toEqual([403, 0]);
    const [latest] = await activityRows(agent);
    expect([latest?.action, latest?.ruleId, latest?.reason]).toEqual(["blocked", MISSING.ruleId, "engine-capability"]);
    const queued = (await queuedEvents(profile.dataDir)).filter((event) => event.ruleId === MISSING.ruleId);
    expect(queued.map((event) => [event.action, event.reason])).toEqual([["blocked", "engine-capability"]]);
  });
});

describe("engine bench times the engine on every vector set", () => {
  it("prints ns/op for one pass over the set, ns per case and allocs/op for the invariant probes and each shared vector set", async () => {
    const result = await engineCommand(suite.binary(), ["bench"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    const sets = result.stdout.split("\n").flatMap((line) => {
      const match = /^(\S+)\s+(\d+) cases\s+(\d+) ns\/op\s+(\d+) ns\/case\s+(\d+) allocs\/op$/.exec(line);
      return match === null ? [] : [{ set: match[1] ?? "", cases: Number(match[2]), nsPerOp: Number(match[3]), nsPerCase: Number(match[4]) }];
    });
    expect(sets.map((row) => row.set)).toEqual(["invariants", ...VECTOR_SETS]);
    for (const row of sets) {
      expect(row.cases, row.set).toBeGreaterThan(0);
      expect(row.nsPerOp, row.set).toBeGreaterThan(0);
      expect(row.nsPerCase, row.set).toBe(Math.floor(row.nsPerOp / row.cases));
    }
  }, 300_000);
});
