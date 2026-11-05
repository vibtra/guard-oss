# Guard by Vibtra

Guard checks AI requests on a Mac against your organisation's policy. It blocks a supported request before it leaves the device, or lets it through. You manage policy, devices and requests in a web dashboard.

> Status: first public release, Community Edition. Vibtra Cloud is in early access. Builds you make from this repository without your own Apple signing are unsigned development builds and cannot turn on the network extension.

## Get started

**[Install guide](docs/guide/README.md)**: one start page for both ways to run Guard.

- **Download and self-host** (Community Edition, free). Run the server yourself with Docker Compose ([docs/guide/self-host.md](docs/guide/self-host.md)), then install the Mac app. Mac app download, release and checksum: see the guide's [download table](docs/guide/README.md#download).
- **Vibtra Cloud** (early access, assisted). Vibtra runs the server at https://vibtra.app. There is no self-service sign-up: email sam@vibtra.app and we set up your organisation with you ([docs/guide/README.md#vibtra-cloud](docs/guide/README.md#vibtra-cloud)).

## How it works

- **Mac agent** (`guard/agent-go`). A local HTTPS proxy. It decrypts only hosts in its AI service catalogue, using a certificate authority unique to that Mac. Traffic to any other host passes through unread.
- **macOS app and Network Extension** (`guard/mac`). A menu-bar app for setup and status. It runs the agent and installs one system extension that steers AI traffic to it. It also shows a notice when Guard blocks a request and has a Remove Guard action. The earlier native Overview, Activity, Rules and Setup window is deprecated: nothing in the app opens it, and its code stays until a later cleanup. Management lives in the web dashboard.
- **Signed policy.** The agent downloads a signed policy bundle from the backend and checks the signature before it applies it.
- **Deterministic rules.** Detectors are regular expressions with checksums and lists. No model decides.
- **Metadata only.** An event records the host, the app, the rule, a count and at most a short redacted fragment. Request bodies are checked in memory. They are not stored and not reported to the backend.
- **Requests.** When a rule allows it, a person can ask for an exception. An admin approves or declines it in the dashboard.
- **Backend** (`apps/registry`) and **web dashboard** (`apps/guard-console`, at `/<org>/guard`). Sign-in, organisations, devices, policy, approvals and events.

## Supported Macs

- macOS 14 or later.
- Apple silicon (arm64) only. Intel and universal builds are not supported.

## Coverage

The agent's catalogue lists 48 AI services ([guard/agent-go/catalogue.json](guard/agent-go/catalogue.json)). Catalogue membership means Guard decrypts and checks that service's traffic. It is not a promise that every client or route of that service is blocked.

Blocking the send action of a chat client is tracked per route in [guard/agent-go/surface-coverage.json](guard/agent-go/surface-coverage.json). That file is the coverage record. Each entry names its status, the evidence behind it and the date. The live captures it cites are kept out of this repository, so its evidence paths are private record identifiers, not files you can open here.

| Client | Status |
|---|---|
| Claude on the web (send) | Verified live, 22 October 2026 |
| Claude for macOS (send) | Verified live, 22 October 2026 |
| ChatGPT on the web, signed in (send) | Verified live, 22 October 2026 |
| ChatGPT on the web, signed out (send) | Verified live, 22 October 2026 |
| ChatGPT for macOS, ChatGPT and Codex modes (send) | Verified live, 22 October 2026 |
| Retry routes, older native routes, other API routes | Candidate or untested |

"Verified" means a dated live test showed the send blocked. Most verified entries also record the send allowed with the switch off, recovery afterwards and no effect on other clients. The coverage file states exactly what each test covered. Content inspection for each route is recorded separately in the same file. Other clients and services are not claimed.

