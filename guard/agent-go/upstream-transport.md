# Upstream TLS transport

Guard terminates TLS so it can inspect the HTTP request, apply policy, and then originate a separate connection to
the provider. For an intercepted connection, it captures the client's raw ClientHello before termination. The
agent uses uTLS `Fingerprinter` to build a `HelloCustom` spec from that hello and offers the client's ALPN protocols
upstream. Replay preserves supported cipher, extension-order, GREASE, group, signature-algorithm, ALPN and padding
preferences as represented by uTLS. Key material is generated afresh. Extensions for encrypt-then-MAC (22),
pre-shared keys (41), early data (42), and retry cookies (44) are removed because they cannot safely be copied
into this independent TLS session. Consequently the upstream fingerprint may differ from the original. Origin
certificate and hostname checks remain enabled.

Each client TLS session gets its own upstream TLS handshake. Guard does not pool a connection established with one
client's fingerprint for another client. This keeps each provider-side TLS session tied to the hello that Guard
captured for that client. Inspection still happens between the two TLS sessions; HTTP requests blocked by policy do
not reach the origin.

## Hello replay failure

After capture, Guard performs a dry-run replay build before terminating downstream TLS. A ClientHello may
parse successfully but contain key shares or other fields that uTLS cannot reproduce. Those dry-run failures
use the same signed policy as capture failures. If Guard cannot parse or safely reproduce a ClientHello for
a catalogued host, it blocks the connection by default. Enforce mode always blocks, including when the signed policy requests tunnelling. Monitor mode may opt
into an uninspected tunnel with signed `settings.unreproducibleTls: "tunnel"`. That explicit exception cannot
apply HTTP content policy to the encrypted stream. Both outcomes generate an administrative event with reason
`tls-client-hello-unreproducible`. Transparent connections without usable SNI use the same policy with the
steered destination address and port. A monitor tunnel exception permits the original stream to that destination;
enforce mode refuses it. The event reason `tls-address-without-sni` identifies this address-based decision;
coverage events omit `ruleKind`, like HTTP coverage failures. Speculative sockets that close or time out before a complete hello close quietly
without a policy event; malformed framing and complete unreproducible hellos still produce coverage events.
Signed extension steering metadata supplies the service for no-SNI flows when supported by both components.
An unknown destination is always refused with host `unknown`; Guard never dials an empty host. When that
first record is not a parseable ClientHello (non-TLS or malformed), the reason is `tls-client-hello-unparseable`
instead of `tls-address-without-sni`.

A later replay-construction failure or TLS handshake failure rejecting the offered parameters
(`handshake_failure`, `illegal_parameter`, `protocol_version`) is reported as `upstream-replay-failed` coverage
rather than an allowed/observed flow. Dial/DNS failures, timeouts, cancellation and certificate verification errors
are ordinary upstream errors, not coverage blocks. They retain the inspected flow/content verdict, as do
connection resets after sending the body. The affected request fails and the failed upstream connection closes. Since downstream
TLS has already terminated, Guard cannot safely restore the original encrypted stream and never tunnels on
that path. It does not retry with a substitute browser fingerprint. The local `/status` report exposes `mode`, `lastClientHelloSHA256`,
`uninspectedConnections`, and `tunnelledConnections` under `upstreamTransport`. The hash is SHA-256 of the generated
upstream ClientHello wire bytes, so it changes between fresh handshakes. These are operational summaries, not
request content or stable client identifiers.

## HTTP protocol and remaining differences

Guard offers the client's ALPN list on the upstream handshake. When both sides negotiate HTTP/2, Guard uses HTTP/2
on each leg. HTTP/1 requests retain their original header order and casing; Guard removes hop-by-hop fields and may
add Host or framing fields when the request parser did not provide them. Since HTTP/2 is terminated and rebuilt,
its SETTINGS and pseudo-header ordering can differ from the client's original wire representation. These HTTP-layer
differences are not represented by the TLS fingerprint hash.

Request trailers cannot override routing, framing, Content-Type or Content-Encoding. Allowed trailer values
are copied after body EOF. For HTTP/2, a proven-unprocessed GOAWAY/REFUSED_STREAM can retry once on a fresh
connection only when the request is empty or its entire inspected body was buffered within the inspection limit.
Oversized and streaming bodies remain non-retryable.

The upstream handshake is fresh: Guard does not forward a client's TLS session ticket or PSK state, so TLS 1.3
PSK/session resumption is not preserved. The provider sees a new handshake with the replayed hello shape. This
design reproduces the observable ClientHello fields supported by uTLS; it does not make the two TLS sessions the
same cryptographic session.

## Local client matrix

`tests/integration/agent-go/tls.test.ts` sends Node, curl and OpenSSL clients through the agent and compares each
client's direct ClientHello with the one the agent replays upstream: the same cipher suites, extension order and
ALPN, without the extensions a new session cannot reuse. This is not a claim of byte-exact replay or an official
JA4 hash. The Go matrix that also ran Python requests/urllib and Chrome was deleted with the Go unit tests.
