# Guard refusal responses

Guard's HTTP JSON block response is compatible with the `vibtra.policy/v1` envelope in
`packages/guard-contract/src/policy/envelope.ts`. It retains HTTP 403 and the existing `GUARD_BLOCKED`, `eventId`,
`action`, `blockPage`, `requestsEnabled`, `service`, `message`, optional `ruleId` and `workspace`
fields. It adds:

- `policy`: a canonical `vibtra.policy/v1` refusal envelope.
- `error`: the protocol's `vibtra: blocked — … (decision pd_…)` rendering.
- `reason`: the envelope's message.
- `x-vibtra-policy-decision`: the same decision ID as `policy.id`, exposed through CORS alongside
  the existing `x-vibtra-guard` header.

JSON responses use `application/json` (UTF-8). HTML clients retain the existing block page and
access-request form, with the decision header added; HTML is not a canonical JSON channel response.
The envelope itself passes the shared protocol validator. The canonical HTTP projection
(`error`, `reason`, `policy` plus its required headers/status) also passes. Guard's complete JSON
body intentionally retains additive legacy fields, so it does not match the protocol producer's
closed minimal HTTP-body schema verbatim.

The reason-code set is open in v1. Guard supplies these additive codes:

| Code | Meaning / next action |
| --- | --- |
| `GUARD_CONTENT_BLOCKED` | A content rule matched. Remove or replace the matched data before retrying. |
| `GUARD_SERVICE_BLOCKED` | Service policy refused the request. Review access through Guard or contact the administrator. |
| `GUARD_SURFACE_BLOCKED` | This action is blocked by a surface policy. Contact the administrator; a per-request approval cannot override it. This does not claim every route on the app or website is blocked. |
| `GUARD_APPROVAL_REQUIRED` | Approval is required before sending. Open the local block page and request access if enabled. |
| `GUARD_INSPECTION_UNAVAILABLE` | Guard could not inspect safely. Ask the administrator to review coverage before retrying. |

An `ask` verdict is a refusal (`decision:deny`), not a fabricated pending request. This response
has not itself submitted an access request and does not invent a request ID or a command unsupported
by Guard. When access requests are disabled, the next action says so. The existing HTTP loopback
block-page URL stays in its legacy field: canonical `open` actions require HTTPS. A configured
workspace offers a fixed-text `use` action without copying its URL into the envelope.

The decision ID is deterministically derived from the Guard event ID; the event's time and policy
bundle revision accompany it. Safe opaque Guard rule IDs are preserved as determining-policy IDs;
otherwise a fixed Guard policy category is used. Envelopes never include body text, matched values,
request hosts/paths/queries, administrator notes, rule display names, app identities or credentials.
The existing legacy JSON fields have not been redesigned by this change.

A client must read the response to show these details. Some vendor clients classify every HTTP 403
as an authentication failure; adding a policy envelope does not change that client behavior.

## Browser block page and desktop notice

An HTML client (`Accept: text/html`) gets the local block page with HTTP 403. It shows the
organisation (the enrolled org's name, else "Your organisation"), the service, the rule (else
"Service policy"), the match kind and count for content rules, the administrator's note, and a
"What to do next" step that follows the same cases as the envelope above: remove the matched data
for a content rule, request access when requests are enabled, otherwise ask the administrator.
A surface block or an inspection failure never offers a request. The access-request form and the
workspace link appear only where the bundle enables them. The page never shows the request host,
path, query, body or redacted snippet, and its URL carries only the event ID
(`/blocked/<eventId>`).

A browser shows that page only for a top-level navigation. Fetch/XHR, SSE, WebSocket and native
clients read the JSON refusal (or a close frame) and show their own error. So every enforced block or
ask streamed to the Mac app carries `delivery`: `page` when the request had `Accept: text/html`,
`Sec-Fetch-Mode: navigate` and a document (or absent) `Sec-Fetch-Dest`; `notice` otherwise. For
`notice`, the Mac app posts one desktop notification that links to the block page. It opens no tab
or window by itself. Retries do not multiply notices: the agent streams only the first block of a
burst with the same action, service, rule, reason and app (`repeatBlockLocked`, a 10 s quiet gap),
and the app applies the same 10 s gap again. Every retry is still refused before the origin and
recorded in local activity, marked `coalesced`. `tests/integration/agent-go/refusal.test.ts` ("the block
page and the desktop notice") and `BlockNoticeIntegrationTests` in `guard/mac` cover this.

## WebSocket boundary

A request refused **before** a WebSocket upgrade can receive the HTTP refusal above. After HTTP 101,
Guard uses the existing RFC6455 close-control frame: code 1008 and the bounded text “Vibtra Guard
blocked this message” for a policy denial. Coverage/protocol/size failures retain their existing
1003/1002/1009 codes. No canonical envelope, event ID, next-action JSON, or fabricated vendor chat
message is injected into the WebSocket stream. If an origin frame was already partly delivered,
existing transport code resets instead of inserting a close frame into that frame's payload.
Local Guard activity carries the separate decision record. A client may display a generic error or
spinner rather than the close reason; this implementation does not claim an in-chat explanation.

`tests/integration/agent-go/refusal.test.ts` checks reasons, truthful ask/surface actions, legacy JSON/HTML behavior,
metadata privacy, decision correlation and the WebSocket close contract. With repository Node/tsx
dependencies installed, it validates actual Go-produced envelopes and HTTP projections through the
canonical TypeScript validators. Existing WebSocket integration tests remain responsible for proving
blocked messages do not reach the origin.
