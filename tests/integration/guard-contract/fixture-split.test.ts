import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIXTURE_SPLIT, readFixtureJson } from "@vibtra/guard-contract/vectors";

const FILES = [
  new URL("../../../packages/guard-contract/src/detectors.vectors.json", import.meta.url),
  new URL("../../../guard/agent-go/testdata/provider-requests.json", import.meta.url),
];

const KEY_SHAPED = /(?:ghp_|gho_|github_pat_|sk-proj-|sk-ant-|sk_test_|sk_live_|xox[abprs]-|AKIA|ASIA|AIza|SG\.|ya29\.|GOCSPX-|hooks\.slack\.com|-----BEGIN [A-Z ]*PRIVATE KEY-----)[A-Za-z0-9_\-./+=%]{8,}/;

describe("key-shaped fixture values are split so secret scanners do not match the files", () => {
  for (const file of FILES) {
    const name = file.pathname.split("/").slice(-2).join("/");

    it(`${name} holds no unsplit key-shaped value`, () => {
      const raw = readFileSync(file, "utf8");
      const hit = raw.split("\n").findIndex((line) => KEY_SHAPED.test(line));
      expect(hit, `line ${hit + 1}: split the value with ${FIXTURE_SPLIT} after its first character`).toBe(-1);
    });

    it(`${name} still yields key-shaped values once the loader strips the marker`, () => {
      expect(JSON.stringify(readFixtureJson<unknown>(file))).toMatch(KEY_SHAPED);
    });
  }
});
