import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { jsonLines, runAgentCommand, tempDir, type Json } from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const suite = useAgentSuite();

const packs = fileURLToPath(new URL("../../../guard/agent-go/engine/rules/internal/detect/packs/", import.meta.url));

interface PackEntry {
  id: string;
  fire?: string[];
  quiet?: string[];
}

const cases: readonly { rule: string; fire: readonly string[]; quiet: readonly string[] }[] = [
  { rule: "us-ssn-formatted", fire: ["ref 123-45-6789 here"], quiet: ["ref 000-45-6789 here", "ref 123-00-6789 here"] },
  { rule: "us-ssn", fire: ["SSN 123456789", "ssn 123.45.6789"], quiet: ["order 123456789"] },
  { rule: "us-itin", fire: ["ITIN 912701234"], quiet: ["ITIN 123456789"] },
  { rule: "us-routing", fire: ["routing 021000021"], quiet: ["routing 021000022", "order 021000021"] },
  { rule: "us-npi", fire: ["NPI 1234567893"], quiet: ["NPI 1234567890", "order 1234567893"] },
  { rule: "us-mbi", fire: ["member 1EG4-TE5-MK73", "member 1EG4TE5MK73"], quiet: ["member 1SG4-TE5-MK73"] },
  { rule: "au-bsb", fire: ["BSB 062-000"], quiet: ["order 062-000"] },
  { rule: "bank-account", fire: ["account 12345678"], quiet: ["order 12345678"] },
  { rule: "au-ihi", fire: ["ref 8003 6012 3456 7894"], quiet: ["ref 8003 6012 3456 7895", "ref 4111 1111 1111 1111"] },
  { rule: "au-crn", fire: ["CRN 123 456 789A"], quiet: ["ref 123456789"] },
  { rule: "passport", fire: ["passport N1234567", "passport 123456789"], quiet: ["order N1234567", "order 123456789"] },
  { rule: "licence", fire: ["licence 12345678", "driver licence AB123456"], quiet: ["order AB123456", "licence APPROVED"] },
  { rule: "date-of-birth", fire: ["DOB 03/09/1990", "date of birth: 1990-06-03"], quiet: ["invoice dated 03/09/1990"] },
  { rule: "labelled-id", fire: ["tax number 499635310", "Cuban ID 58032566033", "número de identificación tributaria 06281004662882"], quiet: ["order number 499635310", "the tax number field is required"] },
  { rule: "labelled-id-acronym", fire: ["RUC 10632624447", "ruc: 10632624447", "Your RUC please?\nCaller: Yes, it's 10632624447"], quiet: ["Lyon City Run, field of 86033", "the RUC field is required"] },
];

const scan = async (rule: string, texts: readonly string[]): Promise<Map<string, Json>> => {
  const dir = await tempDir(suite.cleanup, "pii");
  const file = path.join(dir, "detectors.json");
  await writeFile(file, JSON.stringify([{ name: rule, detector: { kind: "identifiers", rules: [rule] } }]));
  const result = await runAgentCommand(suite.binary(), ["detect-scan", "--detectors", file], {
    dataDir: path.join(dir, "profile"),
    input: texts.map((body, index) => JSON.stringify({ id: String(index), contentType: "text/plain", body })).join("\n") + "\n",
  });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return new Map(jsonLines(result.stdout).map((row) => [String(row.id), row]));
};

const fired = (row: Json | undefined, rule: string): boolean => {
  const hits = row?.hits;
  if (!Array.isArray(hits)) throw new Error(`a detect-scan row has no hits list: ${JSON.stringify(row)}`);
  return hits.map(record).some((hit) => hit.name === rule && typeof hit.count === "number" && hit.count > 0);
};

const expectExamples = async (rule: string, fire: readonly string[], quiet: readonly string[]): Promise<void> => {
  const texts = [...fire, ...quiet];
  const rows = await scan(rule, texts);
  texts.forEach((text, index) => expect(fired(rows.get(String(index)), rule), `${rule}: ${text}`).toBe(index < fire.length));
};

describe("the identifier pack, on values from public specs", () => {
  it.each(cases)("$rule fires on its shapes and stays quiet on look-alikes", async ({ rule, fire, quiet }) => {
    await expectExamples(rule, fire, quiet);
  });

  it("every world entry fires on its own examples and stays quiet on its look-alikes", async () => {
    const entries = JSON.parse(await readFile(path.join(packs, "world.json"), "utf8")) as PackEntry[];
    expect(entries.length).toBeGreaterThan(200);
    for (const entry of entries) await expectExamples(entry.id, entry.fire ?? [], entry.quiet ?? []);
  }, 600_000);

  it("reads a number in a person's record only when its check is strong", async () => {
    await expectExamples("mk-embg", ["Elena Petrova,Sales,Skopje,3012969349590"], ["Elena Petrova,Sales,Skopje,3012969349591", "Order 3012969349590 for Elena Petrova shipped"]);
  });

  it("reads a label across markup, chat turns and a value on its own line", async () => {
    await expectExamples(
      "labelled-id",
      [
        '<label for="f1">tax number</label>\n<input id="f1" type="text" value="499635310" />',
        "[10:42] ana: what's her tax number? the form needs it\n[10:43] tom: 499635310",
        "You asked for the tax number, so here you go:\n499635310",
      ],
      ["Order 499635310 shipped"],
    );
  });

  it("does not read a label in a table header as naming another column", async () => {
    await expectExamples("labelled-id", ['name,"tax number"\nAna,499635310'], ['name,"tax number"\n499635310,']);
  });

  it("does not read a work number near a label as an identifier", async () => {
    await expectExamples("labelled-id", [], ["You asked for the tax number. Ticket:\n499635310"]);
  });

  it("does not read an epoch timestamp beside a name as an identifier", async () => {
    await expectExamples("mk-embg", [], ["Elizabeth Lee pushed at 1508837722656"]);
  });

  it("reports examples without the whole value", async () => {
    const rows = await scan("us-ssn-formatted", ["ref 123-45-6789 here"]);
    expect(JSON.stringify(rows.get("0"))).not.toContain("123-45-6789");
  });
});
