import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GuardClientMode, GuardDeviceProtection, deviceProtectionOf, type GuardDeviceProtectionFacts, type GuardInterceptionOffReason } from "@vibtra/guard-contract";
import { PACKAGE_DIR } from "./support.js";

type Facts = GuardDeviceProtectionFacts;
type Protection = GuardDeviceProtection;
type Decide = (facts: Facts) => Protection;

const VECTORS_FILE = path.join(PACKAGE_DIR, "src/device-protection.vectors.json");
const COLUMNS = ["status", "interception", "extension", "silence", "policy", "mode"] as const;

const every = <T extends string>(members: Record<T, true>): T[] => Object.keys(members) as T[];

const DOMAIN: { [K in keyof Facts]: readonly Facts[K][] } = {
  status: every<Facts["status"]>({ active: true, revoked: true }),
  interception: every<Facts["interception"]>({
    on: true,
    "not-reported": true,
    "unsigned-build": true,
    "no-secure-enclave": true,
    "key-unavailable": true,
    "signer-unavailable": true,
    "awaiting-trust": true,
    "unsupported-platform": true,
  }),
  extension: every<Facts["extension"]>({ active: true, "not-active": true }),
  silence: every<Facts["silence"]>({ fresh: true, late: true, quiet: true }),
  policy: every<Facts["policy"]>({ applied: true, "no-policy": true, "sync-failing": true }),
  mode: GuardClientMode.options,
};

const crossProduct = (): Facts[] =>
  COLUMNS.reduce<Partial<Facts>[]>((rows, column) => rows.flatMap((row) => DOMAIN[column].map((value) => ({ ...row, [column]: value }))), [{}]) as Facts[];

const offReason = (f: Facts): GuardInterceptionOffReason | undefined => (f.interception === "on" || f.interception === "not-reported" ? undefined : f.interception);
const reaches = (f: Facts): boolean => f.status === "active" && offReason(f) === undefined;
const synced = (f: Facts): boolean => reaches(f) && f.silence === "fresh" && f.policy === "applied";
const proven = (f: Facts): boolean => f.interception === "on" && f.extension === "active";

interface Rule {
  id: string;
  pins: string;
  when: (f: Facts) => boolean;
  state: Decide;
}

const RULES: readonly Rule[] = [
  {
    id: "revoked",
    pins: "d296323 (VIB-54): a revoked Mac reads Revoked, whatever else it reported",
    when: (f) => f.status === "revoked",
    state: () => ({ state: "revoked" }),
  },
  {
    id: "interception-off",
    pins: "913ae9e, 4f1cc88 (VIB-51): an active Mac that reports interception off reads Not protected with that reason, quiet, late or unsynced, in any mode",
    when: (f) => f.status === "active" && offReason(f) !== undefined,
    state: (f) => ({ state: "unprotected", reason: offReason(f) ?? "interception-not-reported" }),
  },
  {
    id: "silent",
    pins: "a60f4a4 (VIB-52): an active Mac silent past Late or Quiet reads Late or Quiet, never Protected or Monitoring",
    when: (f) => reaches(f) && f.silence !== "fresh",
    state: (f) => ({ state: f.silence === "quiet" ? "quiet" : "late" }),
  },
  {
    id: "no-policy",
    pins: "0939b91 (VIB-50): a Mac that has not applied its policy reads No policy yet or Sync failing, never Protected or Monitoring",
    when: (f) => reaches(f) && f.silence === "fresh" && f.policy !== "applied",
    state: (f) => ({ state: f.policy === "no-policy" ? "no-policy" : "sync-failing" }),
  },
  {
    id: "mode",
    pins: "783705a: a synced Mac in Monitor or Off reads Monitoring or Off",
    when: (f) => synced(f) && f.mode !== "enforce",
    state: (f) => ({ state: f.mode === "monitor" ? "monitoring" : "off" }),
  },
  {
    id: "protected",
    pins: "VIB-110: a synced Mac in Enforce reads Protected only with interception on and the extension active",
    when: (f) => synced(f) && f.mode === "enforce" && proven(f),
    state: () => ({ state: "protected" }),
  },
  {
    id: "unproven",
    pins: "VIB-110: a synced Mac in Enforce without that proof reads Not protected, naming the missing proof",
    when: (f) => synced(f) && f.mode === "enforce" && !proven(f),
    state: (f) => ({ state: "unprotected", reason: f.interception === "on" ? "extension-not-active" : "interception-not-reported" }),
  },
];

