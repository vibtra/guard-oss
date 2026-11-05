# Guard engines

The proxy decodes each request, then asks an engine whether to allow, ask or block it. The engine is the `Engine` interface in `engine.go`:

```text
type Engine interface {
	Name() string
	Decide(ctx context.Context, req Request) (Decision, error)
}
```

| Package | What it is | Who may import it |
|---|---|---|
| `engine` | The port: `Engine`, `Request`, `Decision` and their field types | `main`, the proxy, every engine, `engine/conformance` |
| `engine/rules` | Today's engine: deterministic rules from the signed policy bundle, plus the detectors | `main.go` only |
| `engine/example` | A small engine that wraps `rules` and adds one keyword rule. Copy it to start your own | nothing, until you swap it in |
| `engine/conformance` | `Check` and `Bench`, run by `vibtra-guard engine check` and `vibtra-guard engine bench` | `main` |

`main.go` is the only place that chooses the engine:

```text
var eng engine.Engine = rules.New()
```

The proxy gets the engine as a constructor parameter. No other file names an engine package. `golangci-lint` enforces this with two depguard rules in `.golangci.yml`:

- `engines-only-in-main-go`: in `guard/agent-go`, only `main.go` and files under `engine/` may import `engine/rules` or any other `engine/<name>`.
- `engine-port-imports-only-stdlib-and-policy`: the port files (`engine/*.go`) import only the standard library and `policy`.

## Write and swap an engine

Run every block from the repository root. No block changes directory. You need Go (the version in `guard/agent-go/go.mod`).

### 1. Copy the example

```sh
cp -R guard/agent-go/engine/example guard/agent-go/engine/myengine
perl -pi -e 's/^package example$/package myengine/; s/return "example"/return "myengine"/' guard/agent-go/engine/myengine/*.go
```

`Name()` must return the engine's name. `status` and `--version` print it as `engine: myengine`.

### 2. Implement Decide

Edit `Decide` in `guard/agent-go/engine/myengine/`. Read the contract below first. To start from today's behaviour, call `rules.New().Decide(ctx, req)` and change its `Decision`, as the example does. `tests/fixtures/engines/pineapple/pineapple.go` is a minimal test fixture that blocks only text containing `PINEAPPLE`. It ignores `CoverageFailed`, `Surface` and exceptions, so it does not meet the contract: do not start from it.

### 3. Change one line in main.go, plus its import

```sh
perl -pi -e 's/engine\.Engine = rules\.New\(\)/engine.Engine = myengine.New()/; s|^(\t"github.com/vibtra/guard/guard/agent-go/engine/)rules"$|$&\n$1myengine"|' guard/agent-go/main.go
gofmt -w guard/agent-go/main.go
git diff --stat -- guard/agent-go/main.go
```

The change is:

```text
 	"github.com/vibtra/guard/guard/agent-go/engine/conformance"
+	"github.com/vibtra/guard/guard/agent-go/engine/myengine"
 	"github.com/vibtra/guard/guard/agent-go/engine/rules"
...
-	var eng engine.Engine = rules.New()
+	var eng engine.Engine = myengine.New()
```

Keep the `engine/rules` import: the `detect-scan` command still calls `rules.Detect`. Change nothing else in `main.go` and nothing in the proxy files.

### 4. Build and run the conformance check

```sh
go -C guard/agent-go build -o build/vibtra-guard .
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard --version
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine check
```

`engine check` prints `engine: <name>`, then one `ok` or `FAIL` line per check, and exits 1 when any check fails. Every engine must pass these checks:

```text
monitor-never-blocks              Enforced is false under a monitor bundle
coverage-failure-never-allowed    under an enforce bundle, a CoverageFailed request is intercepted, enforced, and blocked or asked
missing-capability-never-allowed  a rule whose detector kind the engine cannot run blocks, with Unavailable "engine-capability", and Enforced is true only under an enforce bundle
surface-blocks                    a request with Surface set is intercepted and blocked, and Enforced is true only under an enforce bundle
valid-decision                    engine.Validate passes, Verdict is one of the four verdicts, and Intercepted matches Verdict
exceptions                        live exceptions are honoured and expired ones are not
deterministic                     the same Request gives the same Decision 100 times
no-content                        the Decision carries no request content beyond redacted examples
```

`engine check --parity` also runs the shared detection and decision vectors, and expects the verdicts of `rules`. `--vectors DIR` reads the vectors from another directory, for `engine check --parity` and `engine bench`. A new engine does not need to pass `--parity`. A change to `rules` must pass it.

### 5. Measure speed

```sh
VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard engine bench
```

