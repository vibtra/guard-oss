const mode = process.argv[2] ?? "run";
const OVERRIDE = "VIBTRA_MUTATION_WITHOUT_POSTGRES";

if (process.env.VIBTRA_TEST_DATABASE_URL !== undefined && process.env.VIBTRA_TEST_DATABASE_URL !== "") process.exit(0);

const why =
  "VIBTRA_TEST_DATABASE_URL is not set, so the Postgres-backed tests would skip. CI runs them, and CI's result is the one tests/mutation/survivors.json must match. " +
  "Start Postgres and set VIBTRA_TEST_DATABASE_URL (see docs/ci.md or the CI job's service), then run again.";

if (mode === "run" && process.env[OVERRIDE] === "1") {
  console.error(`mutation: WARNING: ${why}`);
  console.error(`mutation: WARNING: ${OVERRIDE}=1 is set, so Stryker runs without Postgres. Use this run to explore only. Do not edit tests/mutation/survivors.json from it.`);
  process.exit(0);
}

console.error(`mutation: refusing to ${mode === "run" ? "run Stryker" : "check survivors"}. ${why}`);
if (mode === "run") console.error(`mutation: to explore without Postgres, set ${OVERRIDE}=1. Do not edit tests/mutation/survivors.json from that run.`);
process.exit(1);