type Row = [...string[]];
interface VectorsFile {
  about: string;
  columns: string[];
  rules: { id: string; pins: string; vectors: Row[] }[];
}

const rowOf = (f: Facts, p: Protection): Row => [...COLUMNS.map((column) => f[column]), p.state, ...(p.state === "unprotected" ? [p.reason] : [])];

const fromRules = (): VectorsFile => {
  const facts = crossProduct();
  return {
    about:
      "Every combination of a device's protection facts and the state deviceProtectionOf must return. Generated from the rules in tests/integration/guard-contract/device-protection-vectors.test.ts: run that file with WRITE_PROTECTION_VECTORS=1 after a rule changes. Each implementation of the protection state (the registry for the console, the agent for the Mac) is tested against this file.",
    columns: [...COLUMNS, "state", "reason"],
    rules: RULES.map((rule) => ({ id: rule.id, pins: rule.pins, vectors: facts.filter(rule.when).map((f) => rowOf(f, rule.state(f))) })),
  };
};

const serialise = (file: VectorsFile): string => {
  const rules = file.rules.map(
    (rule) => `    {\n      "id": ${JSON.stringify(rule.id)},\n      "pins": ${JSON.stringify(rule.pins)},\n      "vectors": [\n${rule.vectors.map((row) => `        ${JSON.stringify(row)}`).join(",\n")}\n      ]\n    }`,
  );
  return `{\n  "about": ${JSON.stringify(file.about)},\n  "columns": ${JSON.stringify(file.columns)},\n  "rules": [\n${rules.join(",\n")}\n  ]\n}\n`;
};

if (process.env.WRITE_PROTECTION_VECTORS === "1") writeFileSync(VECTORS_FILE, serialise(fromRules()));

const file = JSON.parse(readFileSync(VECTORS_FILE, "utf8")) as VectorsFile;

interface Vector {
  rule: string;
  facts: Facts;
  protection: Protection;
}

const vectors: Vector[] = file.rules.flatMap((rule) =>
  rule.vectors.map((row) => {
    const [state, reason] = row.slice(COLUMNS.length);
    return {
      rule: rule.id,
      facts: Object.fromEntries(COLUMNS.map((column, i) => [column, row[i]])) as unknown as Facts,
      protection: GuardDeviceProtection.parse(reason === undefined ? { state } : { state, reason }),
    };
  }),
);

const failures = (decide: Decide): { rule: string; facts: string; expected: Protection; got: Protection }[] =>
  vectors.flatMap((v) => {
    const got = decide(v.facts);
    return JSON.stringify(got) === JSON.stringify(v.protection) ? [] : [{ rule: v.rule, facts: COLUMNS.map((c) => v.facts[c]).join(" "), expected: v.protection, got }];
  });

const interceptionOff = (f: Facts): Protection | undefined => {
  const reason = offReason(f);
  return reason === undefined ? undefined : { state: "unprotected", reason };
};
const monitoring: Protection = { state: "monitoring" };
const protectedState: Protection = { state: "protected" };

