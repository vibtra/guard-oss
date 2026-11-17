import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCleanup } from "../../support/cleanup.ts";

const AGENT_DIR = fileURLToPath(new URL("../../../guard/agent-go/", import.meta.url));
const CONFIG = fileURLToPath(new URL("../../../.golangci.yml", import.meta.url));
const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const CLIENT_CHECK = fileURLToPath(new URL("../../../tools/go-guardrails/", import.meta.url));
const CLIENT_ALLOW = path.join(CLIENT_CHECK, "http-client-allow.json");
const LINT_TIMEOUT = 600_000;

type Issue = { FromLinter: string; Text: string; Pos: { Filename: string; Line: number } };

const cleanup = createCleanup();
afterAll(() => cleanup.run());

const lint = (dir: string) =>
  new Promise<Issue[]>((resolve, reject) => {
    execFile(
      "golangci-lint",
      ["run", "--config", CONFIG, "--output.json.path", "stdout", "--output.text.path", "stderr", "./..."],
      { cwd: dir, env: process.env, timeout: LINT_TIMEOUT, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && error.code !== 1) {
          reject(new Error(`golangci-lint failed (${String(error.code)}): ${stderr}`));
          return;
        }
        try {
          resolve(((JSON.parse(stdout.split("\n")[0] ?? "") as { Issues: Issue[] | null }).Issues ?? []).map((issue) => ({ ...issue, Pos: { ...issue.Pos, Filename: path.basename(issue.Pos.Filename) } })));
        } catch {
          reject(new Error(`golangci-lint printed no JSON report: ${stdout.slice(0, 500)} ${stderr.slice(0, 2000)}`));
        }
      },
    );
  });

const FIXTURE = `package main

import (
	"crypto/x509"
	"net/http"
	"os"
	"strings"
)

func guardrailFixture(d Device) (*x509.CertPool, string, error) {
	_ = http.DefaultClient
	_ = http.DefaultTransport
	base := d.Server.BaseURL
	if resp, e := http.Get(base); e == nil {
		_ = resp.Body.Close()
	}
	os.Remove("never-checked")
	_ = strings.ToLower("A") == strings.ToLower("b")
	pool, e := x509.SystemCertPool()
	return pool, guardrailLabel(1), e
}

func guardrailLabel(n int) string {
	return strings.Repeat("fixture", 2)
}

var _ = guardrailFixture

var _ = http.DefaultTransport //nolint:forbidigo

func guardrailRegistry(d Device) string {
	return untrustedEnrolledRegistry(d)
}

var _ = guardrailRegistry
`;

const LEGACY_ORIGIN_FIXTURE = `package main

import "net/http"

func legacyRegistryOrigin(base string) {
	if resp, e := http.Get(base); e == nil {
		_ = resp.Body.Close()
	}
}

var _ = legacyRegistryOrigin
`;

const INSECURE_FIXTURE = `package main

import "crypto/tls"

func insecureFixture() *tls.Config {
	c := &tls.Config{InsecureSkipVerify: true}
	c.InsecureSkipVerify = true
	return c
}

var _ = insecureFixture
`;

const NOLINT_FORBIDIGO = /\/\/\s*nolint:[\w,-]*\bforbidigo\b/;

const EXPECTED_NOLINT_FORBIDIGO = [
  "local.go: out[\"server\"] = untrustedEnrolledRegistry(*d)",
  "proxy.go: roots, e := x509.SystemCertPool()",
  "sync.go: e = api(ctx, method, untrustedEnrolledRegistry(d), path, strings.TrimSpace(string(token)), body, out)",
  "sync.go: healthScope := untrustedEnrolledRegistry(*d)",
];

const goFiles = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !path.join(entry.parentPath, entry.name).includes(`${path.sep}build${path.sep}`))
    .map((entry) => path.join(entry.parentPath, entry.name));

