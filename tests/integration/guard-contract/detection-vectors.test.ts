import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { vectors } from "@vibtra/guard-contract/vectors";
import { GUARD_SECRET_RULE_IDS, SECRET_PATTERNS, isValidAbn, isValidAcn, isValidLuhn, isValidMedicare, isValidTfn, redactMatch, runDetector, runDetectors, type DetectorInput, type DetectorSpan, type GuardDetector } from "@vibtra/guard-contract";
import { PACKAGE_DIR, buildGoAgent, scratch, type GoAgent } from "./support.js";

interface BodyVector {
  name: string;
  contentType: string;
  body: string;
  detector: GuardDetector;
  count: number;
}
const bodyVectors = JSON.parse(readFileSync(path.join(PACKAGE_DIR, "src/body.vectors.json"), "utf8")) as BodyVector[];

interface ScanItem {
  id: string;
  contentType: string;
  body: string;
  filenames: string[];
}
interface AgentHit {
  name: string;
  kind: string;
  count: number;
  details: string[] | null;
}
interface AgentRow {
  id: string;
  inspectable: boolean;
  hits: AgentHit[];
}

const namedDetectors = new Map<string, { name: string; detector: GuardDetector }>();
const probes: Array<ScanItem & { rule: string }> = [];
const register = (detector: GuardDetector, body: string, options: { contentType?: string; filenames?: string[] } = {}): string => {
  const key = JSON.stringify(detector);
  const named = namedDetectors.get(key) ?? { name: `rule-${namedDetectors.size}`, detector };
  namedDetectors.set(key, named);
  const id = `p${probes.length}`;
  probes.push({ id, rule: named.name, body, contentType: options.contentType ?? "text/plain", filenames: options.filenames ?? [] });
  return id;
};

const files = scratch("detect");
let agent: GoAgent;
const agentRows = new Map<string, AgentRow>();

const detectScan = async (named: ReadonlyArray<{ name: string; detector: GuardDetector }>, items: readonly ScanItem[]): Promise<AgentRow[]> => {
  const list = path.join(files.dir(), "detectors.json");
  writeFileSync(list, JSON.stringify(named));
  const result = await agent.run(["detect-scan", "--detectors", list], items.map((p) => `${JSON.stringify({ id: p.id, contentType: p.contentType, body: p.body, filenames: p.filenames })}\n`).join(""));
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as AgentRow);
};

beforeAll(async () => {
  agent = await buildGoAgent(files.dir());
  for (const row of await detectScan([...namedDetectors.values()], probes)) agentRows.set(row.id, row);
});
afterAll(() => files.dispose());

const agentHit = (id: string): AgentHit | undefined => {
  const probe = probes.find((p) => p.id === id);
  const row = agentRows.get(id);
  if (probe === undefined || row === undefined) throw new Error(`no agent answer for probe ${id}`);
  return row.hits.find((h) => h.name === probe.rule);
};

const IDENTIFIERS = [
  ["tfn", "au-tfn"],
  ["abn", "au-abn"],
  ["acn", "au-acn"],
  ["medicare", "au-medicare"],
  ["card", "card-number"],
] as const;

describe("checksums (Presidio-shaped: the public ATO, ASIC, Medicare and Luhn algorithms)", () => {
  it("the vectors' valid identifiers pass and the invalid ones fail", () => {
    const checks = { tfn: isValidTfn, abn: isValidAbn, acn: isValidAcn, medicare: isValidMedicare, card: isValidLuhn };
    for (const [family] of IDENTIFIERS) {
      for (const v of vectors[family].valid) expect(checks[family](v), `${family} ${v}`).toBe(true);
      for (const v of vectors[family].invalid) expect(checks[family](v), `${family} ${v}`).toBe(false);
    }
  });

  it("Luhn's length bounds: 13 and 19 digits are cards, 12 and 20 are not", () => {
    expect(isValidLuhn("4222222222222")).toBe(true);
    expect(isValidLuhn("6000000000000000004")).toBe(true);
    expect(isValidLuhn("422222222222")).toBe(false);
    expect(isValidLuhn("60000000000000000004")).toBe(false);
  });

  it("Medicare: ten digits, or eleven with the IRN; nine or twelve are not", () => {
    expect(isValidMedicare("2123456701")).toBe(true);
    expect(isValidMedicare("21234567011")).toBe(true);
    expect(isValidMedicare("212345670")).toBe(false);
    expect(isValidMedicare("212345670111")).toBe(false);
  });
});

