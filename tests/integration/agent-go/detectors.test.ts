import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { vectors } from "@vibtra/guard-contract/vectors";
import { describe, expect, it } from "vitest";
import { jsonLines, runAgentCommand, tempDir, type Json } from "./harness.ts";
import { record, useAgentSuite } from "./running.ts";

const BODY_VECTORS = fileURLToPath(new URL("../../../packages/guard-contract/src/body.vectors.json", import.meta.url));

interface ScanItem {
  readonly id: string;
  readonly contentType: string;
  readonly body: string;
  readonly filenames?: readonly string[];
}

interface NamedDetector {
  readonly name: string;
  readonly detector: Json;
}

const suite = useAgentSuite();

const detectScan = async (detectors: readonly NamedDetector[], items: readonly ScanItem[]): Promise<Map<string, Json>> => {
  const dir = await tempDir(suite.cleanup, "detect");
  const file = path.join(dir, "detectors.json");
  await writeFile(file, JSON.stringify(detectors));
  const result = await runAgentCommand(suite.binary(), ["detect-scan", "--detectors", file], {
    dataDir: path.join(dir, "profile"),
    input: items.map((item) => JSON.stringify(item)).join("\n") + "\n",
  });
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  const rows = jsonLines(result.stdout);
  expect(rows.map((row) => row.id)).toEqual(items.map((item) => item.id));
  return new Map(rows.map((row) => [String(row.id), row]));
};

const hitsOf = (row: Json | undefined): Json[] => {
  const hits = row?.hits;
  if (!Array.isArray(hits)) throw new Error(`a detect-scan row has no hits list: ${JSON.stringify(row)}`);
  return hits.map(record);
};

const countFor = (row: Json | undefined, name: string): number => {
  const hit = hitsOf(row).find((candidate) => candidate.name === name);
  return typeof hit?.count === "number" ? hit.count : 0;
};

