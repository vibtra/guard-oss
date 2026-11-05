import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const cli = join(repoRoot, "tools", "coverage", "summary.mjs");

const GO_PROGRAM: Record<string, string> = {
	"go.mod": "module example.test/covprobe\n\ngo 1.21\n",
	"main.go": [
		"package main",
		"",
		"import (",
		'\t"os"',
		"",
		'\t"example.test/covprobe/consts"',
		'\t"example.test/covprobe/text"',
		")",
		"",
		"func classify(n int) string {",
		"\tif n > 2 {",
		'\t\treturn "many"',
		"\t}",
		'\treturn "few"',
		"}",
		"",
		"func unused() int {",
		"\treturn 7",
		"}",
		"",
		"func main() {",
		"\tprintln(classify(len(os.Args)), text.Shout(consts.Greeting))",
		"}",
		"",
	].join("\n"),
	"consts/consts.go": 'package consts\n\nvar Greeting = "hello"\n',
	"text/text.go": [
		"package text",
		"",
		'import "strings"',
		"",
		"func Shout(s string) string {",
		'\treturn strings.ToUpper(s) + "!"',
		"}",
		"",
		"func Whisper(s string) string {",
		"\treturn strings.ToLower(s)",
		"}",
		"",
	].join("\n"),
};

const span = (line: number, from: number, to: number, endLine = line) => ({ start: { line, column: from }, end: { line: endLine, column: to } });
const metric = (covered: number, total: number, pct: number) => ({ covered, total, pct });
const counts = (covered: number, total: number) => ({ covered, total, skipped: 0, pct: 0 });

const registryFile = `${repoRoot}/apps/registry/src/made-up-routes.ts`;
const consoleFile = `${repoRoot}/apps/guard-console/src/made-up-view.ts`;
const wireFile = "/opt/ci/work/guard/guard/packages/console-api/src/made-up-math.ts";

const registryMaps = {
	path: registryFile,
	statementMap: { "0": span(1, 0, 20), "1": span(2, 0, 10), "2": span(2, 11, 20), "3": span(4, 0, 15) },
	fnMap: {
		"0": { name: "listRoutes", decl: span(1, 0, 20), loc: span(1, 0, 20), line: 1 },
		"1": { name: "dropRoute", decl: span(4, 0, 15), loc: span(4, 0, 15), line: 4 },
	},
	branchMap: { "0": { type: "branch", line: 2, loc: span(2, 0, 20), locations: [span(2, 0, 10), span(2, 11, 20)] } },
};

const integrationCoverage = {
	[registryFile]: { ...registryMaps, s: { "0": 1, "1": 0, "2": 1, "3": 0 }, f: { "0": 1, "1": 0 }, b: { "0": [2, 0] } },
	[wireFile]: {
		path: wireFile,
		statementMap: { "0": span(10, 0, 12), "1": span(11, 0, 12), "2": span(12, 0, 12) },
		s: { "0": 5, "1": 5, "2": 0 },
		fnMap: { "0": { name: "add", decl: span(10, 0, 12), loc: span(10, 0, 12), line: 10 } },
		f: { "0": 5 },
		branchMap: {
			"0": { type: "branch", line: 11, loc: span(11, 0, 12), locations: [span(11, 0, 6), span(11, 7, 12)] },
			"1": { type: "branch", line: 12, loc: span(12, 0, 12), locations: [span(12, 0, 6), span(12, 7, 12)] },
		},
		b: { "0": [5, 5], "1": [0, 0] },
	},
};

const integrationSummary = {
	total: { lines: counts(6, 6), statements: counts(7, 7), functions: counts(3, 3), branches: counts(6, 6) },
	[registryFile]: { lines: counts(3, 3), statements: counts(4, 4), functions: counts(2, 2), branches: counts(2, 2) },
	[wireFile]: { lines: counts(3, 3), statements: counts(3, 3), functions: counts(1, 1), branches: counts(4, 4) },
};

const e2eCoverage = {
	[registryFile]: {
		...registryMaps,
		branchMap: { ...registryMaps.branchMap, "1": { type: "branch", line: 2, loc: span(2, 11, 20), locations: [span(2, 11, 20)] } },
		s: { "0": 0, "1": 0, "2": 0, "3": 2 },
		f: { "0": 0, "1": 1 },
		b: { "0": [0, 1], "1": [0] },
	},
	[wireFile]: {
		path: wireFile,
		all: true,
		statementMap: { "0": span(10, 0, 12), "1": span(11, 0, 12), "2": span(12, 0, 12) },
		s: { "0": 0, "1": 0, "2": 0 },
		fnMap: { "0": { name: "(empty-report)", decl: span(10, 0, 12, 12), loc: span(10, 0, 12, 12), line: 10 } },
		f: { "0": 0 },
		branchMap: { "0": { type: "branch", line: 10, loc: span(10, 0, 12, 12), locations: [span(10, 0, 12, 12)] } },
		b: { "0": [0] },
	},
};