describe("identifiers in text, in the contract and in the Go agent", () => {
  const prose = IDENTIFIERS.flatMap(([family, kind]) => [
    ...vectors[family].valid.map((value) => ({ value, kind, fires: true })),
    ...vectors[family].invalid.map((value) => ({ value, kind, fires: false })),
  ]).map((c) => {
    const text = `here it is: ${c.value}.`;
    return { ...c, text, id: register({ kind: c.kind }, text) };
  });
  it("every valid identifier vector fires once in prose and every invalid one stays quiet", () => {
    for (const c of prose) {
      expect(runDetector({ kind: c.kind }, { text: c.text })?.count, `${c.kind} ${c.value}`).toBe(c.fires ? 1 : undefined);
      expect(agentHit(c.id)?.count, `agent ${c.kind} ${c.value}`).toBe(c.fires ? 1 : undefined);
    }
  });

  const twoTfns = `my tfn is ${vectors.tfn.valid[0]} and ${vectors.tfn.valid[3]}; not ${vectors.tfn.invalid[0]}`;
  const twoTfnsId = register({ kind: "au-tfn" }, twoTfns);
  it("counts every valid identifier in prose, and only redacted examples travel", () => {
    const m = runDetector({ kind: "au-tfn" }, { text: twoTfns });
    expect(m?.count).toBe(2);
    expect(m?.examples).toEqual(["123***782", "876***210"]);
    expect(JSON.stringify(m)).not.toContain("123 456 782");
    expect(agentHit(twoTfnsId)?.count).toBe(2);
    expect(JSON.stringify(agentRows.get(twoTfnsId))).not.toContain("123 456 782");
  });

  const checksumCases: Array<{ detector: GuardDetector; text: string; count?: number }> = [
    { detector: { kind: "au-tfn" }, text: `tfn ${vectors.tfn.invalid[0]}` },
    { detector: { kind: "card-number" }, text: `card ${vectors.card.invalid[0]}` },
    { detector: { kind: "au-medicare" }, text: `medicare ${vectors.medicare.invalid[1]}` },
    { detector: { kind: "au-abn" }, text: `abn ${vectors.abn.valid[0]}`, count: 1 },
    { detector: { kind: "au-acn" }, text: `acn ${vectors.acn.valid[0]}`, count: 1 },
    { detector: { kind: "au-medicare" }, text: `medicare ${vectors.medicare.valid[0]}`, count: 1 },
    { detector: { kind: "card-number" }, text: `pay with ${vectors.card.valid[0]} or ${vectors.card.valid[3]}`, count: 2 },
  ];
  const checksums = checksumCases.map((c) => ({ ...c, id: register(c.detector, c.text) }));
  it("an invalid checksum is not a match; ABN, ACN, Medicare and cards each fire on their valid vectors", () => {
    for (const c of checksums) {
      expect(runDetector(c.detector, { text: c.text })?.count, c.text).toBe(c.count);
      expect(agentHit(c.id)?.count, `agent ${c.text}`).toBe(c.count);
    }
  });

  const context = (["au-tfn", "au-acn"] as const).flatMap((kind) => {
    const v = vectors.context[kind === "au-tfn" ? "tfn" : "acn"];
    return [
      ...v.fire.map((text) => ({ kind, text, requireContext: true, count: 1 })),
      ...v.quiet.map((text) => ({ kind, text, requireContext: true, count: undefined })),
      ...v.quiet.map((text) => ({ kind, text, requireContext: false, count: 1 })),
    ];
  });
  const far = `TFN below.${" ".repeat(70)}100200300`;
  const contextProbes = [...context, { kind: "au-tfn" as const, text: far, requireContext: true, count: undefined }].map((c) => {
    const detector: GuardDetector = c.requireContext ? { kind: c.kind, requireContext: true } : { kind: c.kind };
    return { ...c, detector, id: register(detector, c.text) };
  });
  it("requireContext: a 3-3-3 number counts only near a context word or in the issuer's grouping; off, every one fires", () => {
    for (const c of contextProbes) {
      expect(runDetector(c.detector, { text: c.text })?.count, `${JSON.stringify(c.detector)} ${c.text}`).toBe(c.count);
      expect(agentHit(c.id)?.count, `agent ${JSON.stringify(c.detector)} ${c.text}`).toBe(c.count);
    }
  });

  const viewCases: Array<{ detector: GuardDetector; text: string; joined?: string[]; count?: number }> = [
    ...vectors.views.fire.map((c) => ({ detector: c.detector as GuardDetector, text: c.text, joined: "joined" in c ? c.joined : undefined, count: c.count })),
    ...vectors.views.quiet.map((c) => ({ detector: c.detector as GuardDetector, text: c.text })),
  ];
  const views = viewCases.map((c) => ({ ...c, id: c.joined === undefined ? register(c.detector, c.text) : undefined }));
  it("the normalised views and the look-alike guards (vectors.views)", () => {
    for (const c of views) {
      expect(runDetector(c.detector, { text: c.text, joined: c.joined ?? [] })?.count, JSON.stringify(c)).toBe(c.count);
      if (c.id !== undefined) expect(agentHit(c.id)?.count, `agent ${JSON.stringify(c)}`).toBe(c.count);
    }
  });

  const runCases: Array<{ detector: GuardDetector; text: string }> = [
    { detector: { kind: "au-tfn" }, text: "order 1234567820 shipped" },
    { detector: { kind: "au-abn" }, text: "ref 518247535561" },
  ];
  const runs = runCases.map((c) => ({ ...c, id: register(c.detector, c.text) }));
  it("a longer digit run is not sliced into an identifier", () => {
    for (const c of runs) {
      expect(runDetector(c.detector, { text: c.text }), c.text).toBeUndefined();
      expect(agentHit(c.id), `agent ${c.text}`).toBeUndefined();
    }
  });

  const dedupe = `tfn 123 456 782, 123-456-782, 876 543 210, ${["100 200 300", "000 000 000"].join(" ")}`;
  const dedupeId = register({ kind: "au-tfn" }, dedupe);
  it("examples are de-duplicated after redaction and capped at three; the count is every match", () => {
    const m = runDetector({ kind: "au-tfn" }, { text: dedupe });
    expect(m?.count).toBe(5);
    expect(m?.examples).toEqual(["123***782", "876***210", "100***300"]);
    expect(agentHit(dedupeId)?.count).toBe(5);
  });

  it("redaction keeps three and three", () => {
    for (const v of vectors.redact) expect(redactMatch(v.in)).toBe(v.out);
  });
});

