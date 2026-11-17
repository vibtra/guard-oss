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

A green suite is only worth something if it fails when the code is wrong. Three checks back that up.

### Mutation testing on the security modules

[Stryker](https://stryker-mutator.io/) changes the code in small ways (mutants) and runs the tests against each change. A test suite that still passes against a mutant has a gap. Stryker runs on these modules only:

- `packages/guard-contract/src/signing.ts`: ES256 signing and verification, including the raw P1363 (r||s) signature handling. guard-oss has no separate DER or P1363 helper.
- `apps/registry/src/guard/local-signer.ts`
- `apps/registry/src/vault/seal.ts`
- `apps/registry/src/vault/sealer-ring.ts`

The settings are in `stryker.config.json`. The tests that run against the mutants are listed in `tests/vitest.mutation.config.ts`. That config points `@vibtra/registry` and `@vibtra/guard-contract` at the Stryker sandbox, so the tests import the mutated files and not the originals.

- The run fails when the mutation score is under the `break` threshold (98%, today's score rounded down).
- Every mutant that survives is recorded in `tests/mutation/survivors.json`, with the reason no test can kill it. Today all of them are equivalent mutants: the changed code behaves the same. `scripts/check-mutation-survivors.mjs` fails when a mutant survives and is not recorded, when a recorded mutant no longer survives, and when a record has no reason. Prefer a test that kills the mutant over a new record.
- The `mutation` CI job runs only when a mutated module, one of its tests, the contract suites or the mutation settings change, and on the weekly schedule or a manual run.
- `tests/integration/registry/local-signer-race-mutant.test.ts` proves that the GuardSigner contract's race test kills the guard-oss#46 mutant (a racer signs with its fresh key instead of the stored one). It runs the contract against the real LocalSigner and against that mutant, and expects only the race test to fail on the mutant.

To run Stryker locally, take one module at a time:

```sh
pnpm test:mutation --mutate apps/registry/src/vault/seal.ts --concurrency 2
pnpm test:mutation:survivors
```

The report is in `reports/mutation/mutation.json`. Postgres tests skip without `VIBTRA_TEST_DATABASE_URL`, locally and in the CI job, so the score is the same in both places.

### Weakened tests

The `test-weakening` CI job runs `scripts/check-test-weakening.mjs` on every pull request. It compares the pull request with its merge base and lists, in test files that already exist on the base:

- every removed or changed line that contains `expect(`, `assert`, `toThrow` or `rejects`, and
- every added `.skip`, `.only` or `.todo` (also `skipIf`, `xit`, `fit`, `XCTSkip`, `t.Skip` and `pytest.mark.skip`).

New test files never trigger it. A deleted test file counts as removed assertions.

When the list is not empty, the check fails unless the pull request body has a `## Tests changed` section with a table that names each affected file and gives a reason:

```markdown
## Tests changed

| File | Test | Reason |
| --- | --- | --- |
| `tests/integration/registry/made-up.test.ts` | refuses a made-up row | the row shape changed in VIB-00; the new assertion is on line 40 |
```

After you edit the body, re-run the job. Editing the body does not start a new run. A manual (`workflow_dispatch`), push or scheduled run has no pull request body, so the check is skipped and the job log says so.

To run it locally against `main`:

```sh
node scripts/check-test-weakening.mjs --base origin/main --body-file pr-body.md
```

### Property test in the sealer contract

`describeVaultSealerContract` in `tests/contracts/vault-sealer.ts` has a [fast-check](https://fast-check.dev/) property: for any plaintext (any Unicode string or any byte string) and any orgId and connectionId, `open(seal(x)) == x`, and opening under a different orgId or connectionId fails. Every sealer that runs the contract runs the property, so ee/'s KMS sealer gets it too.
