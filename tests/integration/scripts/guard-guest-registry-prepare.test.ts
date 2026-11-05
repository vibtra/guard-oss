import { X509Certificate, createPrivateKey } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { absentBridge, runScript } from "./guard-guest-cli.js";

const PREPARED = ["ca.key", "ca.pem", "ca.srl", "preparation.json", "server.csr", "server.ext", "server.key", "server.pem"];
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;
const bridge = absentBridge();

let work = "";

const freshOut = (): string => path.join(mkdtempSync(path.join(work, "case-")), "out");

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), "guard-guest-prepare-"));
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
});

describe("guard-guest-registry-prepare.mjs", () => {
  it("writes private two-day TLS material for 127.0.0.1", () => {
    const out = freshOut();
    const result = runScript("guard-guest-registry-prepare.mjs", ["--out", out, "--host", "127.0.0.1"]);
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o700);
    expect(readdirSync(out).sort()).toEqual(PREPARED);
    for (const name of PREPARED) expect(statSync(path.join(out, name)).mode & 0o777, name).toBe(0o600);
    expect(JSON.parse(readFileSync(path.join(out, "preparation.json"), "utf8"))).toEqual({
      status: "prepared-not-listening-not-enrolled",
      host: "127.0.0.1",
      interfaceName: null,
      expiresInDays: 2,
      guestTrustApproved: false,
    });
    const ca = new X509Certificate(readFileSync(path.join(out, "ca.pem")));
    const server = new X509Certificate(readFileSync(path.join(out, "server.pem")));
    expect(ca.ca).toBe(true);
    expect(server.ca).toBe(false);
    expect(server.verify(ca.publicKey)).toBe(true);
    expect(server.checkIP("127.0.0.1")).toBe("127.0.0.1");
    expect(server.checkPrivateKey(createPrivateKey(readFileSync(path.join(out, "server.key"))))).toBe(true);
    const now = Date.now();
    for (const certificate of [ca, server]) {
      expect(Date.parse(certificate.validFrom)).toBeLessThanOrEqual(now);
      expect(Date.parse(certificate.validTo)).toBeGreaterThan(now);
      expect(Date.parse(certificate.validTo) - Date.parse(certificate.validFrom)).toBeLessThanOrEqual(TWO_DAYS_MS + 60_000);
    }
  });

  it("refuses to prepare into an existing out folder and keeps its keys", () => {
    const out = freshOut();
    expect(runScript("guard-guest-registry-prepare.mjs", ["--out", out, "--host", "127.0.0.1"]).status).toBe(0);
    const serverKey = readFileSync(path.join(out, "server.key"));
    const caKey = readFileSync(path.join(out, "ca.key"));
    const again = runScript("guard-guest-registry-prepare.mjs", ["--out", out, "--host", "127.0.0.1"]);
    expect(again.status).not.toBe(0);
    expect(readdirSync(out).sort()).toEqual(PREPARED);
    expect(readFileSync(path.join(out, "server.key"))).toEqual(serverKey);
    expect(readFileSync(path.join(out, "ca.key"))).toEqual(caKey);
  });

  it.each<[string, string[], string]>([
    ["the wildcard address 0.0.0.0", ["--host", "0.0.0.0", "--interface", bridge], "Only private NAT addresses are accepted"],
    ["the public address 8.8.8.8", ["--host", "8.8.8.8", "--interface", bridge], "Only private NAT addresses are accepted"],
    ["the IPv6 wildcard ::", ["--host", "::", "--interface", bridge], "Use one explicit IPv4 address"],
    ["a private address on a bridge interface this machine does not have", ["--host", "192.168.64.2", "--interface", bridge], "Address must belong to the selected local NAT bridge"],
    ["a LAN address on en0, which is not a NAT bridge", ["--host", "192.168.1.1", "--interface", "en0"], "Guest transport requires an explicit NAT bridge interface"],
  ])("refuses %s without creating the out folder", (_binding, args, message) => {
    const out = freshOut();
    const result = runScript("guard-guest-registry-prepare.mjs", ["--out", out, ...args]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(existsSync(out)).toBe(false);
  });

  it("requires --out and --host", () => {
    const out = freshOut();
    const result = runScript("guard-guest-registry-prepare.mjs", ["--out", out]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Required: --out");
    expect(existsSync(out)).toBe(false);
  });
});