describe("secrets, in the contract and in the Go agent", () => {
  const fire = vectors.secrets.fire.map((v) => ({ ...v, id: register({ kind: "secret" }, v.text) }));
  const quiet = vectors.secrets.quiet.map((text) => ({ text, id: register({ kind: "secret" }, text) }));
  it("every gitleaks-derived rule fires on its vector and names the rule, never the value", () => {
    expect(SECRET_PATTERNS.map((p) => p.id).sort()).toEqual([...GUARD_SECRET_RULE_IDS].sort());
    for (const v of fire) {
      const m = runDetector({ kind: "secret" }, { text: v.text });
      expect(m?.details, v.rule).toContain(v.rule);
      expect(agentHit(v.id)?.details, `agent ${v.rule}`).toContain(v.rule);
      const secret = v.text.split(/[\s=]/).at(-1) ?? "";
      if (secret.length > 14) {
        expect(JSON.stringify(m), v.rule).not.toContain(secret.slice(8));
        expect(JSON.stringify(agentRows.get(v.id)), `agent ${v.rule}`).not.toContain(secret.slice(8));
      }
    }
    for (const q of quiet) {
      expect(runDetector({ kind: "secret" }, { text: q.text }), q.text).toBeUndefined();
      expect(agentHit(q.id), `agent ${q.text}`).toBeUndefined();
    }
  });

  const all = vectors.secrets.fire.map((v) => v.text).join("\n");
  const narrowedId = register({ kind: "secret", rules: ["jwt"] }, all);
  it("a rule list narrows what fires", () => {
    const m = runDetector({ kind: "secret", rules: ["jwt"] }, { text: all });
    expect(m?.details).toEqual(["jwt"]);
    expect(m?.count).toBe(1);
    expect(agentHit(narrowedId)).toMatchObject({ count: 1, details: ["jwt"] });
  });

  const cap = vectors.secrets.cap;
  const capId = register({ kind: "secret" }, cap.text);
  it("the count is every match, the examples stop at three, each a label and at most six characters", () => {
    const m = runDetector({ kind: "secret" }, { text: cap.text });
    expect(m?.count).toBe(cap.count);
    expect(m?.details).toEqual(cap.details);
    expect(m?.examples).toEqual(cap.examples);
    for (const e of m?.examples ?? []) expect(/\((.{0,6})…\)$/.exec(e)?.[1]?.length ?? 99).toBeLessThanOrEqual(6);
    expect(agentHit(capId)).toMatchObject({ count: cap.count, details: cap.details });
  });
});

