import { X509Certificate } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface FakeSecurity {
  readonly env: Readonly<Record<string, string>>;
  trusted(pem: string): boolean;
  inKeychain(pem: string): boolean;
  calls(op: string): string[][];
  close(): Promise<void>;
}

export const FAIL_ENV = "VIBTRA_GUARD_FAKE_SECURITY_FAIL";
const STATE_ENV = "VIBTRA_GUARD_FAKE_SECURITY_DIR";

const sha1Of = (cert: X509Certificate): string => cert.fingerprint.replaceAll(":", "");
const trustPath = (dir: string, cert: X509Certificate): string => path.join(dir, "trusted", cert.fingerprint256.replaceAll(":", ""));
const keychainPath = (dir: string, sha1: string): string => path.join(dir, "keychain", sha1);
const callLines = (dir: string): string[][] => {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line): unknown => JSON.parse(line))
    .filter((call): call is string[] => Array.isArray(call) && call.every((arg) => typeof arg === "string"));
};

const fakeSecurity = (dir: string, op: string, args: readonly string[]): number => {
  appendFileSync(path.join(dir, "calls.log"), `${JSON.stringify([op, ...args])}\n`);
  if (process.env[FAIL_ENV] === op) {
    process.stderr.write(`security: ${op}: the password prompt was cancelled\n`);
    return 1;
  }
  const after = (flag: string): string => args[args.indexOf(flag) + 1] ?? "";
  const certAt = (file: string): X509Certificate | undefined => {
    try {
      return new X509Certificate(readFileSync(file));
    } catch {
      return undefined;
    }
  };
  switch (op) {
    case "verify-cert": {
      const cert = certAt(after("-c"));
      return cert !== undefined && existsSync(trustPath(dir, cert)) ? 0 : 1;
    }
    case "add-trusted-cert": {
      const cert = certAt(args.at(-1) ?? "");
      if (cert === undefined) return 1;
      writeFileSync(trustPath(dir, cert), "");
      writeFileSync(keychainPath(dir, sha1Of(cert)), cert.toString());
      return 0;
    }
    case "remove-trusted-cert": {
      const cert = certAt(args.at(-1) ?? "");
      if (cert === undefined || !existsSync(trustPath(dir, cert))) {
        process.stderr.write("SecTrustSettingsRemoveTrustSettings: The specified item could not be found in the keychain.\n");
        return 1;
      }
      rmSync(trustPath(dir, cert));
      return 0;
    }
    case "find-certificate": {
      const name = after("-c");
      const found = readdirSync(path.join(dir, "keychain")).filter((sha1) => new X509Certificate(readFileSync(keychainPath(dir, sha1))).subject.includes(name));
      for (const sha1 of found) process.stdout.write(`keychain: "${after("-c")}"\nSHA-1 hash: ${sha1}\n`);
      return found.length === 0 ? 44 : 0;
    }
    case "delete-certificate": {
      const file = keychainPath(dir, after("-Z"));
      if (!existsSync(file)) return 1;
      rmSync(file);
      return 0;
    }
  }
  return 2;
};

export const startFakeSecurity = async (): Promise<FakeSecurity> => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "guard-fake-security-"));
  mkdirSync(path.join(dir, "trusted"));
  mkdirSync(path.join(dir, "keychain"));
  const bin = path.join(dir, "security");
  await writeFile(bin, `#!/bin/sh\n${STATE_ENV}='${dir}' exec '${process.execPath}' '${fileURLToPath(import.meta.url)}' "$@"\n`);
  await chmod(bin, 0o700);
  return {
    env: { VIBTRA_GUARD_SECURITY_BIN: bin },
    trusted: (pem) => existsSync(trustPath(dir, new X509Certificate(pem))),
    inKeychain: (pem) => existsSync(keychainPath(dir, sha1Of(new X509Certificate(pem)))),
    calls: (op) => callLines(dir).filter(([name]) => name === op),
    close: () => rm(dir, { recursive: true, force: true }),
  };
};

const stateDir = process.env[STATE_ENV];
if (stateDir !== undefined && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = fakeSecurity(stateDir, process.argv[2] ?? "", process.argv.slice(3));
}