const REPLAYS: readonly { commit: string; breaks: string; decide: Decide }[] = [
  {
    commit: "d296323^ (VIB-54, the Mac overview): the certificate notice before revoked",
    breaks: "revoked",
    decide: (f) => interceptionOff(f) ?? (f.status === "revoked" ? { state: "revoked" } : f.mode === "enforce" ? protectedState : monitoring),
  },
  {
    commit: "4f1cc88^ (VIB-51): Quiet before Not protected",
    breaks: "interception-off",
    decide: (f) => {
      if (f.status === "revoked") return { state: "revoked" };
      if (f.silence === "quiet") return { state: "quiet" };
      return interceptionOff(f) ?? (f.mode === "enforce" ? protectedState : monitoring);
    },
  },
  {
    commit: "0939b91^ (VIB-50): no check that the policy was applied",
    breaks: "no-policy",
    decide: (f) => {
      if (f.status === "revoked") return { state: "revoked" };
      const off = interceptionOff(f);
      if (off !== undefined) return off;
      if (f.silence === "quiet") return { state: "quiet" };
      return f.mode === "enforce" ? protectedState : monitoring;
    },
  },
  {
    commit: "a60f4a4^ (VIB-52): no Late, so a silent Mac stays Protected until Quiet",
    breaks: "silent",
    decide: (f) => {
      if (f.status === "revoked") return { state: "revoked" };
      const off = interceptionOff(f);
      if (off !== undefined) return off;
      if (f.silence === "quiet") return { state: "quiet" };
      if (f.policy !== "applied") return { state: f.policy === "no-policy" ? "no-policy" : "sync-failing" };
      return f.mode === "enforce" ? protectedState : monitoring;
    },
  },
  {
    commit: "f10eba8 (main before VIB-110): Enforce falls through to Protected without proof of interception or the extension",
    breaks: "unproven",
    decide: (f) => {
      if (f.status === "revoked") return { state: "revoked" };
      const off = interceptionOff(f);
      if (off !== undefined) return off;
      if (f.silence !== "fresh") return { state: f.silence === "quiet" ? "quiet" : "late" };
      if (f.policy !== "applied") return { state: f.policy === "no-policy" ? "no-policy" : "sync-failing" };
      if (f.mode === "enforce") return protectedState;
      return f.mode === "off" ? { state: "off" } : monitoring;
    },
  },
];

describe("one protection state for a device (device-protection.vectors.json)", () => {
  it("the rules cover every combination of the facts exactly once", () => {
    const facts = crossProduct();
    expect(facts).toHaveLength(2 * 8 * 2 * 3 * 3 * 3);
    const overlaps = facts.map((f) => ({ f, ids: RULES.filter((rule) => rule.when(f)).map((rule) => rule.id) })).filter(({ ids }) => ids.length !== 1);
    expect(overlaps).toEqual([]);
  });

  it("the vectors file holds the rules over the full cross product, in order", () => {
    expect(readFileSync(VECTORS_FILE, "utf8"), "run this file with WRITE_PROTECTION_VECTORS=1 after a rule changes").toBe(serialise(fromRules()));
    expect(new Set(vectors.map((v) => COLUMNS.map((c) => v.facts[c]).join(" "))).size).toBe(crossProduct().length);
  });

  it("deviceProtectionOf returns the state of every vector", () => {
    expect(failures(deviceProtectionOf)).toEqual([]);
  });

  it("Protected only when every precondition is proven: active, interception on, extension active, fresh, policy applied, Enforce", () => {
    for (const { facts: f, protection } of vectors) {
      const all = f.status === "active" && f.interception === "on" && f.extension === "active" && f.silence === "fresh" && f.policy === "applied" && f.mode === "enforce";
      expect(protection.state === "protected", JSON.stringify(f)).toBe(all);
    }
  });

  it.each(REPLAYS)("the replayed decision of $commit fails the table, on the rule its fix added", ({ commit, breaks, decide }) => {
    const failed = failures(decide);
    const onRule = failed.filter((f) => f.rule === breaks);
    const shown = onRule.find((f) => f.got.state === "protected") ?? onRule[0];
    console.log(`${commit}: fails ${failed.length} of ${vectors.length} vectors, ${onRule.length} on rule ${breaks}, e.g. [${shown?.facts}] expected ${JSON.stringify(shown?.expected)}, got ${JSON.stringify(shown?.got)}`);
    expect(shown, `${commit} should fail on rule ${breaks}`).toBeDefined();
  });
});