describe("bulk addresses, keywords and file types, in the contract and in the Go agent", () => {
  const threshold = vectors.emailBulk.threshold;
  const emailCases: Array<{ detector: GuardDetector; text: string; count?: number }> = [
    { detector: { kind: "email-bulk", threshold }, text: vectors.emailBulk.fire, count: 3 },
    { detector: { kind: "email-bulk", threshold }, text: vectors.emailBulk.quiet },
    { detector: { kind: "email-bulk", threshold: 2 }, text: "a@example.com B@example.com", count: 2 },
    { detector: { kind: "email-bulk", threshold: 3 }, text: "a@example.com B@example.com" },
  ];
  const email = emailCases.map((c) => ({ ...c, id: register(c.detector, c.text) }));
  it("bulk emails: distinct addresses, case-folded, firing at exactly the threshold and not one under", () => {
    for (const c of email) {
      expect(runDetector(c.detector, { text: c.text })?.count, `${JSON.stringify(c.detector)} ${c.text}`).toBe(c.count);
      expect(agentHit(c.id)?.count, `agent ${JSON.stringify(c.detector)} ${c.text}`).toBe(c.count);
    }
  });

  const substring: GuardDetector = { kind: "keyword", keywords: vectors.keyword.keywords, wholeWord: false };
  const whole: GuardDetector = { kind: "keyword", keywords: vectors.keyword.keywords, wholeWord: true };
  const keywordCases: Array<{ detector: GuardDetector; text: string; count?: number }> = [
    { detector: substring, text: vectors.keyword.fire, count: vectors.keyword.fireCount },
    { detector: substring, text: vectors.keyword.quiet },
    { detector: whole, text: vectors.keyword.wholeWord.fire, count: 1 },
    { detector: whole, text: vectors.keyword.wholeWord.quiet },
  ];
  const keyword = keywordCases.map((c) => ({ ...c, id: register(c.detector, c.text) }));
  it("keywords: case-insensitive substrings, or whole words", () => {
    for (const c of keyword) {
      expect(runDetector(c.detector, { text: c.text })?.count, c.text).toBe(c.count);
      expect(agentHit(c.id)?.count, `agent ${c.text}`).toBe(c.count);
    }
  });

  const vectorTypes: GuardDetector = { kind: "file-type", extensions: vectors.fileType.extensions };
  const cornerTypes: GuardDetector = { kind: "file-type", extensions: ["xlsx", "csv"] };
  const GO_COUNTS_LEADING_DOT = ".xlsx";
  const fileFire = register(vectorTypes, "", { filenames: vectors.fileType.fire });
  const fileQuiet = register(vectorTypes, "", { filenames: vectors.fileType.quiet.filter((name) => name !== GO_COUNTS_LEADING_DOT) });
  const corners = ["report.", "xlsx.", "README", "csv"].map((name) => ({ name, id: register(cornerTypes, "", { filenames: [name] }) }));
  const dotted = register(cornerTypes, "", { filenames: ["a.b.CSV"] });
  it("file types: by extension, case-insensitively; a name with no dot or a trailing dot has no extension", () => {
    const m = runDetector(vectorTypes, { filenames: vectors.fileType.fire });
    expect(m?.count).toBe(vectors.fileType.fireCount);
    expect(m?.details?.sort()).toEqual(["csv", "xlsx"]);
    expect(agentHit(fileFire)?.count).toBe(vectors.fileType.fireCount);
    expect(agentHit(fileFire)?.details?.sort()).toEqual(["csv", "xlsx"]);
    expect(runDetector(vectorTypes, { filenames: vectors.fileType.quiet })).toBeUndefined();
    expect(vectors.fileType.quiet).toContain(GO_COUNTS_LEADING_DOT);
    expect(agentHit(fileQuiet)).toBeUndefined();
    for (const c of corners) {
      expect(runDetector(cornerTypes, { filenames: [c.name] }), c.name).toBeUndefined();
      expect(agentHit(c.id), `agent ${c.name}`).toBeUndefined();
    }
    expect(runDetector(cornerTypes, { filenames: ["a.b.CSV"] })?.details).toEqual(["csv"]);
    expect(agentHit(dotted)?.details).toEqual(["csv"]);
    expect(runDetector(cornerTypes, {})).toBeUndefined();
  });

  const leadingDot = register(vectorTypes, "", { filenames: [GO_COUNTS_LEADING_DOT] });
  it("known divergence, follow-up 1 in projects/guard-oss-ci/follow-ups.md: the Go agent counts a leading-dot-only name as that file type", () => {
    expect(runDetector(vectorTypes, { filenames: [GO_COUNTS_LEADING_DOT] })).toBeUndefined();
    expect(agentHit(leadingDot)).toMatchObject({ kind: "file-type", count: 1, details: ["xlsx"] });
  });
});

