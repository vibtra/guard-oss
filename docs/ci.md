# CI

Every pull request runs three layers of checks: the gate-file gate, the easing checks, then normal CI. [README.md](../README.md#ci) has the overview. This page lists each required check, what it checks, where its script lives and how to run it locally. `.github/rulesets/main.json` lists the same check names as required, except `classifier` while it is off.

## Layer 1: gate files

| Check | Workflow | Script | What it checks |
|---|---|---|---|
| `gate-files` | `gate-files.yml` | `.github/gate/gate-files.mjs` | Fails when the diff changes a path in `.github/gate-files.txt`, until a gate approver approves the head commit. It also checks that the pull request's `.github/CODEOWNERS` matches the list and `.github/gate-approvers.txt`. |

## Layer 2: easing checks

| Check | Workflow | Script | What it checks |
|---|---|---|---|
| `tripwire` | `easing-tripwire.yml` | `.github/gate/tripwire.mjs` | A fixed scan, with no model, of gate files and the test files in `.github/gate/test-files.txt`. It flags removed gate lines, `\|\| true`, `continue-on-error`, `if: false`, skip and only markers, widened ignore patterns, raised thresholds or timeouts, removed assertions, tests turned into no-ops, and new lint suppressions in any file. |
| `classifier` (off) | `easing-classifier.yml` | `.github/gate/classifier/classify.mjs` (prompt `prompt.md`, model `model.json`) | Off until `GATE_CLASSIFIER_API_KEY` is set. When on, a judge model answers three questions: does the change ease a gate or check, does added code come without tests, does it weaken a test. Any yes, a bad answer, a failed call or a missing key escalates. It never clears a pull request. See [The classifier is off](#the-classifier-is-off). |
| `probe-replay` | `gate-replay.yml` | `.github/gate/probe-replay.mjs` | When the pull request changes `.github/gate/` or `.github/gate-files.txt`, the `replay` job runs the default branch's probes through the default branch's gate scripts and the pull request's gate scripts. A probe that the old scripts refuse and the new ones allow is a loosening. `probe-replay` reads that verdict. |

If one of these flags the pull request, the check fails until a gate approver approves the head commit.

## Layer 3: normal CI

All of these are jobs in `.github/workflows/ci.yml`.

| Check | What it checks |
|---|---|
| `gates` | Waits up to 15 minutes for the three gate checks (`gate-files`, `tripwire`, `probe-replay`) on the head commit. It fails unless `tripwire` concluded `success`. Every job below except `changes` needs it. |
| `lint` | `eslint .` (with the no-comments rule and the fences), `lint:comments` over every language, `lint:fences`, and golangci-lint on `guard/agent-go`. |
| `guard` | Typecheck, build, the `test-locations (agent-go)` and `test-locations (mac)` steps, `go vet` and `go build` on the agent, the Go agent end-to-end run, `verify-independent`, and the licence boundary and manifest. |
| `changes` | Not required. Decides whether the diff touches the Mac app, so that `mac` and `mac-integration` run only when it does. See [When the Mac jobs run](#when-the-mac-jobs-run). |
| `mac` | `guard/mac/VibtraGuard.xcodeproj` matches what xcodegen 2.46.0 generates from `project.yml`, and the unsigned app builds. Runs only when `changes` says so. |
| `integration` | `vitest run integration/` with coverage against Postgres 16, then `cargo test --tests --locked` for the Rust agent in `guard/agent`. |
| `e2e-providers (openai-api)`, `(chatgpt)`, `(anthropic)`, `(gemini)` | One job per provider: a real Go agent against a local fake upstream that replays made-up traffic. An allowed request is forwarded, a blocked one gets a 403, and an exception grant goes through. |
| `e2e-console` | Playwright in Chromium against the web dashboard. |
| `e2e-capture-matrix` | Not required. curl (HTTP/1.1 and HTTP/2), Python requests and urllib, Node and headless Chrome each send their ClientHello to a local TLS origin directly and through the built Go agent. The hello shape and the negotiated HTTP version must match, and a POST carrying a TFN gets a 403 `GUARD_BLOCKED` without reaching the origin. A missing client fails the job. |
| `mac-integration` | `tests/mac/run.sh` on `macos-latest`: the Python tests in `tests/mac/` and the `VibtraGuardIntegrationTests` scheme. Runs only when `changes` says so. |
| `coverage` | Merges the integration and provider coverage with `tools/coverage/summary.mjs` into one report. It has no thresholds. |

### When the Mac jobs run

`mac` and `mac-integration` run on `macos-latest`, which GitHub bills at 10 times the Linux rate. The `changes` job runs them only when one of these paths changed:

- `guard/mac/**` and `tests/mac/**`: the app, its xcodegen inputs (`project.yml`, `Config/`), `build.sh` and the tests;
- any `*.swift` file, any `*.xcodeproj/**` and any `project.yml`;
- `guard/agent-go/build.sh` and `guard/agent-go/go.mod`: both jobs build the agent with them;
- `guard/LICENSE`, `guard/NOTICE` and `guard/agent-go/THIRD_PARTY_NOTICES.txt`: the app build copies them into the app;
- `.github/workflows/ci.yml`.

A pull request compares its merge base with its head. A push to `main` compares the commit before the push with the new one. Matching ignores case. Other Go agent changes do not start the Mac jobs, even though both jobs build the agent and `mac-integration` drives it. For those changes the weekly run is the only Mac check. After an agent change to the local API the app uses (`AgentClient.swift`), start a manual run. A Mac pull request that fails on code it did not touch may be failing on a recent agent change. When the Mac jobs do not run, they show as skipped, which satisfies the required checks.

The Mac jobs always run on the weekly schedule (Sunday 17:00 UTC) and on a manual run (Actions, then "Guard independent checks", then "Run workflow", with `full` left on). They also run when `changes` cannot tell: the first push of a branch, a base commit that is not in the checkout, or a failed `changes` job.

The tripwire flags every removed or edited line in `ci.yml`, but it cannot see a filter weakened only by added lines. Examples are a `decide false "..."` line added to the `changes` step, or a new `case` branch that returns 1 ahead of the Mac patterns. Either one turns the Mac jobs off without a tripwire finding. gate-files still flags any `ci.yml` change. A gate approver reading a `ci.yml` diff should check every change to the `changes` step against the list above.

## Run the checks locally

The gate checks read a diff from the merge base, as CI does. `<base>` is the pull request's base branch (`main` for most):

```sh
git diff origin/<base>...HEAD > /tmp/pr.diff
node .github/gate/gate-files.mjs --diff /tmp/pr.diff         # exit 0 clear, 1 gated
node .github/gate/tripwire.mjs --diff /tmp/pr.diff           # exit 0 clean, 1 flagged
node .github/gate/classifier/classify.mjs --diff /tmp/pr.diff --dry-run   # no model call, no key needed
```

Without `--dry-run`, `classify.mjs` calls the model with `GATE_CLASSIFIER_API_KEY` and spends money. Without the key it exits 3.

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
| `guard` | `pnpm typecheck`, `pnpm build`, `node scripts/check-test-locations.mjs`, `pnpm guard:agent:check`, `pnpm guard:go:e2e`, `node scripts/check-mac-test-targets.mjs`, `node scripts/verify-independent.mjs`, `pnpm licence:boundary`, `pnpm licence:manifest --check` |
| `mac` | `(cd guard/mac && xcodegen generate)`, then `git status guard/mac/VibtraGuard.xcodeproj` shows no change; `zsh guard/mac/build.sh --unsigned` |
| `integration` | `pnpm test` (set `VIBTRA_TEST_DATABASE_URL` to a disposable Postgres database for the database cases); `cargo test --tests --locked` in `guard/agent` |
| `e2e-providers` | `pnpm --filter @vibtra/guard-tests exec vitest run e2e/providers/<provider>/` |
| `e2e-console` | `pnpm --filter @vibtra/guard-tests exec playwright install chromium`, then `pnpm --filter @vibtra/guard-tests test:e2e:browser` |
| `e2e-capture-matrix` | `pnpm --filter @vibtra/guard-tests exec vitest run e2e/agent-go/` (needs curl, python3 with `requests`, and Chrome; set `GUARD_MATRIX_CHROME` to use a Chrome binary that is not in the default place) |
| `mac-integration` | `zsh tests/mac/run.sh` (macOS only) |
| `coverage` | `node tools/coverage/summary.mjs --input <folder of coverage output>` |

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
2. `gates` waits for them. Every normal CI job needs `gates`, and `coverage` also needs `integration` and `e2e-providers`.
3. The pull request merges only when every required check passes on its head, a code owner has approved, and the branch is up to date with `main`.
4. A stacked pull request merges after the pull request below it, by merge commit, so the commits of the lower one keep their SHAs.
