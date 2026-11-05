# Native relay attribution

The transparent listener accepts an optional signed identity line after the existing PROXY v1 line.
A verified identity describes the code-signing identity of the source process that NetworkExtension
supplied to the extension. The extension resolves its audit token, checks the signature and Apple
anchor/team requirement, and signs the resulting identifier and team. A User-Agent or HTTP header
cannot supply this attribution. With all surface controls off, identity is diagnostic evidence only. An explicitly enabled
surface control may now use a verified identity together with an exact manifest host/method/path
to add a block. It never grants an exemption, changes existing service/content selection, or
broadens a host exclusion. Unknown, legacy and invalid identities cannot claim web-surface coverage.
The experimental manifest currently permits named Chrome signing/team pairs only; native modes
and Safari remain unavailable until their route/identity requirements are established.

The extension creates a P-256 key in memory for each activation. The Guard app requests its public key
through the configured platform provider session (`guard-relay-key-v1`) and atomically writes
`relay-attribution.json` in the agent profile:

```json
{"version":1,"keyId":"SHA256 hex of X963 bytes","publicKey":"base64url unpadded X963 public key"}
```

The key is 65-byte uncompressed P-256 X963. The file contains no private key. The Go reader rejects
symlinks, nonregular files, invalid curves/digests, and files larger than 2048 bytes. The local profile
is a trust boundary: a process or administrator able to replace that profile can replace the pin.
This does not defend against a compromised extension or profile owner.

Wire format, following the exact PROXY line including its CRLF:

```text
VIBTRA_APP_V1 <base64url payload JSON> <base64url raw 64-byte signature>\r\n
```

The JSON contains exactly `version:1`, `keyId`, `issuedAt` (integer Unix seconds), `nonce` (16 random
bytes encoded base64url without padding), `signingId` (1–255 ASCII letters/digits/period/hyphen/underscore),
and `teamId` (10 uppercase ASCII letters/digits). When both the running agent and extension advertise
steering metadata support, it can also contain `steeringHost`: the normalized DNS hostname used by
the extension's steering decision. A signed steering-only claim has empty `signingId` and `teamId`;
it attributes a no-SNI coverage event to a service without claiming a verified source app. The extension
emits it for processes whose signature it cannot verify (for example Homebrew/nvm CLIs, python, curl or a
signing mismatch), so the agent records it as unattributed with reason `no-app-identity`,
`source:network-extension` and the signed `steeringHost`. It never replaces User-Agent app/CLI naming and is
never labelled network-extension attributed; only a non-empty verified `signingId` is an app identity.

`steeringHost` grammar, identical in `NativeRelayAttribution.swift` and `relay_attribution.go`: 1–253 bytes
of dot-separated labels, each 1–63 bytes of lowercase ASCII `a-z`, `0-9` and `-`, not starting or ending with
`-`; the final label must not be all digits. This rejects every IP literal (IPv4 by the final-label rule,
IPv6 by the character set), uppercase, underscores, empty labels and trailing dots. The host is optional and
validated on its own: the extension omits an invalid host and still signs a valid identity, and the agent
drops an invalid host while keeping a valid signed identity. A claim with neither a valid identity nor a valid
host is malformed. The signature is P-256 ECDSA over SHA256 of:
`VIBTRA_APP_V1\n` + exact PROXY line bytes + decoded JSON bytes. Raw signature bytes are 32-byte R
followed by 32-byte S. The complete metadata line is bounded to 2048 bytes.

Claims must be within 60 seconds of the agent clock. A mutex-protected replay cache retains each
accepted key/nonce for 120 seconds, at most 4096 entries; capacity exhaustion yields unattributed
rather than evicting live entries. The cache is per agent process and resets on restart; freshness
still limits old claims. Public pins are reread per claim, so an extension key rotation takes effect
without restarting the agent. Existing connections retain their original verified identity.

A complete invalid claim is consumed and marked unattributed; normal TLS inspection proceeds.
Legacy relays with no line are also unattributed. An incomplete/oversized line closes the malformed
transport within the existing read deadline. Health probes retain their existing protocol.

TLS rows and local activity inspection metadata contain `processAttribution`: either verified
`status`, `source:network-extension`, `signingId`, `teamId`, or unattributed `status` plus a fixed
`reason`. Reasons are `not-provided`, `malformed`, `expired`, `pin-unavailable`, `key-mismatch`,
`invalid-signature`, `replayed`, `replay-capacity`, and `no-app-identity` (a signed steering-only claim, which
also carries `source:network-extension` and `steeringHost`). Nonces, key IDs, signatures, raw payloads,
audit tokens and PIDs are not retained in those records. TLS dedupe includes attribution so two
apps cannot merge into one handshake row. Verified activity uses the signing identifier in the
existing event app bundleId field; its local inspection metadata identifies its provenance.
A signed `steeringHost` (from a verified or steering-only claim) selects the catalogue service for address-steered no-SNI coverage events,
while the event's host/port retain the actual destination. It does not supply SNI or change inspection policy.
User-Agent-derived CLI policy behavior remains unchanged.

The extension initially emits legacy handoffs. Before enabling metadata, the Guard app queries the
**running** agent's uncached `/status`, requires `capabilities.nativeRelayAttribution == 1` and
`proxyListening == true`, writes the current extension public pin, then sends the provider activation
message bound to that key ID. Missing/old capability, failed status or missing pin must keep the
extension in legacy mode. An installed app version is not a capability check. New Go accepts both
legacy and signed handoffs. Activation is a 30-second lease renewed by app refresh; failed or incompatible capability checks explicitly disable it. A rollback occurring between checks can retain activation for up to 30 seconds, so this is not atomic per-flow negotiation. Stop the extension before rolling the agent back to an older binary that cannot parse the preamble.

Steering metadata additionally requires the running agent's `capabilities.nativeRelaySteering == 1`
and provider support confirmed by the app. Legacy attribution activation keeps the payload in its original
shape, so an older agent's strict JSON decoder still accepts process identity. Missing steering capability
omits the new field; it does not disable existing attribution. Steering-only claims cannot select app-specific
surface controls because they carry no signing identifier or team.

No live installation or trust change is needed for the tests: `tests/integration/agent-go/relay.test.ts` drives
the real agent's transparent listener with verified, invalid, replayed and steering-only claims, and reads the
running capabilities from the local HTTP API.