describe("several detectors over one request", () => {
  const detectors: GuardDetector[] = [{ kind: "au-tfn" }, { kind: "card-number" }, { kind: "file-type", extensions: ["csv"] }, { kind: "keyword", keywords: ["falcon"], wholeWord: true }];
  it("only the detectors that matched answer, in order, and nothing answers for empty input", async () => {
    const text = `tfn 123 456 782 and card ${vectors.card.valid[0]} for Falcon`;
    expect(runDetectors(detectors, { text, filenames: ["q3.csv"] }).map((m) => m.kind)).toEqual(["au-tfn", "card-number", "file-type", "keyword"]);
    expect(runDetectors(detectors, { text: "nothing here", filenames: [] })).toEqual([]);
    expect(runDetectors([], { text: "tfn 123 456 782" })).toEqual([]);
    expect(runDetectors(detectors, {})).toEqual([]);
    const rows = await detectScan(
      detectors.map((detector, i) => ({ name: `rule-${i}`, detector })),
      [
        { id: "all", contentType: "text/plain", body: text, filenames: ["q3.csv"] },
        { id: "none", contentType: "text/plain", body: "nothing here", filenames: [] },
        { id: "empty", contentType: "text/plain", body: "", filenames: [] },
      ],
    );
    expect(rows.map((row) => [row.id, row.hits.map((h) => h.kind)])).toEqual([
      ["all", ["au-tfn", "card-number", "file-type", "keyword"]],
      ["none", []],
      ["empty", []],
    ]);
  });
});

describe("semantic request boundaries (body.vectors.json), in the Go agent and in the contract's detectors", () => {
  const bodies = bodyVectors.map((v) => ({ ...v, id: register(v.detector, v.body, { contentType: v.contentType }) }));
  it("every body vector counts what the vectors say once the agent extracts the request", () => {
    for (const v of bodies) expect(agentHit(v.id)?.count ?? 0, v.name).toBe(v.count);
  });

  const parsedJson = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };
  const flatFields = (value: unknown): DetectorSpan[] | undefined =>
    value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string" || typeof v === "number")
      ? Object.entries(value).map(([label, v]) => ({ text: String(v), label }))
      : undefined;
  const asFlatInput = (v: BodyVector): DetectorInput | undefined => {
    if (v.contentType === "application/json") {
      const spans = flatFields(parsedJson(v.body));
      return spans === undefined ? undefined : { spans };
    }
    if (v.contentType !== "text/plain") return undefined;
    const records = v.body.split("\n").filter((line) => line.trim() !== "").map((line) => flatFields(parsedJson(line)));
    if (records.length > 1 && records.every((r) => r !== undefined)) return { spans: records.flatMap((r) => r ?? []) };
    return /^\s*[[{]/.test(v.body) ? undefined : { text: v.body };
  };
  it("the contract's detectors count every flat body vector the way the vectors say", () => {
    const flat = bodyVectors.flatMap((v) => {
      const input = asFlatInput(v);
      return input === undefined ? [] : [{ ...v, input }];
    });
    expect(flat.map((v) => v.name)).toEqual(
      expect.arrayContaining(["unrelated field cannot lend context", "own string field label is context", "public Sentry project ID is not a card", "decimal fraction is not a PAN", "structured shipping label excludes card lookalike"]),
    );
    for (const v of flat) expect(runDetector(v.detector, v.input)?.count ?? 0, v.name).toBe(v.count);
  });

  const multipart = (fields: Array<[string, string]>): string => `${fields.map(([name, value]) => `--b\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`).join("")}--b--\r\n`;
  const medicare: GuardDetector = { kind: "au-medicare", requireContext: true };
  const siblings = register(medicare, multipart([["title", "Medicare"], ["id", "2123456701"]]), { contentType: "multipart/form-data; boundary=b" });
  const own = register(medicare, multipart([["medicare", "2123456701"]]), { contentType: "multipart/form-data; boundary=b" });
  it("a field's name is context for its own value only, in the contract and in the agent", () => {
    expect(runDetector(medicare, { spans: [{ text: "Medicare", label: "title" }, { text: "2123456701", label: "id" }] })).toBeUndefined();
    expect(runDetector(medicare, { spans: [{ text: "2123456701", label: "medicare" }] })?.count).toBe(1);
    expect(agentHit(siblings)).toBeUndefined();
    expect(agentHit(own)?.count).toBe(1);
  });
});
