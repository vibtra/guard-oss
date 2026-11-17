import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createCleanup } from "../../support/cleanup.ts";

const AGENT_DIR = fileURLToPath(new URL("../../../guard/agent-go/", import.meta.url));
const CONFIG = fileURLToPath(new URL("../../../.golangci.yml", import.meta.url));
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

describe("golangci-lint guardrails on guard/agent-go", () => {
  it("guard/agent-go is clean under .golangci.yml", { timeout: LINT_TIMEOUT }, async () => {
    expect((await lint(AGENT_DIR)).map((issue) => `${issue.Pos.Filename}:${issue.Pos.Line} ${issue.FromLinter}: ${issue.Text}`)).toEqual([]);
  });

  it("fires forbidigo, errcheck, staticcheck, unparam and nolintlint on a violating file, and each forbidigo message says what to use instead", { timeout: LINT_TIMEOUT }, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "guard-golangci-"));
    cleanup.defer(() => rm(root, { recursive: true, force: true }));
    const tree = path.join(root, "agent-go");
    await cp(AGENT_DIR, tree, { recursive: true, filter: (source) => path.relative(AGENT_DIR, source) !== "build" });
    await writeFile(path.join(tree, "zz_guardrail_fixture.go"), FIXTURE);
    const found = (await lint(tree)).filter((issue) => issue.Pos.Filename === "zz_guardrail_fixture.go");
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
