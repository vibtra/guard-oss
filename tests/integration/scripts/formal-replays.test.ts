import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MODEL = "formal/seat-admission";
const read = (file: string): string => readFileSync(path.join(ROOT, file), "utf8");

type Constants = Record<string, string>;

const BOUNDS: Constants = { Owner: "owner", Joiners: "{a, b, c}", Invited: "{a, b}", Twice: "{a}", Retries: "1", Seats: "2", WritesFail: "TRUE" };
const TODAY: Constants = { Accept: '"admit"', Isolation: '"read committed"', NoSeatRow: '"refuse"', SlugJoin: '"admit"' };

const CURRENT: Record<string, { constants: Constants; invariants: string[] }> = {
  current_postgres: {
    constants: { ...BOUNDS, ...TODAY, Impl: '"postgres"', CreateOrg: '"one transaction"' },
    invariants: ["SeatLimit", "OneRowPerPerson", "NoLostInvitation", "FailedAdmissionWritesNothing", "AdmittedMeansMember"],
  },
  current_adapter: {
    constants: { ...BOUNDS, ...TODAY, Impl: '"adapter"', CreateOrg: '"locked"' },
    invariants: ["SeatLimit", "OneRowPerPerson", "AdmittedMeansMember"],
  },
};

const EXPECTED_FAILURES: Record<string, { base: string; rule: string; design: Constants }> = {
  replay_ffa2916_hook: { base: "current_postgres", rule: "SeatLimit", design: { Accept: '"hook"' } },
  replay_f533a2f_slug_join: { base: "current_postgres", rule: "SeatLimit", design: { SlugJoin: '"unchecked"' } },
  replay_76c1f36_snapshot: { base: "current_postgres", rule: "SeatLimit", design: { Isolation: '"repeatable read"' } },
  replay_76c1f36_skip_postgres: { base: "current_postgres", rule: "SeatLimit", design: { NoSeatRow: '"skip"', CreateOrg: '"split"' } },
  replay_76c1f36_skip_adapter: { base: "current_adapter", rule: "SeatLimit", design: { NoSeatRow: '"skip"' } },
  finding_adapter_lost_invitation: { base: "current_adapter", rule: "NoLostInvitation", design: {} },
  finding_adapter_member_after_failure: { base: "current_adapter", rule: "FailedAdmissionWritesNothing", design: {} },
};

const ORDER = ["Owner", "Joiners", "Invited", "Twice", "Retries", "Seats", "Impl", "Accept", "Isolation", "NoSeatRow", "CreateOrg", "SlugJoin", "WritesFail"];

const pinned = (name: string): { expect: string; constants: Constants; checks: string[] } => {
  const current = CURRENT[name];
  if (current !== undefined) return { expect: "pass", constants: current.constants, checks: [`INVARIANTS ${current.invariants.join(" ")}`, "PROPERTIES CanceledStaysCanceled"] };
  const failure = EXPECTED_FAILURES[name];
  if (failure === undefined) throw new Error(`${name}.cfg is not pinned in this test`);
  return { expect: failure.rule, constants: { ...CURRENT[failure.base]?.constants, ...failure.design }, checks: [`INVARIANT ${failure.rule}`] };
};

const expectedText = (name: string): string => {
  const { expect: result, constants, checks } = pinned(name);
  return [`\\* expect: ${result}`, "CONSTANTS", ...ORDER.map((key) => `    ${key} = ${constants[key]}`), "SPECIFICATION Spec", ...checks, ""].join("\n");
};

const differences = (name: string, text: string): string[] => {
  const want = expectedText(name).split("\n");
  const got = text.split("\n");
  return want.flatMap((line, index) => (got[index] === line ? [] : [`line ${index + 1}: expected ${JSON.stringify(line)}, found ${JSON.stringify(got[index] ?? null)}`])).concat(got.length > want.length ? [`${got.length - want.length} extra line(s)`] : []);
};

const coveredPaths = (): string[] =>
  read(`${MODEL}/sync.txt`)
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("commit "))
    .map((line) => line.split(" ")[1] ?? "");

describe("the seat-admission configs (VIB-103: a replay cannot be emptied or deleted and stay green)", () => {
  it("are exactly the two current models, the five replays and the two findings", () => {
    const configs = readdirSync(path.join(ROOT, MODEL)).filter((file) => file.endsWith(".cfg")).map((file) => file.slice(0, -4)).sort();
    expect(configs).toEqual([...Object.keys(CURRENT), ...Object.keys(EXPECTED_FAILURES)].sort());
  });

  it.each([...Object.keys(CURRENT), ...Object.keys(EXPECTED_FAILURES)])("%s has its pinned expect line, bounds, rules, and only its old-design constants changed", (name) => {
    expect(differences(name, read(`${MODEL}/${name}.cfg`))).toEqual([]);
  });

  it("gives each replay at least one constant that differs from today's code", () => {
    for (const { base, design } of Object.values(EXPECTED_FAILURES)) {
      for (const [key, value] of Object.entries(design)) expect(CURRENT[base]?.constants[key]).not.toBe(value);
    }
  });

  it("refuses QA's probe: the snapshot replay with today's isolation and no seats", () => {
    const probe = read(`${MODEL}/replay_76c1f36_snapshot.cfg`).replace('Isolation = "repeatable read"', 'Isolation = "read committed"').replace("Seats = 2", "Seats = 0");
    expect(differences("replay_76c1f36_snapshot", probe)).toEqual([
      'line 8: expected "    Seats = 2", found "    Seats = 0"',
      'line 11: expected "    Isolation = \\"repeatable read\\"", found "    Isolation = \\"read committed\\""',
    ]);
  });
});

describe("the seat-admission sync record", () => {
  it("names a commit and a blob for every covered file", () => {
    expect(read(`${MODEL}/sync.txt`)).toMatch(/^commit [0-9a-f]{40}\n(?:[0-9a-f]{40} \S+\n)+$/);
  });

  it("covers the same files that select the formal job, and the verify skill names the same commit and files", () => {
    const selection = (JSON.parse(read("tests/selection-map.json")) as { areas: Record<string, string[]> }).areas["job:formal"] ?? [];
    expect([...coveredPaths()].sort()).toEqual(selection.filter((glob) => glob !== "formal/**").sort());
    const skill = read(".claude/skills/verify-seat-admission/SKILL.md");
    expect(skill).toContain(`Sync commit: \`${/^commit (\S+)$/m.exec(read(`${MODEL}/sync.txt`))?.[1]}\``);
    for (const file of coveredPaths()) expect(skill).toContain(file);
  });
});
