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