Limits, in full in [docs/guide/coverage.md](docs/guide/coverage.md#limits):

- **Fails open.** If the agent stops answering, or the app is not running after a restart, AI traffic goes straight to the service, unchecked.
- **Vendor errors.** A blocked chat app or website shows its own generic error. Guard's notification and block page give the reason. Guard does not redirect every client to its block page.
- **Telemetry.** Events carry metadata only, plus at most a short redacted fragment when your organisation allows it. Request bodies are checked in memory on the Mac and never sent to the server. Content of PDFs, images and Office files is not inspected.

## Self-host and Vibtra Cloud

- **Self-host:** run the backend and dashboard yourself. The short path is [docs/guide/self-host.md](docs/guide/self-host.md); the operator reference, with backup, restore and upgrade, is [docs/self-host.md](docs/self-host.md). See also [docs/runtime.md](docs/runtime.md).
- **Vibtra Cloud:** early access, assisted, at https://vibtra.app. It runs this backend from the AWS CDK app in [infra/](infra/README.md). Sign-ups are by allowlist: email sam@vibtra.app.

Both run the same backend. The internal `hosted` configuration name means authenticated multi-tenant operation, not a requirement to use Vibtra Cloud. No workspace host, builder or deploy service is required.

## Editions

Guard comes in two editions that run the same code. They differ in which AI surfaces they cover and in the enterprise features.

**Community Edition** (free, self-hosted)

- The whole engine: the Go agent, the macOS app and its Network Extension, the web dashboard and the backend, signed policy sync, the block page and removal.
- Four surfaces: Claude on the web, Claude for macOS, ChatGPT on the web and ChatGPT for macOS, as listed in `guard/agent-go/surface-coverage.json`.
- These surfaces are kept current. Fixes for vendor changes and new features for them reach the Community Edition the same day they reach paying customers.
- One organisation with organisation-wide rules, and email or OIDC sign-in, including per-organisation OIDC single sign-on.
- No caps on devices, seats or usage.
- Community support.

**Paid** (Vibtra Cloud, or a licensed self-host)

- Everything in the Community Edition.
- Every new surface: any AI app, site or client Guard covers beyond the four above. The Community Edition's surface list does not grow.
- New surfaces covered on request.
- The enterprise features in `ee/`. Built today: SCIM directory sync. Coming: SAML single sign-on, group policies, SIEM export, long audit retention and export, multi-step approvals, and multiple organisations.
- Hosting by Vibtra (Vibtra Cloud), and support with a response-time commitment.
- Pricing is not set yet: email sam@vibtra.app.

The record of this decision is [docs/decisions/0002-community-edition.md](docs/decisions/0002-community-edition.md).

## Licence

Each path carries its own licence. [LICENSE](LICENSE) summarises them, [REUSE.toml](REUSE.toml) assigns them, and the texts are in [LICENSES/](LICENSES/).

| Path | Licence |
|---|---|
| Everything not listed below | AGPL-3.0-only |
| `guard/`, `packages/guard-contract/` | Apache-2.0 |
| Files copied from other projects | Their own upstream licence, as `REUSE.toml` lists them |
| `ee/`, where present | Vibtra Enterprise Licence (commercial). Not part of the Community Edition. |

- **Copyright holders:** Sam Rahmani and Tyler Stewart, until the company is incorporated. Their rights are then assigned to the company.
- **Contributions:** made under the [contributor licence agreement](CLA.md), which lets the copyright holders relicense them. It is a draft and has not been reviewed by a lawyer. [CONTRIBUTING.md](CONTRIBUTING.md) says how to sign.
- **Pending:** the company's legal name, which replaces the founders as copyright holder and as the party to the agreement; the per-file `Copyright 2026 Vibtra` headers and the Mac app's bundle copyright string, which still name Vibtra; and the Apple developer account the signed Mac release is published under.

## Develop

Use Node 22.23.4 (`.nvmrc`), pnpm 10.11.0 (`corepack pnpm@10.11.0`) and the Go version in `guard/agent-go/go.mod`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm guard:agent:check
pnpm guard:go:e2e
```

- `build` builds the web dashboard, the landing pages and the Go agent.
- `test` runs the integration tests in `tests/integration/` (the `infra` ones synthesise offline, with no AWS account). Set `VIBTRA_TEST_DATABASE_URL` to a disposable Postgres database to include the database cases. Without it they skip.
- `guard:go:e2e` runs a real Go agent against a test backend: enrolment, signed policy, blocking, approval, recovery and revocation. It uses temporary directories and never touches an installed agent or system trust.
- `guard:agent:check` runs `go vet` and `go build` on the Go agent.
- Mac app: install Xcode and xcodegen, then run `zsh guard/mac/build.sh --unsigned`. This builds the app only. It does not install or turn on the extension. The Mac tests run with `zsh tests/mac/run.sh` (CI job `mac-integration`).

## CI

Every pull request goes through three layers of checks. Layers 1 and 2 run together; layer 3 waits for them. [docs/ci.md](docs/ci.md) has each check, its script and how to run it locally.

1. **Gate files.** `.github/gate-files.txt` lists the files that define CI itself: workflows, gate scripts, lint, test and coverage configs, and toolchain pins. A pull request that changes one fails the `gate-files` check until a human approves it.
2. **Easing checks.** These look for a change that makes CI easier to pass. If any one flags the pull request, it fails and goes to a human.
   - `tripwire`: a fixed scan, with no model, of the gate-file and test-file changes. It flags removed gate lines, `|| true`, `continue-on-error`, skipped tests, widened ignore patterns, raised thresholds, removed assertions and new lint suppressions.
   - `classifier`: off until the `GATE_CLASSIFIER_API_KEY` secret is set. When on, a judge model asks whether the change eases a check, adds code without tests, or weakens a test. It can only escalate. It never clears a pull request. [docs/ci.md](docs/ci.md#the-classifier-is-off) says how to turn it on.
   - `probe-replay`: when a pull request changes a gate script, it runs the default branch's probes through the old and the new script. If the new script allows a probe that the old one refused, the gate was loosened.
3. **Normal CI** (`.github/workflows/ci.yml`). The `gates` job waits for the checks above that are on. Then `lint`, `guard` (typecheck, build, agent and licence checks), `mac` (app build), `integration`, `e2e-providers` (OpenAI API, ChatGPT, Anthropic and Gemini against local fake upstreams), `e2e-console` (browser), `mac-integration` (macOS) and `coverage` (a report, no thresholds) run.

New tests go where [CONTRIBUTING.md](CONTRIBUTING.md) says: under `tests/integration/`, `tests/e2e/` or `tests/mac/`, never beside the code.

**Approving a gate-file pull request.** A login in `.github/gate-approvers.txt` who is not the author reads the change, approves the pull request, and re-runs the failed check. The approval covers only the head commit it was given on. A new push needs a new approval and a new re-run. The same approval also passes a flag from `tripwire`, `classifier` or `probe-replay`.

**What runs on `pull_request_target`, and why.** `gate-files`, `tripwire` and `probe-replay` run on `pull_request_target`. GitHub then takes the workflow and the gate scripts from the default branch, not from the pull request, so a pull request cannot edit the gate that judges it. These jobs read the pull request's files as data only. `probe-replay` runs the pull request's gate scripts in a separate locked-down job with no secrets. `classifier` runs on `pull_request`, so a fork pull request gets no API key. Its job loads the prompt, model and scripts from the default branch, but GitHub takes the workflow file itself from the pull request, as it also does for `ci.yml`. A pull request that edits either workflow runs its own copy. `gate-files` gates that edit, because every workflow is a gate file. A change to a gate script, the prompt or the model takes effect only after it merges.

## Repository layout

| Path | What |
|---|---|
| `guard/agent-go` | The Mac agent (Go) |
| `guard/agent` | The earlier Rust agent, kept as a test oracle for policy and detectors |
| `guard/mac` | The macOS app and Network Extension |
| `packages/guard-contract` | The shared contract: signed policy, detectors, catalogue, events |
| `apps/registry` | The backend |
| `apps/guard-console` | The web dashboard |
| `apps/landing` | The public pages the backend serves |
| `infra` | The AWS CDK app for the hosted backend (Vibtra Cloud) |
| `packages/console-api`, `packages/ui` | The dashboard's wire types and the shared UI |
| `ee` | Enterprise features under the Vibtra Enterprise Licence. Not part of the Community Edition or its public export. The core never imports it. |

Some backend modules from an earlier product are still in the tree because shared code imports them. The Guard service does not expose them.

## Security

Report vulnerabilities privately. See [SECURITY.md](SECURITY.md).