const nolintForbidigoSites = async (dir: string): Promise<string[]> => {
  const sites: string[] = [];
  for (const file of await goFiles(dir)) {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      const at = line.search(NOLINT_FORBIDIGO);
      if (at >= 0) sites.push(`${path.relative(dir, file).split(path.sep).join("/")}: ${line.slice(0, at).trim()}`);
    }
  }
  return sites.sort();
};

type ClientFinding = { file: string; line: number; form: string; fix: string };

let clientCheckBin: string | undefined;

const clientCheckBinary = async (): Promise<string> => {
  if (clientCheckBin !== undefined) return clientCheckBin;
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-client-check-"));
  cleanup.defer(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "client-check");
  const build = spawnSync("go", ["build", "-C", CLIENT_CHECK, "-o", bin, "."], { encoding: "utf8", timeout: 120_000 });
  if (build.status !== 0) throw new Error(`go build ${CLIENT_CHECK} failed: ${build.stderr}`);
  clientCheckBin = bin;
  return bin;
};

const clientCheck = async (allow: string, base: string, dir: string): Promise<{ status: number | null; findings: ClientFinding[]; stderr: string }> => {
  const run = spawnSync(await clientCheckBinary(), [allow, base, dir], { encoding: "utf8", timeout: 120_000 });
  const findings = run.stdout.trim() === "" ? [] : (JSON.parse(run.stdout) as { findings: ClientFinding[] }).findings;
  return { status: run.status, findings, stderr: run.stderr };
};

