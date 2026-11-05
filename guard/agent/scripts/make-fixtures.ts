// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Vibtra
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, seedCatalogue, type GuardBundle } from "../../../packages/guard-contract/src/index.js";
import { digestOf, generateGuardSigningKey, signGuardBundle, signGuardCatalogue } from "../../../packages/guard-contract/src/signing.js";

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const key = generateGuardSigningKey();
const now = new Date("2026-10-16T00:00:00.000Z");

const bundle: GuardBundle = {
  protocol: 1,
  orgId: "org_fernwood",
  deviceId: "gdev_0123456789abcdef",
  bundleVersion: 7,
  catalogueVersion: "2026-10-16",
  generatedAt: "2026-10-16T00:00:00.000Z",
  person: { userId: "user_ada", email: "ada@fernwood.example" },
  clientMode: "enforce",
  defaultAction: "allow",
  services: {
    deepseek: { action: "block", ruleId: "gsr_00000001", note: "Data is processed in the PRC — \"not for work\"\nAsk IT." },
    "openai-chatgpt": { action: "allow", ruleId: "gsr_00000002" },
  },
  contentRules: [
    { ruleId: "gcr_00000001", name: "Tax file numbers", detector: { kind: "au-tfn" }, services: "*", action: "block", note: "A TFN is never pasted into an AI service." },
    { ruleId: "gcr_00000002", name: "Bulk email addresses", detector: { kind: "email-bulk", threshold: 10 }, services: ["openai-chatgpt"], action: "ask" },
    { ruleId: "gcr_00000003", name: "Café codenames", detector: { kind: "keyword", keywords: ["Project Falcon", "naïve"], wholeWord: true }, services: "*", action: "allow" },
  ],
  exceptions: [{ grantId: "pg_0001", scope: "user", serviceId: "anthropic-claude", expiresAt: "2026-10-23T00:00:00.000Z" }],
  settings: { requestsEnabled: true, workspaceRedirect: { enabled: true, url: "https://fernwood.vibtra.app/workspace" }, snippetPolicy: "redacted", snippetMax: 80 },
};

const signed = signGuardBundle(bundle, key, now);
const tampered = { ...signed, bundle: { ...signed.bundle, defaultAction: "block" as const } };
const otherDevice = signGuardBundle({ ...bundle, deviceId: "gdev_fedcba9876543210" }, key, now);
const catalogue = signGuardCatalogue(seedCatalogue(), "org_fernwood", key, now);

const splitJws = (value: unknown): unknown => {
  const v = value as { signature?: { jws?: string } & Record<string, unknown> } & Record<string, unknown>;
  if (v.signature?.jws === undefined) return value;
  const { jws, ...rest } = v.signature;
  return { ...v, signature: { ...rest, jwsParts: jws.split(".") } };
};
const write = (name: string, value: unknown): void => writeFileSync(join(out, name), `${JSON.stringify(splitJws(value), null, 2)}\n`);
write("signed-bundle.json", signed);
write("signed-bundle-tampered.json", tampered);
write("signed-bundle-other-device.json", otherDevice);
write("signed-catalogue.json", catalogue);
writeFileSync(join(out, "signing-public.pem"), key.publicKeyPem);
write("digests.json", {
  keyId: key.keyId,
  bundleDigest: digestOf(signed.bundle),
  catalogueDigest: digestOf(catalogue.catalogue),
  bundleCanonical: canonicalJson(signed.bundle),
});
process.stdout.write(`fixtures written to ${out} (key ${key.keyId})\n`);
