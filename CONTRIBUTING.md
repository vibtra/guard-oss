# Contributing to Guard

## Contributor licence agreement

Contributions are made under the [Vibtra Guard Individual Contributor Licence Agreement](CLA.md). It lets the copyright holders (Sam Rahmani and Tyler Stewart until the company is incorporated, then the company) relicense your contribution, so that `ee/` and Vibtra Cloud can stay commercial. You keep the copyright in your work. The agreement is a draft and has not been reviewed by a lawyer yet.

To sign, add this line to the description of your first pull request, with your name and the email address on your commits:

```
I agree to the Vibtra Guard Individual Contributor Licence Agreement, version 0.1 (CLA.md).
Signed-off-by: Your Name <you@example.com>
```

## Where tests go

Every new test goes in one of these places:

- Go agent behaviour: `tests/integration/agent-go/`. These are vitest tests that drive the real agent binary. Do not add a `*_test.go` file under `guard/agent-go`.
- Mac app and extension: `tests/mac/` (Python) and the `VibtraGuardIntegrationTests` target (Swift). Do not add another test target to `guard/mac/project.yml`.
- TypeScript packages and apps: `tests/integration/<area>/`.
- Browser flows: `tests/e2e/`.

Two steps in the `guard` CI job check the first two rules. `test-locations (agent-go)` fails on any `*_test.go` file under `guard/agent-go`. `test-locations (mac)` fails on any test target other than `VibtraGuardIntegrationTests` in the committed `guard/mac/VibtraGuard.xcodeproj`, and the `mac` job fails when that project differs from what xcodegen generates from `project.yml`. The `mac` and `mac-integration` jobs run only when the diff touches the Mac app, and always on the weekly schedule or a manual run with `full` on ([docs/ci.md](docs/ci.md#when-the-mac-jobs-run)). The TypeScript and browser locations are conventions, not enforced: no check fails a test placed somewhere else, so reviewers check them.

Fixtures use made-up data only. Never put real user data, keys or tokens in a test.

## Engines

The Guard agent decides each request through one port, `Engine`, in `guard/agent-go/engine/`. Today's engine is `guard/agent-go/engine/rules`. `guard/agent-go/main.go` chooses the engine on one line:

```text
var eng engine.Engine = rules.New()
```

[guard/agent-go/engine/README.md](guard/agent-go/engine/README.md) shows how to write an engine and swap it in, and gives the full contract.

- Optimisations to `rules` are welcome. Your pull request must pass `engine check --parity` and must show the `engine bench` output before and after the change.
- Other engines stay in forks. Swap them in with the one line in `main.go`. This repository does not take new engines until it has an engine registry and a maintainer for each engine.
- Do not change the proxy files to fit an engine. If an engine needs something the port does not give it, open an issue.
- `golangci-lint` enforces the boundary with two depguard rules: `engines-only-in-main-go` (only `main.go` and `engine/**` import an engine package) and `engine-port-imports-only-stdlib-and-policy` (the port files import only the standard library and `policy`).

To check `rules`, from the repository root:

```sh
go -C guard/agent-go build -o build/vibtra-guard .
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine check --parity
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine bench
```

## Gate checks

These checks run on every pull request. When one fails, a human reviews the pull request.

- `gate-files`: a change to a file listed in `.github/gate-files.txt` needs a human approval.
- `tripwire`: a fixed scan flags removed gate lines, skipped or weakened tests, and new lint suppressions.
- `classifier`: off until the `GATE_CLASSIFIER_API_KEY` secret is set ([docs/ci.md](docs/ci.md#the-classifier-is-off) says how to turn it on). When on, a judge model flags a change that eases a check, adds code without tests, or weakens a test.
- `probe-replay`: runs the default branch's gate probes against the default branch's gate and the pull request's gate, and fails when a probe that the old gate refused is now allowed.

## Test guardrails (VIB-66)

A green suite is only worth something if it fails when the code is wrong. Three checks back that up. `test-weakening` and `mutation` are required checks in `.github/rulesets/main.json`. A path-filtered `mutation` job that skips counts as passing.

### Mutation testing on the security modules

[Stryker](https://stryker-mutator.io/) changes the code in small ways (mutants) and runs the tests against each change. A test suite that still passes against a mutant has a gap. Stryker runs on these modules only:

- `packages/guard-contract/src/signing.ts`: ES256 signing and verification, including the raw P1363 (r||s) signature handling. guard-oss has no separate DER or P1363 helper.
- `packages/guard-contract/src/bundle.ts`, lines 135-146 only: `canonicalJson`, which every signed digest depends on. The rest of the file is zod schemas.
- `apps/registry/src/guard/local-signer.ts`
- `apps/registry/src/vault/seal.ts`
- `apps/registry/src/vault/sealer-ring.ts`

The settings are in `stryker.config.json`. The tests that run against the mutants are listed in `tests/vitest.mutation.config.ts`. That config points `@vibtra/registry` and `@vibtra/guard-contract` at the Stryker sandbox, so the tests import the mutated files and not the originals.

- The run fails when the mutation score is under the `break` threshold (98%, the first score rounded down).
- Every mutant that survives is recorded in `tests/mutation/survivors.json`, with the reason no test can kill it. Today all of them are equivalent mutants: the changed code behaves the same. `scripts/check-mutation-survivors.mjs` fails:
  - when a mutant survives and is not recorded;
  - when a test kills a recorded mutant;
  - when a record has no reason;
  - when a path in the `mutate` list is missing from the report, for example because it was renamed;
  - when the `mutate` list holds a glob instead of explicit paths.

  Prefer a test that kills the mutant over a new record.
- The `mutation` CI job runs when `scripts/mutation-paths.mjs` finds a mutation path in the diff, and always on the weekly schedule or a manual run. Mutation paths are:
  - a mutated module;
  - a test in the mutation config, or a non-test helper next to those tests in `tests/integration/registry/` or `tests/integration/guard-contract/`;
  - the contract suites and their mutant fixtures;
  - `bundle.ts`, `apps/registry/src/errors.ts` or `pnpm-lock.yaml`;
  - a mutation setting.

  If the filter job itself fails, the `mutation` job runs instead of skipping.
- Two tests prove that the contracts kill mutants that once passed every test. `tests/integration/registry/local-signer-race-mutant.test.ts` covers the guard-oss#46 mutant: a racer signs with its fresh key instead of the stored one. `tests/integration/registry/vault-seal-aad-mutant.test.ts` covers an AAD built as `orgId + connectionId`. Each runs its contract against the real module and against the mutant, and expects only the named tests to fail on the mutant.

CI is the reference run. It runs the Postgres-backed tests, so `tests/mutation/survivors.json` must match a run with Postgres. Both commands below refuse to start when `VIBTRA_TEST_DATABASE_URL` is unset. Point it at a disposable Postgres database, as for the integration tests ([docs/ci.md](docs/ci.md)), and run Stryker locally one module at a time. `--partial` lets the check accept a report that covers only some of the listed files:

```sh
export VIBTRA_TEST_DATABASE_URL=postgres://guard:guard@127.0.0.1:5432/guard
pnpm test:mutation --mutate apps/registry/src/vault/seal.ts --concurrency 2
pnpm test:mutation:survivors --partial
```

To explore without Postgres, set `VIBTRA_MUTATION_WITHOUT_POSTGRES=1`. Stryker then runs with a loud warning, and the survivors check still refuses. Never edit `survivors.json` from such a run, because the Postgres tests skip in it. The report is in `reports/mutation/mutation.json`.

A recorded survivor that times out in a run is reported as a warning, listed in the job's step summary, and keeps its record. Stryker counts a timeout as detected, but a timeout does not show that a test kills the mutant. A record fails the check only when a test kills its mutant.

### Weakened tests

The `test-weakening` workflow (`.github/workflows/test-weakening.yml`) runs `scripts/check-test-weakening.mjs` from the default branch on every pull request. It runs on `pull_request_target`, so it starts again whenever the pull request body is edited, and it reads the body from the GitHub API at run time, not from the event. It compares the pull request with its merge base and lists, for test files that already exist on the base:

- every rename or deletion of a test file (renaming `x.test.ts` to `x.test.ts.off` stops the runner from collecting it);
- every removed or changed line that contains `expect(`, `assert`, `toThrow`, `rejects`, `.resolves`, or a matcher call such as `.toBe(` or `.not.toEqual(`;
- every added `.skip`, `.only`, `.todo`, `runIf(`, `skipIf(`, `xit`, `fit`, `XCTSkip`, `t.Skip` or `pytest.mark.skip`;
- every added line that starts with `return`, because an early return skips the rest of a test;
- every added `catch`.

New test files never trigger it.

When the list is not empty, the check fails unless the pull request body has a `## Tests changed` section with a table that names each affected file (the new path for a rename) and gives a reason of at least 20 characters:

```markdown
## Tests changed

| File | Test | Reason |
| --- | --- | --- |
| `tests/integration/registry/made-up.test.ts` | refuses a made-up row | the row shape changed in VIB-00; the new assertion is on line 40 |
```

Edit the body to add the table. The edit starts the check again on the current body. A re-run of an old run also reads the current body.

The script reads the diff line by line, so it cannot judge what a change means. A reviewer must read every rewrite that wraps a test body in `try`/`catch`, moves assertions into a helper, or changes what a test sets up. The `catch` marker only makes sure such a pull request comes with a reason.

To run it locally against `main`:

```sh
node scripts/check-test-weakening.mjs --base origin/main --body-file pr-body.md
```

### Property tests in the sealer contract

`describeVaultSealerContract` in `tests/contracts/vault-sealer.ts` has [fast-check](https://fast-check.dev/) properties:

- For any plaintext (any Unicode string or any byte string) and any orgId and connectionId, `open(seal(x)) == x`, and opening under a different orgId or connectionId fails.
- Opening fails under any other split of the same orgId + connectionId string, so a binding built by plain concatenation fails. A fixed case checks ("ab", "c") against ("a", "bc").

Every sealer that runs the contract runs the properties, so ee/'s KMS sealer gets them too. The runs are seeded with `0x5eed`; set `FC_SEED` to try another seed. A reuser can pass `{ numRuns, nonEmpty }` as the third argument. For example, KmsSealer can lower `numRuns` because each run calls KMS, and can set `nonEmpty: true` when its backend refuses empty values.