const plainText = (text: string): { contentType: string; body: string } =>
  /^\s*[[{]/.test(text) ? { contentType: "application/json", body: JSON.stringify({ text }) } : { contentType: "text/plain", body: text };

describe("detect-scan runs the agent's detectors on the shared contract vectors", () => {
  it("fires on every valid identifier and stays quiet on every invalid one", async () => {
    const kinds: Record<string, string> = { tfn: "au-tfn", abn: "au-abn", acn: "au-acn", medicare: "au-medicare", card: "card-number" };
    const detectors = Object.entries(kinds).map(([name, kind]) => ({ name, detector: { kind } }));
    const cases: { id: string; name: string; valid: boolean; text: string }[] = [];
    for (const name of Object.keys(kinds)) {
      const groups: unknown = (vectors as Record<string, unknown>)[name];
      for (const group of ["valid", "invalid"] as const) {
        const values = record(groups)[group];
        if (!Array.isArray(values)) throw new Error(`the ${name} vectors have no ${group} list`);
        values.forEach((value, index) => cases.push({ id: `${name}/${group}/${index}`, name, valid: group === "valid", text: `here it is: ${String(value)}.` }));
      }
    }
    expect(cases.length).toBeGreaterThan(20);
    const rows = await detectScan(
      detectors,
      cases.map((item) => ({ id: item.id, contentType: "text/plain", body: item.text })),
    );
    for (const item of cases) expect(countFor(rows.get(item.id), item.name) > 0, item.id).toBe(item.valid);
  });

  it("fires each normalised view the expected number of times and keeps look-alikes quiet", async () => {
    const views = vectors.views as unknown as Record<string, { detector: Json; text: string; joined?: string[]; count?: number }[]>;
    const cases = (["fire", "quiet"] as const).flatMap((group) => views[group]?.map((item, index) => ({ ...item, id: `views/${group}/${index}`, group })) ?? []);
    expect(cases.length).toBeGreaterThan(30);
    const items = cases.map((item) => {
      if (item.joined === undefined || item.joined.length === 0) return { id: item.id, ...plainText(item.text) };
      const fragments = item.text.split("\n").filter((line) => line !== "" && line !== "text");
      expect(fragments.join(""), item.id).toBe(item.joined.join(""));
      return { id: item.id, contentType: "application/json", body: JSON.stringify({ messages: [{ content: fragments }] }) };
    });
    const rows = await detectScan(
      cases.map((item) => ({ name: item.id, detector: item.detector })),
      items,
    );
    for (const item of cases) expect(countFor(rows.get(item.id), item.id), item.id).toBe(item.group === "fire" ? item.count : 0);
  });

  it("counts a context-gated identifier only with a context word", async () => {
    const context = vectors.context as unknown as Record<string, Record<string, string[]> | string>;
    const kinds: Record<string, string> = { tfn: "au-tfn", acn: "au-acn", medicare: "au-medicare" };
    const cases = Object.entries(kinds).flatMap(([name]) => {
      const groups = context[name];
      if (groups === undefined || typeof groups === "string") return [];
      return Object.entries(groups).flatMap(([group, texts]) => texts.map((text, index) => ({ id: `context/${name}/${group}/${index}`, name, fire: group === "fire", text })));
    });
    expect(cases.filter((item) => item.fire).length).toBeGreaterThan(5);
    expect(cases.filter((item) => !item.fire).length).toBeGreaterThan(5);
    const rows = await detectScan(
      Object.entries(kinds).map(([name, kind]) => ({ name, detector: { kind, requireContext: true } })),
      cases.map((item) => ({ id: item.id, ...plainText(item.text) })),
    );
    for (const item of cases) expect(countFor(rows.get(item.id), item.name) > 0, item.id).toBe(item.fire);
  });

  it("names the secret rule that fired and stays quiet on look-alike secrets", async () => {
    const secrets = vectors.secrets as unknown as { fire: { rule: string; text: string }[]; quiet: string[] };
    expect(secrets.fire.length).toBeGreaterThan(5);
    const items = [
      ...secrets.fire.map((item, index) => ({ id: `fire/${index}`, ...plainText(item.text) })),
      ...secrets.quiet.map((text, index) => ({ id: `quiet/${index}`, ...plainText(text) })),
    ];
    const rows = await detectScan([{ name: "secret", detector: { kind: "secret" } }], items);
    secrets.fire.forEach((item, index) => {
      const hit = hitsOf(rows.get(`fire/${index}`)).find((candidate) => candidate.name === "secret");
      expect(hit?.details, item.rule).toContain(item.rule);
    });
    secrets.quiet.forEach((_, index) => expect(hitsOf(rows.get(`quiet/${index}`)), `quiet/${index}`).toEqual([]));
  });
});

describe("detect-scan reads request bodies by their structure", () => {
  it("matches the shared semantic body vectors", async () => {
    const body = JSON.parse(await readFile(BODY_VECTORS, "utf8")) as { name: string; contentType: string; body: string; detector: Json; count: number }[];
    expect(body.length).toBeGreaterThan(20);
    const rows = await detectScan(
      body.map((item, index) => ({ name: `vector/${index}`, detector: item.detector })),
      body.map((item, index) => ({ id: `vector/${index}`, contentType: item.contentType, body: item.body })),
    );
    body.forEach((item, index) => expect(countFor(rows.get(`vector/${index}`), `vector/${index}`), item.name).toBe(item.count));
  });

  it("keeps a context word in one multipart field from vouching for a number in another", async () => {
    const split = "--b\r\nContent-Disposition: form-data; name=\"title\"\r\n\r\nMedicare\r\n--b\r\nContent-Disposition: form-data; name=\"id\"\r\n\r\n2123456701\r\n--b--\r\n";
    const together = "--b\r\nContent-Disposition: form-data; name=\"note\"\r\n\r\nMedicare 2123456701\r\n--b--\r\n";
    const rows = await detectScan(
      [{ name: "medicare", detector: { kind: "au-medicare", requireContext: true } }],
      [
        { id: "split", contentType: "multipart/form-data; boundary=b", body: split },
        { id: "together", contentType: "multipart/form-data; boundary=b", body: together },
      ],
    );
    expect(countFor(rows.get("split"), "medicare")).toBe(0);
    expect(countFor(rows.get("together"), "medicare")).toBe(1);
  });

  it("joins split message fragments and reads Gemini's nested form JSON", async () => {
    const nested = encodeURIComponent(JSON.stringify([[["Summarise TFN 123 456 782"]]]));
    const rows = await detectScan(
      [{ name: "tfn", detector: { kind: "au-tfn", requireContext: true } }],
      [
        { id: "split", contentType: "application/json", body: JSON.stringify({ messages: [{ content: [{ text: "TFN 123 45" }, { text: "6 782" }] }] }) },
        { id: "separate-messages", contentType: "application/json", body: JSON.stringify({ messages: [{ content: [{ text: "TFN 123 45" }] }, { content: [{ text: "6 782" }] }] }) },
        { id: "gemini", contentType: "application/x-www-form-urlencoded", body: `f.req=${nested}` },
      ],
    );
    expect(countFor(rows.get("split"), "tfn")).toBe(1);
    expect(countFor(rows.get("separate-messages"), "tfn")).toBe(0);
    expect(countFor(rows.get("gemini"), "tfn")).toBe(1);
  });
});
