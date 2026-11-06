# Guard Go agent

The production `vibtra-guard` agent. One binary contains the interception proxy, detectors, signed-policy sync,
local API and CLI. The native Mac app and Network Extension remain Swift. The previous Rust agent in `../agent/`
is retained as a parity oracle; the Mac build and detection harness default to this Go binary.

```sh
zsh guard/agent-go/build.sh
cd guard/agent-go && go vet ./...
pnpm --filter @vibtra/guard-tests exec vitest run integration/agent-go/
```

The proxy asks an engine to decide each decoded request. Today's engine is `engine/rules`, chosen on one line in
`main.go`. To write or swap an engine, see [engine/README.md](engine/README.md).

`VIBTRA_GUARD_DIR` / `--data-dir` select an isolated profile. Existing P-256 CA, enrolment, bearer and signed-policy
files are reused. Listener defaults and the CLI are compatible with the previous agent. Production Mac packaging
requires `build/vibtra-guard` and signs it as `GUARD_AGENT_SIGNING_ID` (`app.vibtra.guard.agent` by default, `guard/mac/Config/Identity.xcconfig`); it also includes the notices.
On macOS the agent will not start (it exits 2 and writes nothing) when its stdin, stdout or stderr is a socket connected to a named Unix socket, or a network socket, because such a stream could be a connection to the Guard app's CA signer. Files, pipes, terminals and socket pairs (Node's piped stdio) are fine.

For intercepted HTTPS, Guard captures each client's ClientHello and reproduces its supported handshake shape with uTLS,
omitting extensions that cannot safely cross independent TLS sessions. The client and origin negotiate from the client's offered ALPN list, including
HTTP/2 where available. Guard verifies upstream certificates and hostnames. If a hello cannot be reproduced, Guard
blocks the connection by default. Enforce mode always blocks; monitor mode can explicitly enable an uninspected
tunnel through signed `settings.unreproducibleTls: "tunnel"` policy. See the
[upstream transport design](upstream-transport.md) for the flow, reporting fields, and remaining protocol differences.
Only enabled, signed-policy AI hosts are decrypted. Other CONNECT traffic is a blind byte tunnel. Redirects,
compressed responses, duplicate headers and SSE streaming stay intact. Complete outgoing WebSocket messages are
gated before forwarding, including bounded permessage-deflate, fragmentation and binary JSON. HTTP/3 is handled by
the existing Mac extension's QUIC policy, not this agent's HTTP proxy.

Bodies up to 4 MiB are checked as JSON, nested JSON strings, URL-encoded forms (including Gemini's nested `f.req`),
multipart text/file names and plain text. Unary protobuf and framed Connect protobuf/JSON are also decoded with bounded gzip/Brotli support; readable fields are scanned independently, opaque fields remain partial, and original wire bytes are preserved. Finite Connect requests have a 15-second read deadline; bidirectional streams remain unsupported. Unreadable or oversized RPC requests refuse in enforce mode and are observed/forwarded in monitor mode. Unsupported
binary/media and oversized uncompressed non-RPC bodies remain unchanged, with explicit coverage metadata. Ordinary inspectable HTTP bodies also support gzip, zlib-wrapped deflate, Brotli and Zstandard,
with at most three encoding layers and 4 MiB wire/intermediate/decoded bounds. Original allowed wire bytes and
encoding headers stay unchanged. Invalid, unknown or oversized compressed text bodies refuse before origin delivery
in enforce mode and are observed/forwarded in monitor mode; these are coverage failures, not detector matches.
PDF/image/Office contents and client-side encryption are outside this version's text inspection.
The agent consumes the native extension event inbox with bounded private-file validation, signed-policy checks, replay recovery and acknowledged uploads. These deferred reports do not replay warning popups; they are not authenticated process attribution.

Enrolment pins the registry's ES256 key. Canonical digests and signatures are checked before policy activation;
failed downloads retain the last verified policy pair. Revocation stops enforcement. Device uploads use an explicit
metadata-only event type. Activity is an in-memory 300-entry ring. Persistent event uploads are locked across
processes and acknowledged in batches; request bodies never enter the queue.

Policy activation requires the bundle's catalogue version to match the verified catalogue. `active-policy.json`
is the authoritative checkpoint of both signed envelopes after migration or sync; `bundle.json` and
`catalogue.json` remain native-consumer mirrors. The checkpoint is replaced atomically, then the mirrors are
published; reload repairs interrupted mirror publication from the checkpoint. A process lock serializes the daemon
and one-shot CLI writers. Native consumers independently reject mismatched mirror pairs. This provides ordinary
process-crash recovery, not a power-loss durability guarantee or atomic publication across all consumers.
A first startup migrates a coherent signed legacy pair. Bundle-only compatibility accepts only the exact embedded
seed catalogue version and keeps requesting a signed catalogue; a mismatched bootstrap activates no bundle.
An existing unreadable/invalid checkpoint never silently falls back to mirror files. Full downloads can recover it;
identity, full signing pin and signatures are rechecked on reload, and revoked enrolments cannot reactivate it.

Validation:

- Shared detector vectors and TypeScript-signed bundle/catalogue fixtures, including tampering and wrong pins.
- On-wire client-hello replay; untrusted-origin rejection; unbuffered SSE and duplicate cookies.
- 304 synthetic provider-envelope requests through HTTPS interception: 16 data types and 3 normal texts × 16 sites.
  Each positive must hit its expected rule and must not reach the test origin; allowed bytes must be unchanged.
- `pnpm guard:go:e2e`: a freshly built daemon and disposable registry/profile on ephemeral loopback ports; enrollment, offline restart with unchanged CA/device, zero-origin-contact blocks, queued-event recovery, ask/grant, metadata-only upload, monitor and revoked restart. It does not seed the running demo or change installed policy/trust.
- `pnpm guard:detect offline --per-cell 200 --negatives 10000 --seed 20261018`: generated holdout corpus.
- `pnpm guard:detect browser`: gstack browse live logged-out site checks. Sign-in/bot walls and unsent inputs are
  excluded from catch rates. Set `GSTACK_ROOT` if the installed skill is outside `~/.agents/skills/gstack`.

For the admin playground: `node --import tsx scripts/guard-playground.mjs`; its printed loopback entry signs into
an ephemeral Fernwood demo, with a Go agent checking policy changes every 3 seconds. It changes no system proxy,
certificate trust, installed app or Network Extension settings.