`engine bench` prints ns/op and allocs/op for each vector set. To show a speed-up, run it on `main` and on your branch, and put both outputs in the pull request.

### Go back to rules

```sh
git checkout -- guard/agent-go/main.go
rm -rf guard/agent-go/engine/myengine
```

## The contract

### What an engine must never do

- Never store, log, send or write `req.Content` anywhere: no files, network, globals or caches. Content lives in memory for one `Decide` call.
- Never put request content in the `Decision`, except redacted text in `Match.Examples`.
- Never read the clock. Use `req.Now`.
- Never use randomness or state from earlier calls. The same `Request` must always give the same `Decision`.
- Never set `Enforced` when `req.Bundle.ClientMode` is not `"enforce"`. Monitor mode never blocks.
- Never block on an expired exception, and never ignore a live one. Use `req.Bundle.Exception(serviceID, ruleID, req.Now)`.
- Never modify `req.Bundle`, `req.Catalogue` or the slices in `req.Content`. They are shared with the proxy.
- Never import the proxy (package `main`) or another engine except `engine/rules`.

### What an engine must always do

- When `req.CoverageFailed` is `true` and `req.Bundle.ClientMode` is `"enforce"`, return `Intercepted: true`, `Enforced: true` and `Verdict` `"blocked"` or `"asked"`, for HTTP and WebSocket alike. Guard could not inspect the request, so it must not reach the service.
- When `req.Surface` is set and `req.Bundle` is not `nil`, return `Intercepted: true` and `Verdict: "blocked"`, in enforce and monitor mode alike. `Enforced` is `true` only under an enforce bundle, so in monitor mode the proxy records the block and forwards the request.
- When a content rule that is not `allow` names a detector kind the engine cannot run, block the request (`Verdict: "blocked"`) with a match for that rule whose `Unavailable` is `"engine-capability"`, or `"model_not_ready"` when the kind needs a model that is not loaded yet. Never skip the rule. A live exception for the rule still applies.
- Return a `Decision` that passes `engine.Validate`, with `Verdict` `"not-intercepted"` exactly when `Intercepted` is `false`.

`engine check` fails an engine that breaks any of these rules (`coverage-failure-never-allowed`, `missing-capability-never-allowed`, `surface-blocks`, `valid-decision`).

### What an engine is guaranteed

- `Decide` is called from many goroutines at once. Keep the engine free of mutable state.
- `req.Bundle` and `req.Catalogue` passed signature and digest checks before the engine sees them. The exception is `vibtra-guard test --bundle/--catalogue`, which loads local unsigned files. The agent accepts a content rule with any non-empty detector kind, so a bundle can name a kind that this engine cannot run.
- `req.Content` is already decoded: the proxy handles compression, JSON, forms, multipart, protobuf and WebSocket framing. When it cannot decode a body safely, it sets `CoverageFailed`.
- In the proxy, `ctx` is the request's context, cancelled when the client goes away. `policy-scan` passes `context.Background()`.

### Request

| Field | Meaning |
|---|---|
| `Host` | Lower-case origin host, without a trailing dot. `Host`, `BundleID` and `CLI` are the target and the sending app as the proxy attributed them |
| `BundleID` | macOS bundle ID of the sending app. Empty in the proxy and `policy-scan` today; only `test --bundle-id` sets it |
| `CLI` | CLI name taken from the `User-Agent`, when the catalogue knows it. Empty for surface requests |
| `Transport` | `engine.HTTP` or `engine.WebSocket` (one complete outgoing WebSocket message) |
| `Content.Spans` | Every decoded text value, in order. `Label` names the field kind when known |
| `Content.Text` | The decoded text joined with newlines |
| `Content.Filenames` | Upload file names from multipart bodies |
| `Content.Joined` | Message parts that clients split across several fields, joined back together |
| `CoverageFailed` | `true` when the proxy could not decode the body or message safely (unsupported encoding, oversized, invalid). `Content` is then empty or partial. Do not allow the flow: `rules` blocks an HTTP request whose flow would otherwise be allowed, and blocks every intercepted WebSocket message |
| `Surface` | Set when the request matches a documented surface that the bundle blocks. `Surface.Surface` is the surface ID, `Surface.CoverageEntry` the catalogue entry. Before the body is read in enforce mode, the proxy sends a request with `Surface` set and no `Content`. If that `Decision` does not block, the proxy reads the body and calls `Decide` again with `Content` |
| `Bundle` | The verified policy bundle. `nil` means no policy: return `Verdict: "not-intercepted"` |
| `Catalogue` | The verified service catalogue. `Catalogue.Service(Host, BundleID, CLI)` finds the service. Treat `nil` like a `nil` `Bundle` |
| `Now` | The time to decide at. Use it for flows and exceptions |

