# Vibtra Guard — the laptop half

The laptop half of **Guard by Vibtra**: what runs on each work Mac. Licence: **Apache-2.0**
(this directory's `LICENSE`; `REUSE.toml` and `scripts/lib/ee-boundary.mjs` name `guard/` as an Apache zone). Every
source file carries the Apache-2.0 SPDX identifier in its header, as `packages/guard-contract/` does.

| Directory | What | Built with |
|---|---|---|
| `agent-go/` | `vibtra-guard`, the production Go/uTLS agent: the explicit HTTP(S) proxy that decrypts only catalogued AI hosts under a per-laptop CA, the rule engine, the Santa-shaped sync client, the block/redirect page, the enrol CLI | `zsh guard/agent-go/build.sh` (Go net/http + uTLS + crypto/x509) |
| `agent/` | Previous Rust agent, retained as a signed-policy and detector parity oracle during migration | `cargo test` |
| `mac/` | the menu-bar app: supervises the agent, minimal setup (enrol, trust the certificate, the Network Extension), Open web dashboard, a block notice, and Remove Guard; plus the Network Extension (`NEFilterDataProvider` + `NETransparentProxyProvider`) that steers AI flows to the agent. The native Overview/Activity/Rules window is deprecated and unreachable; its code stays until a later cleanup under VIB-20. Management is in the web dashboard | `xcodebuild` (xcodegen project) |

The contract both halves speak is `packages/guard-contract`. The
Go agent's `tests/integration/agent-go/detectors.test.ts` and Rust oracle's `tests/vectors.rs` load `packages/guard-contract/src/detectors.vectors.json`; `tests/contract.rs` compares
`src/contract.rs` with `pnpm --filter @vibtra/guard-contract contract:json`.

The dashboard is the web dashboard only; the native macOS dashboard is deprecated. See
[`docs/decisions/0001-web-dashboard-only.md`](../docs/decisions/0001-web-dashboard-only.md).

## Rules of the road (how the agent keeps them)

- **Only AI domains are decrypted.** A CONNECT to a host no enabled catalogue row matches is tunnelled blind;
  in transparent mode only catalogued hosts are steered at all.
- **A unique CA per laptop; the key cannot leave it.** The macOS app makes the CA private key in the Mac's Secure
  Enclave at first run and keeps it on a keychain group only Guard can use, so it cannot be copied off the Mac or out
  of a backup. The app signs only for Guard's own team-signed agent. The certificate (`ca.pem`) is under
  `~/Library/Application Support/Vibtra Guard/` and reaches the registry as a fingerprint and an expiry only.
  If the key is gone, the agent makes a new CA and the app asks the user to trust it.
- **Cases where Guard cannot inspect are shown.** On a Mac without a Secure Enclave, when no key can be made, in
  an unsigned build (`build.sh --unsigned`, or when its team signing fails; status `interception off: unsigned
  build`), or on a platform other than macOS, AI traffic passes through unchecked. Switches and content rules do not
  apply there; only the extension's content filter still drops a service set to block or ask in Enforce mode. The
  Mac shows "This Mac is not protected" and the console lists it as not protected. Through the network extension
  (the Mac's normal path), a request Guard cannot check (a new CA not trusted yet, the app restarting or not
  responding, or a failed signature for that host) goes through unchecked within a few seconds, as in the
  [availability fail-open](../docs/guide/coverage.md#availability-guard-fails-open). While the app restarts, the
  Mac shows nothing and the console lists the Mac as not protected after its next sync. A failed signature for one
  host shows in neither the panel nor the console: `interception` stays on and only `/status` `ca.lastSignError`
  records it. Explicit-proxy clients (`HTTPS_PROXY`) instead wait up to about 90 s for a new CA to be
  trusted, then go through unchecked, and fail (502) while the app is restarting or cannot sign for that host. See
  [When Guard cannot inspect](../docs/guide/coverage.md#when-guard-cannot-inspect).
- **No content leaves the laptop.** An event is the host, the app, the rule, a count and at most a redacted fragment
  (`123***782`); the request body is evaluated in memory and forwarded or refused, never stored.
- **Deterministic rules only.** The detectors are regexes with checksums and lists; there is no model.

Third-party notices are in `NOTICE` (Presidio and gitleaks patterns are ported with attribution; LuLu and HTTP Toolkit
were read for their shapes and no code from either is here).
