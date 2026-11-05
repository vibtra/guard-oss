import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVE, GuestRun, REFUSAL, freePort, portOpen, writeSourceProfile } from "./guard-guest-bridge.js";
import { absentBridge, runScript, type CliResult } from "./guard-guest-cli.js";

const SECRET = "sk-test-FAKE-guest-registry-never-log";
const bridge = absentBridge();

let work = "";
let out = "";
let source = "";
let port = 0;

const run = (args: string[]): CliResult => runScript("guard-guest-registry-run.mjs", args, ["--import", "tsx"]);

const activation = (): string[] => [
  "--guest-ready",
  "--out",
  out,
  "--host",
  "192.168.64.1",
  "--interface",
  bridge,
  "--port",
  String(port),
  "--source-profile",
  source,
];

const expectRefused = (result: CliResult): void => {
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toMatch(REFUSAL);
  expect(existsSync(path.join(out, "session"))).toBe(false);
};

beforeAll(async () => {
  work = mkdtempSync(path.join(os.tmpdir(), "guard-guest-run-"));
  out = path.join(work, "prepared");
  const prepared = runScript("guard-guest-registry-prepare.mjs", ["--out", out, "--host", "127.0.0.1"]);
  if (prepared.status !== 0) throw new Error(`prepare failed: ${prepared.stderr}`);
  source = path.join(work, "source-profile");
  mkdirSync(source, { mode: 0o700 });
  port = await freePort("127.0.0.1");
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("guard-guest-registry-run.mjs", () => {
  it("never echoes an argument value when it refuses", () => {
    for (const args of [["--unexpected-credential", SECRET], ["--guest-ready", SECRET]]) {
      const result = run(args);
      expect(result.status, args.join(" ")).toBe(1);
      expect(result.stderr).toMatch(REFUSAL);
      expect(`${result.stdout}${result.stderr}`).not.toContain(SECRET);
    }
  });

  it("refuses an interface that does not exist, exits and leaves the port free", async () => {
    expectRefused(run(activation()));
    expect(await portOpen("127.0.0.1", port)).toBe(false);
  });

  it("refuses 127.0.0.1 even when the prepared material and the source profile would start a session", async () => {
    const loopback = path.join(work, "loopback");
    const prepared = runScript("guard-guest-registry-prepare.mjs", ["--out", loopback, "--host", "127.0.0.1", "--interface", bridge]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const signed = path.join(work, "signed-source-profile");
    writeSourceProfile(signed);
    const run = new GuestRun({ out: loopback, host: "127.0.0.1", bridge, port: await freePort("127.0.0.1"), source: signed });
    try {
      expect(await run.exit()).toEqual({ code: 1, signal: null });
      expect(run.stderr).toMatch(REFUSAL);
      expect(run.stdout).not.toContain(ACTIVE);
      expect(existsSync(path.join(loopback, "session"))).toBe(false);
    } finally {
      run.stop();
    }
  }, 60_000);
});