describe("golangci-lint guardrails on guard/agent-go", () => {
  it("R1: the //nolint:forbidigo sites in guard/agent-go are exactly the reviewed ones", async () => {
    expect(await nolintForbidigoSites(AGENT_DIR)).toEqual(EXPECTED_NOLINT_FORBIDIGO);
  });

  it("R1: a new //nolint:forbidigo, alone or in a list, fails the site check", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-nolint-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, "a.go"), "package main\n\nvar _ = http.DefaultClient //nolint:forbidigo // looks harmless\n");
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "b.go"), "package sub\n\nvar _ = http.DefaultTransport //nolint:errcheck,forbidigo // also harmless\n");
    expect(await nolintForbidigoSites(root)).toEqual(["a.go: var _ = http.DefaultClient", "sub/b.go: var _ = http.DefaultTransport"]);
  });

  it("R3: forbidigo is switched off for registry_origin.go alone, by an anchored path", () => {
    const paths = [...readFileSync(CONFIG, "utf8").matchAll(/^\s*- path: (.+)$/gm)].map((match) => match[1]);
    expect(paths).toEqual(["(^|/)registry_origin\\.go$"]);
  });

  it("R2: no http.Client in guard/agent-go falls back to the default transport", async () => {
    const run = await clientCheck(CLIENT_ALLOW, REPO, AGENT_DIR);
    expect(run.findings).toEqual([]);
    expect(run.status, run.stderr).toBe(0);
  });

  it("R2: an http.Client with no Transport fails, in every form, and the message says what to do", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-client-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    await writeFile(
      path.join(root, "client.go"),
      [
        "package main",
        "",
        "import (",
        "\tnethttp \"net/http\"",
        "\t\"time\"",
        ")",
        "",
        "var a = &nethttp.Client{Timeout: time.Second}",
        "var b = nethttp.Client{}",
        "var c = new(nethttp.Client)",
        "var d nethttp.Client",
        "var e = &nethttp.Client{Timeout: time.Second, Transport: &nethttp.Transport{}}",
        "",
      ].join("\n"),
    );
    const allow = path.join(root, "allow.json");
    await writeFile(allow, JSON.stringify({ allow: [] }));
    const run = await clientCheck(allow, root, root);
    expect(run.status).toBe(1);
    expect(run.findings.map((finding) => `${finding.file}:${finding.line} ${finding.form}`)).toEqual([
      "client.go:8 http.Client{} without Transport",
      "client.go:9 http.Client{} without Transport",
      "client.go:10 new(http.Client)",
      "client.go:11 var of type http.Client",
    ]);
    expect(run.findings[0]?.fix).toContain("Set Transport to one with explicit roots, as registryClient in guard/agent-go/registry_origin.go does");

    await writeFile(allow, JSON.stringify({ allow: [{ file: "client.go", reason: "short" }] }));
    const reasonless = await clientCheck(allow, root, root);
    expect(reasonless.status).toBe(2);
    expect(reasonless.stderr).toContain('the entry for "client.go" needs a reason of at least 20 characters');

    await writeFile(allow, JSON.stringify({ allow: [{ file: "client.go", reason: "a fixture that never dials anything at all" }] }));
    expect(await clientCheck(allow, root, root)).toMatchObject({ status: 0, findings: [] });
  });

  it("guard/agent-go is clean under .golangci.yml", { timeout: LINT_TIMEOUT }, async () => {
    expect((await lint(AGENT_DIR)).map((issue) => `${issue.Pos.Filename}:${issue.Pos.Line} ${issue.FromLinter}: ${issue.Text}`)).toEqual([]);
  });

  it("fires forbidigo, errcheck, staticcheck, unparam and nolintlint on a violating file, and each forbidigo message says what to use instead", { timeout: LINT_TIMEOUT }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-golangci-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const tree = path.join(root, "agent-go");
    await cp(AGENT_DIR, tree, { recursive: true, filter: (source) => path.relative(AGENT_DIR, source) !== "build" });
    await writeFile(path.join(tree, "zz_guardrail_fixture.go"), FIXTURE);
    await writeFile(path.join(tree, "legacy_registry_origin.go"), LEGACY_ORIGIN_FIXTURE);
    await writeFile(path.join(tree, "zz_insecure_fixture.go"), INSECURE_FIXTURE);
    const all = await lint(tree);
    const found = all.filter((issue) => issue.Pos.Filename === "zz_guardrail_fixture.go");
    const inFile = (file: string, line: number) => all.filter((issue) => issue.Pos.Filename === file && issue.Pos.Line === line && issue.FromLinter === "forbidigo").map((issue) => issue.Text);
    expect(inFile("legacy_registry_origin.go", 6)).toEqual([expect.stringContaining("use of `http.Get` forbidden")]);
    for (const line of [6, 7]) {
      expect(inFile("zz_insecure_fixture.go", line), `line ${line}`).toEqual([expect.stringContaining("this turns off certificate checks")]);
    }
    const at = (line: number, linter: string) => found.filter((issue) => issue.Pos.Line === line && issue.FromLinter === linter).map((issue) => issue.Text);
    expect(at(11, "forbidigo")).toEqual([expect.stringContaining("use of `http.DefaultClient` forbidden because \"the default client trusts the system roots and has no timeout. Use registryHTTP (registry_origin.go)")]);
    expect(at(12, "forbidigo")).toEqual([expect.stringContaining("Build a transport with explicit roots, as registryClient in registry_origin.go does.")]);
    expect(at(13, "forbidigo")).toEqual([
      expect.stringContaining("use of `d.Server.BaseURL` forbidden because \"the registry address in device.json is editable by the user. Read it only in registry_origin.go and send calls through api()"),
    ]);
    expect(at(14, "forbidigo")).toEqual([expect.stringContaining("use of `http.Get` forbidden because \"these use http.DefaultClient. Send registry calls through api() (sync.go)")]);
    expect(at(17, "errcheck")).toHaveLength(1);
    expect(at(18, "staticcheck")).toEqual([expect.stringContaining("EqualFold")]);
    expect(at(19, "forbidigo")).toEqual([expect.stringContaining("Use the built-in roots that registryClient (registry_origin.go) loads.")]);
    expect(found.filter((issue) => issue.FromLinter === "unparam").map((issue) => issue.Pos.Line)).toContain(23);
    expect([at(29, "forbidigo"), at(29, "nolintlint")]).toEqual([[], [expect.stringContaining("should provide explanation")]]);
    expect(at(32, "forbidigo")).toEqual([
      expect.stringContaining("this is the unchecked registry address from device.json, which the user can edit. Send registry calls through Agent.call() or api()"),
    ]);
  });
});
