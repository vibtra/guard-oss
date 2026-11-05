> Production has moved to [`../agent-go/`](../agent-go/). This implementation is retained as a migration parity oracle; the Mac app and eval harness ship/run the Go agent.

<!-- SPDX-License-Identifier: Apache-2.0 -->
<!-- Copyright 2026 Vibtra -->
# vibtra-guard — the laptop agent

Vibtra Guard v0's agent (GitHub issue #24). Rust, Apache-2.0. The contract it speaks is `packages/guard-contract`;
`docs/guard.md` §7 fixes every port, path, flag, header and page used here.

```
cargo build --release            # → target/release/vibtra-guard
cargo test                       # vectors, contract, engine, bundle, sync, proxy, no-content
cargo clippy --all-targets -- -D warnings
```

## Use

```
vibtra-guard enrol --server https://<registry> --token genr_…     # or --link 'vibtra-guard://enrol?server=…&token=…'
vibtra-guard ca trust                                              # adds the per-laptop CA to the login keychain (macOS asks for your password)
vibtra-guard run [--proxy 127.0.0.1:9470] [--local 127.0.0.1:9471] [--transparent [127.0.0.1:9472]]
                 [--upstream-map chatgpt.com=http://127.0.0.1:4801,…] [--sync-every S]
vibtra-guard sync                                                  # one Santa cycle now
vibtra-guard status [--json]                                       # asks the running agent, else reads the data dir
vibtra-guard ca export [--spki]                                    # the CA PEM, or Chromium's --ignore-certificate-errors-spki-list value
vibtra-guard test --host chatgpt.com --text 'my tfn is 123 456 782' [--file F] [--bundle B] [--json]
```

Point a browser or CLI at the proxy (`HTTPS_PROXY=http://127.0.0.1:9470`, or the macOS app's Network Extension in
transparent mode). Data lives in `$VIBTRA_GUARD_DIR` or `~/Library/Application Support/Vibtra Guard/`: `device.json`,
`device.token` (0600), `ca.key` (0600) / `ca.pem`, `bundle.json`, `catalogue.json`, `events.jsonl`, `state.json`.
Logs go to stderr (`VIBTRA_GUARD_LOG` sets the filter; the default keeps hudsucker off because its spans name URIs).

## What it does, and the open-source shapes it mirrors

| Module | What | Shape |
|---|---|---|
| `sync.rs` | enrol → preflight → ruledownload → eventupload → postflight; backoff; revoke stops enforcing | google/santa sync (Apache-2.0); Fleet's enrol secret → node key |
| `bundle.rs` | ES256 compact JWS over sha256(canonical JSON); pinned key; last good bundle kept on failure | OPA bundle signing, TUF envelope |
| `proxy.rs` | decrypt ONLY catalogued AI hosts under the per-laptop CA; tunnel everything else blind; inspect POST/PUT/PATCH bodies ≤ 4 MB in memory | mitmproxy (MIT) model on hudsucker (MIT/Apache-2.0) + rustls |
| `ca.rs` | rcgen P-256 CA `Vibtra Guard CA (<host>)`, 2 years, key never leaves the laptop | mitmproxy's CA |
| `catalogue.rs` | the host-pattern grammar, `serviceForHost` / `serviceForFlow` / `isInterceptedHost` | EasyList `‖domain^`, CrowdSec hub |
| `detect/` | TFN, ABN, ACN, Medicare, Luhn; 12 gitleaks secret rules; bulk email; keywords; file types; redaction | microsoft/presidio and gitleaks (both MIT), ported with attribution |
| `engine.rs` | decideFlow / decideContent / decideRequest, the contract's compile.ts semantics | OPA (evaluate compiled data locally) |
| `prompt.rs` | provider-envelope recognition and Gemini nested-form decoding; full generic scanning remains active, allowed bytes unchanged | AI-Scan-Interceptor request adapters (design reference; independently implemented) |
| `local.rs`, `page.rs` | block page, Request access, workspace redirect, `/status`, `/events` SSE, `/ca.pem`, `/healthz` | — |
| `transparent.rs` | PROXY protocol v1 + SNI, replayed into the explicit proxy as CONNECT | HAProxy PROXY protocol spec |

The Mac app also reads `GET /activity` (latest 300 metadata decisions, in memory) and `GET /policy` (read-only
summary of the active verified bundle). Inspection coverage extras stay local; no prompt text is retained or added
to event uploads. Details and validation: [`docs/guard-native-update.md`](../../docs/guard-native-update.md).

The tests pin it to the contract: `tests/vectors.rs` reads `packages/guard-contract/src/detectors.vectors.json`;
`tests/contract.rs` compares `src/contract.rs` with `contract:json` (committed as `tests/fixtures/contract.json`, also
the embedded seed catalogue — regenerate with
`pnpm --silent --filter @vibtra/guard-contract contract:json > guard/agent/tests/fixtures/contract.json`);
`tests/bundle.rs` verifies fixtures signed once by the TypeScript signer (`scripts/make-fixtures.ts`).

## Honest limits (v0)

- The explicit proxy knows the app only from the User-Agent (a CLI's product token); bundle ids arrive with the
  Network Extension. Desktop apps that pin certificates (Claude, ChatGPT, Codex desktop) are untested.
- `transparent.rs` reads one ClientHello in one TLS record and PROXY v1 only; a fragmented ClientHello falls back to
  the destination IP, which no row matches, so it is tunnelled blind.
- Request bodies with a `Content-Encoding` other than identity, and bodies over 4 MB, are forwarded uninspected (the
  flow rule still applies). WebSocket messages are not inspected.
- Request bodies are inspected only when their Content-Type is JSON (`application/json`, `+json`), form
  (`application/x-www-form-urlencoded`, `multipart/form-data`) or `text/*`, or when there is no Content-Type at all
  (read as plain text). Any other type (`application/octet-stream`, protobuf, …) is forwarded uninspected; the flow
  rule still applies.
- `ca trust` and the `caTrusted` check (`security verify-cert -p ssl`) have not been exercised against a CA trusted in
  a real login keychain by these tests (doing so prompts for the password).
