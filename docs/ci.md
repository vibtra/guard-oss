# CI

Every pull request runs three layers of checks: the gate-file gate, the easing checks, then normal CI. [README.md](../README.md#ci) has the overview. This page lists each required check, what it checks, where its script lives and how to run it locally. `.github/rulesets/main.json` lists the same check names as required, except `classifier` while it is off.

## Layer 1: gate files

| Check | Workflow | Script | What it checks |
|---|---|---|---|
| `gate-files` | `gate-files.yml` | `.github/gate/gate-files.mjs` | Fails when the diff changes a path in `.github/gate-files.txt`, until a gate approver approves the head commit. It also checks that the pull request's `.github/CODEOWNERS` matches the list and `.github/gate-approvers.txt`. |

Every gate and every `ci.yml` job that diffs a pull request takes its base from `.github/actions/pr-base`. `scripts/check-workflow-base.mjs` fails on any other read of the base. See [CONTRIBUTING.md](../CONTRIBUTING.md#deterministic-guardrails-vib-65), check 8.

## Layer 2: easing checks

| Check | Workflow | Script | What it checks |
|---|---|---|---|
| `tripwire` | `easing-tripwire.yml` | `.github/gate/tripwire.mjs` | A fixed scan, with no model, of gate files and the test files in `.github/gate/test-files.txt`. It flags removed gate lines, `\|\| true`, `continue-on-error`, `if: false`, skip and only markers, widened ignore patterns, raised thresholds or timeouts, removed assertions, tests turned into no-ops, and new lint suppressions in any file. |
| `classifier` (off) | `easing-classifier.yml` | `.github/gate/classifier/classify.mjs` (prompt `prompt.md`, model `model.json`) | Off until `GATE_CLASSIFIER_API_KEY` is set. When on, a judge model answers three questions: does the change ease a gate or check, does added code come without tests, does it weaken a test. Any yes, a bad answer, a failed call or a missing key escalates. It never clears a pull request. See [The classifier is off](#the-classifier-is-off). |
| `probe-replay` | `gate-replay.yml` | `.github/gate/probe-replay.mjs` | When the pull request changes `.github/gate/` or `.github/gate-files.txt`, the `replay` job runs the default branch's probes through the default branch's gate scripts and the pull request's gate scripts. A probe that the old scripts refuse and the new ones allow is a loosening. `probe-replay` reads that verdict. |
| `test-weakening` | `test-weakening.yml` | `scripts/check-test-weakening.mjs` | Runs on `pull_request_target`, including body edits, with the default branch's script and the body read from the GitHub API at run time. It fails when an existing test file is renamed or deleted, loses or changes an assertion, or gains a skip, only, todo, early `return` or `catch`, unless the body has a `## Tests changed` table with a reason for each file. It is separate from the approval gate: an approval does not pass it. See [CONTRIBUTING.md](../CONTRIBUTING.md#weakened-tests). |

If one of these flags the pull request, the check fails until a gate approver approves the head commit.

## Layer 3: normal CI

All of these are jobs in `.github/workflows/ci.yml`.

| Check | What it checks |
|---|---|
| `gates` | Waits up to 15 minutes for the three gate checks (`gate-files`, `tripwire`, `probe-replay`) on the head commit. It fails unless `tripwire` concluded `success`. It is a required check, so a pull request cannot merge without it. The jobs below do not wait for it, except `mutation`: they start at once, so a pull request gets its test results while it waits for a gate approval. |
| `lint` | `eslint .` (with the no-comments rule and the fences), `lint:comments` over every language, `lint:fences`, and golangci-lint on `guard/agent-go`. |
| `formal` | TLC checks the TLA+ models in `formal/`, with `tla2tools.jar` v1.7.4 pinned by SHA-256 in `formal/check.sh`. Each config names its expected result: the model of today's code passes, and each replay of a past bug and each open finding still breaks the rule it names. It also fails when a file the model covers differs from its blob in `formal/seat-admission/sync.txt`, so a change to that code must re-check the model and move the sync (`formal/check.sh --sync`). [verify-seat-admission](../.claude/skills/verify-seat-admission/SKILL.md) says what the seat-admission model covers and how to keep it in step with the code. |
| `guard` | Typecheck, build, the `test-locations (agent-go)` and `test-locations (mac)` steps, `go vet` and `go build` on the agent, the Go agent end-to-end run, `verify-independent`, and the licence boundary and manifest. |
| `changes` | Not required. Decides whether the diff touches the Mac app, so that `mac` and `mac-integration` run only when it does, and whether it touches the landing page, so that `landing` runs only when it does. See [When the Mac jobs run](#when-the-mac-jobs-run) and [When the landing job runs](#when-the-landing-job-runs). |
| `mac` | `guard/mac/VibtraGuard.xcodeproj` matches what xcodegen 2.46.0 generates from `project.yml`, and the unsigned app builds. Runs only when `changes` says so. |
| `landing` | Not required yet. Builds `apps/landing` and runs `verify:landing` against `dist` in Playwright's Chromium, then uploads the screenshots as `landing-shots` for design review. Runs only when `changes` says so. |
| `integration` | Passes when all six `integration-shard` jobs and `rust-agent` pass. It merges the shards' vitest blob reports into one result and one coverage report, and fails unless every file under `tests/integration/` ran in exactly one shard. |
| `integration-shard (1)` to `(6)` | `vitest run integration/ --shard=N/6` with coverage, each against its own Postgres 16. `tests/support/duration-sequencer.ts` splits the files by their measured times in `tests/test-durations.json`, so each shard gets about the same work. |
| `rust-agent` | `cargo test --tests --locked` for the Rust agent in `guard/agent`. |
| `e2e-providers (openai-api)`, `(chatgpt)`, `(anthropic)`, `(gemini)` | One job per provider: a real Go agent against a local fake upstream that replays made-up traffic. An allowed request is forwarded, a blocked one gets a 403, and an exception grant goes through. |
| `e2e-console` | Passes when all four `e2e-console-shard` jobs pass. Each shard runs `playwright test --shard=N/4` in Chromium against its own registry. |
| `e2e-capture-matrix` | Not required. curl (HTTP/1.1 and HTTP/2), Python requests and urllib, Node and headless Chrome each send their ClientHello to a local TLS origin directly and through the built Go agent. The hello shape and the negotiated HTTP version must match, and a POST carrying a TFN gets a 403 `GUARD_BLOCKED` without reaching the origin. A missing client fails the job. |
| `mac-integration` | `tests/mac/run.sh` on `macos-latest`: the Python tests in `tests/mac/` and the `VibtraGuardIntegrationTests` scheme. Runs only when `changes` says so. |
| `coverage` | Merges the integration and provider coverage with `tools/coverage/summary.mjs` into one report. It has no thresholds. |

A new commit on a branch cancels that branch's run still in progress, whether the run came from the pull request or a manual dispatch. Runs on `main` are never cancelled, so every commit on `main` gets a full result.

### When the Mac jobs run

`mac` and `mac-integration` run on `macos-latest`, which GitHub bills at 10 times the Linux rate. The `changes` job runs them only when one of these paths changed:

- `guard/mac/**` and `tests/mac/**`: the app, its xcodegen inputs (`project.yml`, `Config/`), `build.sh` and the tests;
- any `*.swift` file, any `*.xcodeproj/**` and any `project.yml`;
- `guard/agent-go/build.sh` and `guard/agent-go/go.mod`: both jobs build the agent with them;
- `guard/LICENSE`, `guard/NOTICE` and `guard/agent-go/THIRD_PARTY_NOTICES.txt`: the app build copies them into the app;
- `.github/workflows/ci.yml`.

A pull request compares its merge base with its head. `.github/actions/pr-base` finds that merge base from the tip of the pull request's current base branch, read from the GitHub API. A push to `main` compares the commit before the push with the new one. Matching ignores case. Other Go agent changes do not start the Mac jobs, even though both jobs build the agent and `mac-integration` drives it. For those changes the weekly run is the only Mac check. After an agent change to the local API the app uses (`AgentClient.swift`), start a manual run. A Mac pull request that fails on code it did not touch may be failing on a recent agent change. When the Mac jobs do not run, they show as skipped, which satisfies the required checks.

The Mac jobs always run on the weekly schedule (Sunday 17:00 UTC) and on a manual run (Actions, then "Guard independent checks", then "Run workflow", with `full` left on). They also run when `changes` cannot tell: the first push of a branch, a base commit that is not in the checkout, or a failed `changes` job (their `if` starts with `!cancelled()`, so a failed `changes` does not skip them).

The tripwire flags every removed or edited line in `ci.yml`, but it cannot see a filter weakened only by added lines. Examples are a `decide false "..."` line added to the `changes` step, or a new `case` branch that returns 1 ahead of the Mac patterns. Either one turns the Mac jobs off without a tripwire finding. gate-files still flags any `ci.yml` change. A gate approver reading a `ci.yml` diff should check every change to the `changes` step against the list above.

### When the landing job runs

The same `changes` step decides it, on the same events and with the same fallbacks
as the Mac jobs (schedule, a manual run with `full` on, a first push, an unknown
base or a failed `changes` job all run it). Its paths are:

- `apps/landing/**`: the page, its stylesheets, modules and `verify-landing.mjs`;
- `packages/ui/**`: the page restates the console's tokens, so a token change can
  move the layout;
- `guard/mac/project.yml`: `verify:landing` checks the hero's "macOS 14 or later"
  line against `MACOSX_DEPLOYMENT_TARGET`;
- `.github/workflows/ci.yml`.

A docs-only change does not run it. When it does not run it shows as skipped.

## Test selection (shadow mode)

`tests/selection-map.json` says which files can change the result of each test area: an `integration/<folder>` or a `job:<name>`. `scripts/select-tests.mjs` reads a diff and decides what that diff could affect:

- A change to a `global` path (lockfile, root and test config, `ci.yml`, `tests/support/`, `packages/guard-contract/`) runs everything.
- A change to an area's path runs that area. A path can select several areas.
- A `lintOnly` path (docs and Markdown) runs no test area, unless an area also lists it. For example, `integration/infra` lists `docs/self-host.md`.
- A changed path that matches nothing runs everything. A file nobody mapped costs time, never a skipped test.
- `always` areas run whatever changed, because their tests read the whole tree.

For now the `selection` job only reports what it would run, in the step summary, and every job still runs. Selection will skip work only after the merge queue runs the full suite before anything reaches `main`, and after a traced run confirms the map lists every file each area reads. `--check-map` fails when a glob matches no tracked file or an integration test folder has no area. `tests/integration/scripts/select-tests.test.ts` pins the rules, for example that a Go-only change selects the agent tests.

```sh
node scripts/select-tests.mjs --base origin/main --head HEAD
```

The `Selection audit` workflow (nightly, on dispatch and on pull requests that change the map) runs each integration area alone while `fatrace` records every file any process opens, and fails when an area opened a tracked file the map does not declare for it, naming the file and the process. It builds Go with `-buildvcs=false`, because `go build` otherwise runs `git status`, which reads most of the tree without the tests depending on it. A test that runs git itself still shows up.

## Run the checks locally

The gate checks read a diff from the merge base, as CI does. `<base>` is the pull request's base branch (`main` for most):

```sh
git diff origin/<base>...HEAD > /tmp/pr.diff
node .github/gate/gate-files.mjs --diff /tmp/pr.diff         # exit 0 clear, 1 gated
node .github/gate/tripwire.mjs --diff /tmp/pr.diff           # exit 0 clean, 1 flagged
node .github/gate/classifier/classify.mjs --diff /tmp/pr.diff --dry-run   # no model call, no key needed
```

Without `--dry-run`, `classify.mjs` calls the model with `GATE_CLASSIFIER_API_KEY` and spends money. Without the key it exits 3.

Typecheck with `pnpm typecheck` (TypeScript 7, the same as CI) or `pnpm typecheck:local` (tsrs, a faster port of the TypeScript 7 checker, for local use only). Both check the seven projects in `scripts/typecheck.mjs` at the same time. `tests/` and `tools/no-comments/` keep TypeScript 5 as a dependency, because their code imports the TypeScript compiler API.

`probe-replay` needs a checkout of the default branch as the old side:

```sh
git worktree add /tmp/guard-main origin/main
node /tmp/guard-main/.github/gate/probe-replay.mjs --old /tmp/guard-main --new . --probes /tmp/guard-main/.github/gate/probes
```

Each gate script has a self-test:

```sh
node .github/gate/gate-files.mjs --probes .github/gate/probes/gate-files
node .github/gate/tripwire.mjs --probes .github/gate/probes/tripwire
node .github/gate/classifier/selftest.mjs
node .github/gate/probe-replay.mjs --selftest
pnpm --filter @vibtra/guard-tests exec vitest run integration/gate/
```

The `integration` job runs all of these self-tests through `tests/integration/gate/`. None of them needs `GATE_CLASSIFIER_API_KEY`: the classifier self-test talks to a local fake model.

Normal CI, job by job:

| Job | Command |
|---|---|
| `lint` | `pnpm lint`, `pnpm lint:comments`, `pnpm lint:fences`, `pnpm lint:go` (golangci-lint v2.15.0) |
| `formal` | `formal/check.sh`, or `formal/check.sh formal/seat-admission/<config>.cfg` for one config (needs Java 11 or later and curl; the first run downloads and checks the jar) |
| `guard` | `pnpm typecheck`, `pnpm build`, `node scripts/check-test-locations.mjs`, `pnpm guard:agent:check`, `pnpm guard:go:e2e`, `node scripts/check-mac-test-targets.mjs`, `node scripts/verify-independent.mjs`, `pnpm licence:boundary`, `pnpm licence:manifest --check` |
| `mac` | `(cd guard/mac && xcodegen generate)`, then `git status guard/mac/VibtraGuard.xcodeproj` shows no change; `zsh guard/mac/build.sh --unsigned` |
| `integration` | `pnpm test` (set `VIBTRA_TEST_DATABASE_URL` to a disposable Postgres database for the database cases); `cargo test --tests --locked` in `guard/agent` |
| `e2e-providers` | `pnpm --filter @vibtra/guard-tests exec vitest run e2e/providers/<provider>/` |
| `e2e-console` | `pnpm --filter @vibtra/guard-tests exec playwright install chromium`, then `pnpm --filter @vibtra/guard-tests test:e2e:browser` |
| `e2e-capture-matrix` | `pnpm --filter @vibtra/guard-tests exec vitest run e2e/agent-go/` (needs curl, python3 with `requests`, and Chrome; set `GUARD_MATRIX_CHROME` to use a Chrome binary that is not in the default place) |
| `landing` | `pnpm --filter @vibtra/landing exec playwright install --with-deps chromium`, then `pnpm --filter @vibtra/landing build` and `pnpm --filter @vibtra/landing verify:landing` (set `SHOTS` to choose where the screenshots go) |
| `mac-integration` | `zsh tests/mac/run.sh` (macOS only) |
| `coverage` | `node tools/coverage/summary.mjs --input <folder of coverage output>` |

### Refresh the shard timings

`tests/test-durations.json` holds each integration test file's time in milliseconds. The shards stay correct when it is stale, because a file missing from it is given the median time and `integration` checks that each file ran exactly once. They just get less even. To refresh it, download the `integration-report` artifact from a green run on `main` and run:

```sh
node scripts/test-durations.mjs integration-report.json
```

### Run the Go agent tests under the race detector

Set `GUARD_AGENT_RACE=1` to run the agent tests against a build with Go's race detector:

```sh
GUARD_AGENT_RACE=1 corepack pnpm@10.11.0 --filter @vibtra/guard-tests exec vitest run integration/agent-go/
```

The tests then build the agent with `GOFLAGS=-race zsh guard/agent-go/build.sh <path>` into their own temporary folder, so `guard/agent-go/build/vibtra-guard` is left alone. `GOFLAGS` you set yourself is kept, and `GUARD_AGENT_COVERDIR` adds `-cover`. Every agent the tests start gets `GORACE="halt_on_error=1 exitcode=66"`, so the first data race stops the agent and the test that hit it fails. The race report is in the agent log the failing test prints. Set `GORACE` yourself to change this. CI does not run this mode.

`zsh guard/agent-go/build.sh` with no argument still builds `guard/agent-go/build/vibtra-guard`. An argument names a different output file.

## The classifier is off

The `classifier` check is off until the repository has a `GATE_CLASSIFIER_API_KEY` secret. Its files stay in the repository so it can be turned back on:

- `easing-classifier.yml` runs only on `workflow_dispatch`, so it never runs on a pull request.
- The `gates` job in `ci.yml` does not wait for it.
- `.github/rulesets/main.json` does not list it as a required check.
- `tripwire`, `gate-files` and `probe-replay` stay on and required.
- `tests/integration/gate/classifier.test.ts` still runs the classifier self-test and a dry run, with no key.

To turn it on, in one pull request that a gate approver approves:

1. Set the secret: `gh secret set GATE_CLASSIFIER_API_KEY -R vibtra/guard`. Check that the model id in `.github/gate/classifier/model.json` is still valid.
2. In `easing-classifier.yml`, set the trigger back to `pull_request` with `types: [opened, synchronize, edited]`.
3. In the `gates` job of `ci.yml`, add `classifier` to `checks`, `easing-classifier.yml` to `workflows` and a fourth `-` to `states`, and make the job fail when `classifier` concludes anything but `success`, as it does for `tripwire`.
4. Add `{ "context": "classifier", "integration_id": 15368 }` back to the required checks in `.github/rulesets/main.json`.
5. Change the "classifier is off" cases in `tests/integration/gate/classifier.test.ts` and `tests/integration/gate/gates-job.test.ts` to expect it on.

## Approval covers one head SHA

A gate approver is a login in `.github/gate-approvers.txt` who is not the pull request's author. To pass a gated or flagged pull request, the approver reviews the change, approves the pull request at its current head, and re-runs the failed check (Re-run jobs, then Re-run failed jobs). For `gate-files`, `tripwire` and `probe-replay`, the re-run uses the default branch's workflow. For `classifier`, it uses the pull request's workflow with the default branch's scripts. Each re-run reads the approval again with `.github/gate/approval.mjs`.

The approval counts only for the exact head SHA it was given on. Any new push, including a merge from the base branch, makes a new head. The checks then fail again and need a new approval and a new re-run.

## Merge order

1. The three gate checks run on the pull request.
2. `gates` waits for them. The normal CI jobs run at the same time, not after `gates`; only `mutation` waits for it. `coverage` needs `integration` and `e2e-providers`.
3. When every required check passes on its head and a code owner has approved, the pull request joins the merge queue. The branch does not need to be up to date with `main`.
4. The merge queue builds a temporary commit: `main`, plus the pull requests ahead in the queue, plus this one. `ci.yml` runs on it (the `merge_group` event) with no filters: the Mac jobs and `mutation` always run. `main` moves only when every required check passes on that commit. If one fails, the pull request leaves the queue and `main` does not change.
   - The gate workflows (`gate-files`, `tripwire`, `probe-replay`, `test-weakening`) also start on `merge_group`, but their jobs skip, which counts as passing. They already passed on the pull request head, against the default branch's workflow, and a skipped required check does not leave the queue waiting.
   - The queue rule is in `.github/rulesets/main.json`: squash merge, up to 3 groups built at once, up to 5 pull requests per group, a 1-minute wait to fill a group, a 30-minute limit for the checks.
5. Every pull request is squash-merged by the queue, stacked ones included. Merge the lower pull request first, then rebase the one above it onto `main` (`git rebase --onto origin/main <old base>`), since the squash gives the lower one's commits new SHAs.

## The ruleset is applied

`.github/rulesets/main.json` is only a file. GitHub enforces it only after a repo admin applies it, and until then every required check above is advisory. The `ruleset-drift` workflow (`.github/workflows/ruleset-drift.yml`, script `scripts/check-ruleset-drift.mjs`) reads the rules GitHub enforces on `main` and compares them with the file: the rule types, merge queue on or off, each required check with the app that must report it (`integration_id`), and each plain parameter the file sets. It then reads each ruleset those rules come from (`GET /repos/<repo>/rulesets/<id>`) and compares its `enforcement`, `conditions` and `bypass_actors` with the file. On a difference it fails and names both sides.

The script has four results. Exit 0: everything it could read matches. Exit 1: the rules differ. Exit 2: it could not compare, because a GitHub API call failed. Exit 3: `RULESET_DRIFT_TOKEN` is set but cannot read the bypass actors.

Bypass actors need their own token. GitHub returns `bypass_actors` only to a caller with write access to the ruleset, and the job token has no `administration` permission. Measured with a non-admin token on four public rulesets: `enforcement` and `conditions` come back, `bypass_actors` is missing. Without `RULESET_DRIFT_TOKEN`, the script compares everything else, emits a `::warning::` that bypass actors were not compared, and does not fail on that alone. With it set, the script uses it for every call and fails with exit 3 if the bypass actors are still missing. On `main`, the job runs in the `ruleset-drift` environment, so the secret can live there. Pull request runs get no environment.

Tyler must test which token works, after the ruleset is applied:

1. Make a fine-grained token for this repo only, with Administration: read-only. Run `RULESET_DRIFT_TOKEN=<token> node scripts/check-ruleset-drift.mjs --repo vibtra/guard-oss`. Exit 1 means the rules differ: fix that first.
2. Exit 0: store it as the `RULESET_DRIFT_TOKEN` secret of the `ruleset-drift` environment, with deployment branches limited to `main` and no required reviewers.
3. Exit 3: only a token with Administration write can read them. Do not store that token, because it can edit the ruleset it watches. Instead, a repo admin runs `RULESET_DRIFT_TOKEN=$(gh auth token) node scripts/check-ruleset-drift.mjs --repo vibtra/guard-oss` at each release. Until then, no machine checks the bypass actors.

It runs daily, on every push to `main`, on a manual run, and on pull requests that change the check or `.github/rulesets/main.json`. It does not run on other pull requests: the difference is a repository setting, not something a pull request can fix, and a check that fails on every pull request teaches people to ignore red checks. After a run on `main` that is not a pull request, a separate `issue` job, the only one with `issues: write`, files the result. Each failure has its own title: "Ruleset drift on main: the rules differ", ": could not compare, GitHub API error", ": RULESET_DRIFT_TOKEN cannot read the bypass actors", or ": the check did not finish". It updates the open issue with that title, or opens one with the report and the run link, and closes the issues with the other titles. A passing run closes them all. It touches only issues opened by `github-actions[bot]`. GitHub turns off scheduled workflows after 60 days without repository activity, and then the issue stops updating too.

To fix a failure, a repo admin applies the file with `gh api -X POST repos/<owner>/<repo>/rulesets --input .github/rulesets/main.json`, or updates the existing ruleset with `gh api -X PUT repos/<owner>/<repo>/rulesets/<id> --input .github/rulesets/main.json`. Or change the file to match GitHub in a reviewed pull request. To run it locally: `GITHUB_TOKEN=$(gh auth token) node scripts/check-ruleset-drift.mjs --repo <owner>/<repo>`.

## Every pipe runs with pipefail

A pipeline exits with its last command's code. GitHub's default shell, `bash -e {0}`, has no `pipefail`, so `check | tee summary` passes when `check` fails. `ruleset-drift` went green on real drift this way. `shell: bash` runs `bash -eo pipefail`. The `guardrails` job runs `node scripts/check-workflow-pipefail.mjs`, which fails on any `run:` step in `.github/workflows/` or `.github/actions/` that has a `|` (not `||`) and no pipefail. Pipefail comes from `defaults: run: shell: bash` on the workflow or job, `shell: bash` on the step, or `set -euo pipefail` (or `set -o pipefail`) as the script's first line. It parses each file with `js-yaml` and reads `jobs.*.steps[*]` and a composite action's `runs.steps`, so it sees each `run` as GitHub does, in any YAML style. The shell is the step's, then the job's `defaults`, then the workflow's. A file it cannot parse fails the check. It counts a `|` inside quotes or a `case` pattern as a pipe too, and the fix costs one line.
