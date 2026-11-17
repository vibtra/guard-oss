@AGENTS.md

## Local telemetry and runtime validation

Use the logs to check that a change works at runtime, not only that its tests pass.

### Run with debug logs

Agent (from the repository root):

```sh
go -C guard/agent-go build -o build/vibtra-guard .
VIBTRA_LOG_LEVEL=debug VIBTRA_GUARD_DIR="$(mktemp -d)" guard/agent-go/build/vibtra-guard run
```

The level comes from `--log-level`, then `VIBTRA_LOG_LEVEL`, then `logging.json` (`{"level":"debug"}`) in the data directory, then `info`. `run` writes JSON lines to stderr and to `<data dir>/logs/vibtra-guard.log` (rotated at 5 MiB, three old files kept). Other commands (`sync`, `status`, `enrol`) write to the file only. The default data directory is `~/Library/Application Support/Vibtra Guard`.

Registry: `LOG_LEVEL=debug pnpm --filter @vibtra/registry dev`. Pino writes JSON lines to stdout. Self-hosted: set `LOG_LEVEL` in the env file and read `docker compose logs guard`.

### Follow one request

Each proxied request and each WebSocket connection has a UUIDv7 `request_id`. The decision event stores the same id as `requestId`, so a line in the log and a row in Activity join. Each sync cycle has a `sync_id`, sent to the registry as `X-Request-Id`; the registry logs it as `request_id`, returns it in the `x-request-id` header and puts it in `traceId` on error bodies.

```sh
LOG="$VIBTRA_GUARD_DIR/logs/vibtra-guard.log"
tail -f "$LOG" | jq -c 'select(.msg == "request")'
tail -f "$LOG" | jq 'select(.request_id == "<id>" or .sync_id == "<id>")'
```

Flip the agent's level at runtime (resets on restart; refused to web pages, like `/ca/hold`):

```sh
curl -s -X POST http://127.0.0.1:9471/debug/level -H 'content-type: application/json' -d '{"level":"debug"}'
curl -s http://127.0.0.1:9471/debug/level
```

### Levels

- ERROR: Guard is broken and someone should act (engine failure, a policy that fails verification, sync failing at its backoff cap, a 5xx).
- WARN: unexpected, but Guard coped (a failed step that will be retried, an expected 4xx).
- INFO: one line per normal unit of work: one completion line per intercepted request, one line per sync cycle, one per registry request. A person being blocked is INFO.
- DEBUG: steps inside a request (`msg: "step"` with `duration_ms`), pass-through traffic and CONNECT tunnels.

Log once, at the boundary. Inner functions wrap and return errors.

### Privacy (every level, including DEBUG)

Never log request or response bodies, prompts, headers, cookies, tokens, emails, query strings, or matched or detected content (snippets included). Log rule ids, counts, hosts, route shapes (`diagnosticRoute` in the agent, `req.routeOptions.url` in the registry) and pseudonymous org and device ids only. In the Mac app, hosts and signing ids are `privacy: .private`.

### New code paths

- Agent: new proxy entry points go through `traced(...)` in `guard/agent-go/request_trace.go`; log with `logFrom(ctx)`. Wrap engine, upstream, policy and registry boundaries with `timed(ctx, step, fn)` or `timedValue`, not helpers inside them. Record the verdict with `record(ctx, ...)` so the completion line and the event carry it.
- Registry: the request id, completion line and error levels come from `installRequestTelemetry` and the error handler in `apps/registry/src/server.ts`. Wrap Postgres, key backend and other dependency calls at the service boundary with `timed(req.log, step, fn)` from `apps/registry/src/telemetry.ts`. Throw `VibtraError` or `GuardError`; do not put raw error messages in a response.
- Tests that read the agent log are in `tests/integration/agent-go/telemetry.test.ts`; registry ones are in `tests/integration/registry/request-telemetry.test.ts`.
- On a Mac, agent tests that open a CONNECT tunnel wait for the real Keychain to trust the test CA. For a local run, add `VIBTRA_GUARD_SECURITY_BIN=/usr/bin/true` to the vitest command. CI runs on Linux and needs nothing.
