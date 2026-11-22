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
- The `mutation` CI job never runs on a pull request: it is slow (about 13 minutes) and re-runs the same tests against every mutant. On a pull request the filter says skip, which GitHub counts as passing. It runs on a push to `main` when `scripts/mutation-paths.mjs` finds a mutation path in the pushed diff, and always on the weekly schedule or a manual run, so a pull request that weakens a security test is caught on `main` and fixed forward. To check a pull request before merging, start the `Guard independent checks` workflow by hand on its branch. Mutation paths are:
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

## Deterministic guardrails (VIB-65)

Review agents caught the same mistakes again and again in [#44](https://github.com/vibtra/guard-oss/pull/44), [#45](https://github.com/vibtra/guard-oss/pull/45), [#46](https://github.com/vibtra/guard-oss/pull/46), guard#186 and guard#187. These checks make them fail CI instead. Each one has a test that proves it fires on a fixture and a test that proves this tree is clean, and each error message says what to do instead. Every exception is in one file per tool, with a reason. An inline `eslint-disable` of a `vibtra/*` rule is refused, and a `//nolint` in Go needs a reason after it.

| Check | Runs in | Exceptions | Why |
| --- | --- | --- | --- |
| 1. Key material (`privateKeyPem`, `sealedPrivateKey`, `createPrivateKey`, `sign`, `createSign`, `generateKeyPair` and `generateKeyPairSync` from `node:crypto`, however it is imported or aliased, and `generateGuardSigningKey`, `signEs256` and `GuardSigningKeyPair` from the guard-contract signing module) stays in the key modules: `vibtra/no-key-material` | `pnpm lint` | `tools/eslint/guardrails.json`; an entry with `only` exempts just the names it lists, so the store row mappers may name `sealedPrivateKey` and nothing else | The service handed out a private key, and the ee context could open local keys ([#46](https://github.com/vibtra/guard-oss/pull/46)). Ask `GuardSigner.sign()` instead. |
| 2. `process.env` is read only in `apps/registry/src/config.ts` and the CLI entry, also through `node:process` imports, aliases and `Reflect.get`: `vibtra/no-process-env`. At boot, the registry refuses an unknown `VIBTRA_*` variable, any `OPENBAO_*` variable, `VIBTRA_KEY_BACKEND`, `VIBTRA_VAULT_KEY` or `VIBTRA_VAULT_KEY_PREVIOUS` outside hosted mode, and `VIBTRA_REGISTRY_URL` (read only by the console's Vite dev server) in hosted mode. The boot check covers `VIBTRA_*` names only: `REGISTRY_*`, `NODE_ENV`, `LOG_LEVEL`, `HOST` and `PORT` are shared with the deploy tooling, the Mac app and the tests, so there is no closed list of them to check against | `pnpm lint`, and `loadRegistryConfig` at boot | `tools/eslint/guardrails.json`; the known variables are `REGISTRY_VIBTRA_VARIABLES` and `OTHER_VIBTRA_VARIABLES` in `config.ts`, plus the names and prefixes the enterprise layer lists in `RegistryEnterprise.knownEnvVariables` (each must start with `VIBTRA_` and name something after it) | `VIBTRA_KEY_BACKEND` was ignored in single mode and `OPENBAO_*` was ignored silently ([#46](https://github.com/vibtra/guard-oss/pull/46)). |
| 3. No hard-coded envelope prefix (a name, a version and a dot, such as `kms.v1.` or `kms-ee.v1.`, anywhere inside a string, a template, a regex literal or a `RegExp` source, also when built as `"kms" + ".v1."` or `` `${name}.v1.` ``) outside the sealers: `vibtra/no-envelope-prefix-literal` | `pnpm lint` | `tools/eslint/guardrails.json` | The tripwire knew only `vault.v1.` and `bao.v1.`, so it missed `kms.v1.` (guard#187). Read `VaultSealer.envelopePrefix` or `envelopePrefixes`. |
| 4. cdk-nag (`AwsSolutionsChecks`) and a KMS IAM rule run on every synth of `infra/`: a KMS action (or `Allow` with `NotAction`) on `"*"`, `key/*` or `alias/*` (plain or through `Fn::Join` or `Fn::Sub`) needs `StringEquals` (or `ForAnyValue:StringEquals`) conditions that pin `kms:KeySpec` and `kms:KeyUsage` to fixed values, and `kms:TagResource` needs `StringEquals` on `aws:RequestTag/<key>` with a fixed value. Key policy statements for the account root (CDK's default key policy) are skipped | every `cdk synth` and the infra tests | `infra/nag-suppressions.json` (no exceptions for the KMS rule) | `TagResource` on `*` let a compromised registry claim any untagged key (guard#187). |
| 5. Migrations: numbers are unique, a new one is numbered above the highest on `origin/main`, and one already on `origin/main` is never edited, renamed or deleted: `scripts/check-migrations.mjs` | `guardrails` CI job | `scripts/check-migrations.allow.json` (the duplicate `0051`) | 0113 and 0114 clashed between parallel branches ([#45](https://github.com/vibtra/guard-oss/pull/45)). |
| 6. golangci-lint on `guard/agent-go` with `forbidigo` (no `http.DefaultClient`, `http.DefaultTransport`, `http.Get`/`Head`/`Post`/`PostForm`, `x509.SystemCertPool`, `InsecureSkipVerify`, no read of the registry address from `device.json` outside `registry_origin.go`, and no call of `untrustedEnrolledRegistry` except at the three marked call sites), `unparam`, `errcheck`, `staticcheck` and `nolintlint`. The `guardrails` job also fails a `//nolint:forbidigo` that is not in the reviewed list in `tests/integration/agent-go/golangci-guardrails.test.ts`, and an `http.Client` with no `Transport` (it falls back to `http.DefaultTransport`): `tools/go-guardrails` | `lint` CI job (`pnpm lint:go`) and `guardrails` CI job | `.golangci.yml` (`(^\|/)registry_origin\.go$` only), a `//nolint:<linter> // reason` on the line, and `tools/go-guardrails/http-client-allow.json` | The agent trusted user-added TLS roots and took the registry address from the editable `device.json` ([#44](https://github.com/vibtra/guard-oss/pull/44)), and an argument went unused after the port (guard#186). |
| 7. knip on `apps/` and `packages/`: no unused file, dependency or export (package-entry exports included), and no export that reaches a package entry (any `exports` key except `./testing` and `./package.json`, directly or through `export *` or `export { } from`) that only tests import (use a `./testing` subpath): `scripts/check-knip.mjs` | `guardrails` CI job | `knip-baseline.json` | Test-only exports reached ee's public index (guard#187). |

The knip baseline records the findings that existed when the check was added. A new finding fails, and so does a baseline entry that knip no longer finds. `node scripts/check-knip.mjs --write-baseline` only removes fixed findings; it never adds one. To accept a new finding, add a new entry by hand with a reason of its own (at least 20 characters). The check compares the baseline with origin/main's (`--base <ref>` picks another ref): a name added to an entry origin/main already has, under the same reason, fails, and so does a new entry that copies a reason from origin/main. The check covers every `exports` key in a package.json except `./testing` and `./package.json`, not only the main entry.

To run the guardrail tests locally (golangci-lint 2.15.0 must be on `PATH` for the Go one):

```sh
pnpm --filter @vibtra/guard-tests exec vitest run --minWorkers=1 --maxWorkers=2 integration/eslint/guardrails.test.ts integration/scripts/check-migrations.test.ts integration/scripts/check-knip.test.ts integration/infra/guardrails.test.ts integration/registry/config-variables.test.ts integration/agent-go/golangci-guardrails.test.ts
```