const legacySummary = {
	total: { lines: counts(4, 10), statements: counts(5, 12), functions: counts(1, 3), branches: counts(2, 6) },
	[consoleFile]: { lines: counts(4, 10), statements: counts(5, 12), functions: counts(1, 3), branches: counts(2, 6) },
};

const NO_DATA_ROWS = ["| JS | no data |  |  |  |  |", "| Go | no data |  |  |  |  |"];

const writeJson = (file: string, value: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify(value));
};

const tableRows = (markdown: string) => markdown.split("\n").filter((line) => line.startsWith("| JS |") || line.startsWith("| Go |"));

describe("tools/coverage/summary.mjs", () => {
	let work = "";
	let runA = "";
	let runB = "";

	beforeAll(() => {
		work = mkdtempSync(join(tmpdir(), "guard-coverage-"));
		const program = join(work, "program");
		for (const [file, text] of Object.entries(GO_PROGRAM)) {
			mkdirSync(dirname(join(program, file)), { recursive: true });
			writeFileSync(join(program, file), text);
		}
		const binary = join(program, "covprobe");
		execFileSync("go", ["build", "-cover", "-o", binary, "."], { cwd: program, stdio: "pipe" });
		runA = join(work, "runs", "a");
		runB = join(work, "runs", "b");
		for (const [dir, args] of [[runA, []], [runB, ["x", "y"]]] as const) {
			mkdirSync(dir, { recursive: true });
			execFileSync(binary, args, { env: { ...process.env, GOCOVERDIR: dir }, stdio: "ignore" });
		}
	});

	afterAll(() => {
		rmSync(work, { recursive: true, force: true });
	});

	const newCase = () => {
		const dir = mkdtempSync(join(work, "case-"));
		return { dir, input: join(dir, "input") };
	};

	const copyRun = (from: string, to: string, keep: (name: string) => boolean = () => true) => {
		mkdirSync(to, { recursive: true });
		for (const name of readdirSync(from).filter(keep)) copyFileSync(join(from, name), join(to, name));
	};

	const runCli = (dir: string, input: string) => {
		const summary = join(dir, "summary.md");
		const out = join(dir, "summary.json");
		const result = spawnSync(process.execPath, [cli, "--input", input, "--summary", summary, "--out", out], { encoding: "utf8" });
		return { status: result.status, stderr: result.stderr, summary, out };
	};

	it("merges vitest and Go coverage from every artifact folder into one row per area", () => {
		const { dir, input } = newCase();
		writeJson(join(input, "integration", "coverage-final.json"), integrationCoverage);
		writeJson(join(input, "integration", "coverage-summary.json"), integrationSummary);
		writeJson(join(input, "e2e-js", "coverage-final.json"), e2eCoverage);
		writeJson(join(input, "unit-legacy", "coverage-summary.json"), legacySummary);
		copyRun(runA, join(input, "go-cover-a"));
		copyRun(runB, join(input, "nested", "go-cover-b"));
		copyRun(runA, join(input, "go-cover-killed"), (name) => name.startsWith("covmeta."));

		const run = runCli(dir, input);

		expect(run.stderr).toBe("");
		expect(run.status).toBe(0);
		expect(tableRows(readFileSync(run.summary, "utf8"))).toEqual([
			"| JS | apps/guard-console | 40.00% (4/10) | 41.66% (5/12) | 33.33% (1/3) | 33.33% (2/6) |",
			"| JS | apps/registry | 100.00% (3/3) | 75.00% (3/4) | 100.00% (2/2) | 100.00% (3/3) |",
			"| JS | packages/console-api | 66.66% (2/3) | 66.66% (2/3) | 100.00% (1/1) | 50.00% (2/4) |",
			"| JS | **total** | 56.25% (9/16) | 52.63% (10/19) | 66.66% (4/6) | 53.84% (7/13) |",
			"| Go | example.test/covprobe | 72.72% (8/11) | 80.00% (4/5) | n/a | n/a |",
			"| Go | example.test/covprobe/text | 50.00% (3/6) | 50.00% (1/2) | n/a | n/a |",
			"| Go | **total** | 64.70% (11/17) | 71.42% (5/7) | n/a | n/a |",
		]);
		const report = JSON.parse(readFileSync(run.out, "utf8"));
		expect(report.areas).toEqual([
			{ kind: "js", area: "apps/guard-console", files: 1, lines: metric(4, 10, 40), statements: metric(5, 12, 41.66), functions: metric(1, 3, 33.33), branches: metric(2, 6, 33.33) },
			{ kind: "js", area: "apps/registry", files: 1, lines: metric(3, 3, 100), statements: metric(3, 4, 75), functions: metric(2, 2, 100), branches: metric(3, 3, 100) },
			{ kind: "js", area: "packages/console-api", files: 1, lines: metric(2, 3, 66.66), statements: metric(2, 3, 66.66), functions: metric(1, 1, 100), branches: metric(2, 4, 50) },
			{ kind: "go", area: "example.test/covprobe", files: 1, lines: metric(8, 11, 72.72), statements: metric(4, 5, 80), functions: null, branches: null },
			{ kind: "go", area: "example.test/covprobe/text", files: 1, lines: metric(3, 6, 50), statements: metric(1, 2, 50), functions: null, branches: null },
		]);
		expect(report.totals).toEqual({
			js: { files: 3, lines: metric(9, 16, 56.25), statements: metric(10, 19, 52.63), functions: metric(4, 6, 66.66), branches: metric(7, 13, 53.84) },
			go: { files: 2, lines: metric(11, 17, 64.7), statements: metric(5, 7, 71.42), functions: null, branches: null },
		});
		const goPercent = { "example.test/covprobe": 60, "example.test/covprobe/consts": null, "example.test/covprobe/text": 50 };
		expect(report.sources).toEqual([
			{ kind: "js", dir: "e2e-js", file: "coverage-final.json", files: 2 },
			{ kind: "js", dir: "integration", file: "coverage-final.json", files: 2 },
			{ kind: "js", dir: "unit-legacy", file: "coverage-summary.json", files: 1 },
			{ kind: "go", dir: "go-cover-a", counterFiles: 1, percent: goPercent },
			{ kind: "go", dir: "go-cover-killed", counterFiles: 0, skipped: expect.stringContaining("covmeta without covcounters") },
			{ kind: "go", dir: "nested/go-cover-b", counterFiles: 1, percent: goPercent },
		]);
	});

	it("shows no data, not 0%, when the only Go folder has covmeta but no covcounters", () => {
		const { dir, input } = newCase();
		copyRun(runA, join(input, "go-cover-killed"), (name) => name.startsWith("covmeta."));

		const run = runCli(dir, input);

		expect(run.status).toBe(0);
		expect(tableRows(readFileSync(run.summary, "utf8"))).toEqual(NO_DATA_ROWS);
		const report = JSON.parse(readFileSync(run.out, "utf8"));
		expect(report.areas).toEqual([]);
		expect(report.totals).toEqual({ js: null, go: null });
		expect(report.sources).toEqual([{ kind: "go", dir: "go-cover-killed", counterFiles: 0, skipped: expect.stringContaining("covmeta without covcounters") }]);
	});

	it("shows no data rows when the input folder does not exist", () => {
		const { dir } = newCase();

		const run = runCli(dir, join(dir, "absent"));

		expect(run.status).toBe(0);
		expect(tableRows(readFileSync(run.summary, "utf8"))).toEqual(NO_DATA_ROWS);
		expect(JSON.parse(readFileSync(run.out, "utf8"))).toMatchObject({ inputFound: false, sources: [], areas: [], totals: { js: null, go: null } });
	});

	it.each([
		{
			name: "a coverage-final.json that is not JSON",
			arrange: (input: string) => {
				mkdirSync(join(input, "integration"), { recursive: true });
				writeFileSync(join(input, "integration", "coverage-final.json"), "{ not json");
			},
			mention: "integration/coverage-final.json",
		},
		{
			name: "a coverage-summary.json entry without metrics",
			arrange: (input: string) => writeJson(join(input, "unit", "coverage-summary.json"), { [consoleFile]: { lines: 3 } }),
			mention: "unit/coverage-summary.json",
		},
		{
			name: "a Go folder with corrupt covmeta",
			arrange: (input: string) => {
				mkdirSync(join(input, "go-cover-broken"), { recursive: true });
				writeFileSync(join(input, "go-cover-broken", "covmeta.0123456789abcdef"), "not coverage data");
				writeFileSync(join(input, "go-cover-broken", "covcounters.0123456789abcdef.1.1"), "not coverage data");
			},
			mention: "go-cover-broken",
		},
	])("exits 2 and writes no JSON for $name", ({ arrange, mention }) => {
		const { dir, input } = newCase();
		arrange(input);

		const run = runCli(dir, input);

		expect(run.status).toBe(2);
		expect(run.stderr).toContain(mention);
		expect(existsSync(run.out)).toBe(false);
	});

	it("exits 2 when --input is missing", () => {
		const result = spawnSync(process.execPath, [cli], { encoding: "utf8" });

		expect(result.status).toBe(2);
		expect(result.stderr).toContain("--input");
	});
});