### Decision

| Field | Meaning | Rule |
|---|---|---|
| `Intercepted` | The request is to a service in the catalogue that the policy covers | When `true`, `Service` and `Flow` must not be `nil`. When `false`, `Service` must be `nil`; the proxy forwards the request and records nothing |
| `Service` | The catalogue service | Use the pointer from `Catalogue.Service` |
| `Flow` | The flow decision: `Action` (`allow`, `ask`, `block`), `Source` (`default`, `rule`, `exception`, `surface-block`, `inspection-coverage`), `RuleID`, `GrantID`, `SurfaceID`, `CoverageEntry`, `Note` | `Note` is shown to the user. It must not contain request content |
| `Content` | The content result: `Action`, every rule `Matches`, and `Decided`, the index of the match that set the action (`-1` when none did) | `Decided` must be `-1` or an index into `Matches` (`0` to `len(Matches)-1`). The event uses that match, or the first match when `Decided` is `-1` |
| `Content.Matches[].Rule` | The `policy.ContentRule` that matched. Copy it from `req.Bundle.ContentRules` | `Rule.RuleID` and `Rule.Name` go in the event and the block page, and `Rule.Note` is shown to the user in place of `Flow.Note`. An empty `Rule` gives events with no rule ID, name or note. `policy-scan` reports `Rule.Action` |
| `Content.Matches[].Excepted`, `.GrantID` | Whether a live exception covers the match, and that exception's grant ID | Set both from `req.Bundle.Exception(serviceID, Rule.RuleID, req.Now)`. `policy-scan` reports `Excepted` |
| `Content.Matches[].Unavailable` | Empty, or why the rule blocked without running: `engine-capability` (the engine has no detector for the kind) or `model_not_ready` (the kind needs a model that is not ready) | `rules` sets `Rule.Note` to say so. The event records it as `reason`. `policy-scan` reports it as `unavailable`, with `action` `block`. `rules.Builtin(kind)` reports the kinds `rules` runs itself. `rules.New(rules.WithExtra(x))` adds an `Extra`: for each kind, `x.Readiness(kind)` returns `Unsupported`, `NotReady` or `Ready`. On a built-in kind a `Ready` `Extra` only adds to the built-in match. On any other kind, `Ready` runs `x.Detect`, `NotReady`, a `Detect` error or a panic in the `Extra` gives `model_not_ready`, and `Unsupported` gives `engine-capability` |
| `Content.Matches[].Match` | `Kind`, `Count`, `Examples`, `Details`, `Diagnostics` | `Examples[0]` can go in the event as the snippet: it must be redacted. `Details` and `Diagnostics` describe the shape of a match, never its text |
| `Verdict` | `not-intercepted`, `allowed`, `asked` or `blocked` | `not-intercepted` exactly when `Intercepted` is `false`. The proxy acts on `Verdict` and `Enforced`, not on `Flow.Action` or `Content.Action` |
| `Enforced` | The verdict is enforced | `true` only when `Bundle.ClientMode == "enforce"`. The proxy blocks only when `Enforced` is `true` and `Verdict` is `blocked` or `asked`. Otherwise it forwards the request or message and records `observed`. This holds on every decision path: HTTP, the surface pre-check, WebSocket messages and WebSocket messages that cannot be decoded. Two WebSocket transport failures, an unsupported extension and a broken frame or timeout, close the connection whatever the `Decision` says; the `Decision` is only recorded |

`Decision` keeps the JSON tags shown in `engine.go`: the `test` command prints it as JSON and the TypeScript parity tests read that output.

### Name

`Name()` returns a short, stable ID such as `rules`. `vibtra-guard --version` prints it as `engine: <name>`, and `vibtra-guard status` adds it to its JSON as `"engine"`.

### Errors fail closed

Return an `error` only when the engine cannot decide. `rules` never returns one. Guard also runs `engine.Validate` (`engine/validate.go`) on every `Decision` before it acts on it, and treats a `Decision` that breaks the `Intercepted`, `Service`, `Flow` or `Decided` rules above as an engine error. On an error, Guard never forwards the undecided request: HTTP gets 503 "Guard could not decide this request", a WebSocket message closes the connection with code 1011, and `policy-scan` and `test` exit non-zero.

## Contributing an engine

Optimisations to `rules` are welcome in this repository: they must pass `engine check --parity`, and the pull request shows `engine bench` before and after. Other engines stay in forks. See the engine section in [CONTRIBUTING.md](../../../CONTRIBUTING.md#engines).
