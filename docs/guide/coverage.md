# What Guard covers

Guard enforces the documented, tested actions on this page. It does not claim every AI service, every request,
every browser or future client features. Hosts and requests outside these rows are not guaranteed to be blocked.

The machine-readable record is `guard/agent-go/surface-coverage.json`. Its evidence entries are private record
identifiers, not files in this repository.

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

## Two kinds of coverage

- **The catalogue** lists 48 AI services (`guard/agent-go/catalogue.json`). For an enabled service, Guard decrypts
  that service's traffic on the Mac and applies service and content rules. Being in the catalogue is not a promise
  that every client or route of that service is blocked.
- **App and website switches** block one chat client's send action. They are the four switches under **Rules**,
  **Apps and websites**. The rest of this page is about them.

## How a switch decides

A switch matches all of these at once:

- the exact host, method and path pattern of the send request; and
- the signed app that made it, checked by macOS from the process's code signature.

Headers, the User-Agent, app names or the host alone never pick a switch. A match is refused before the request body
is read and before any connection to the service opens, with HTTP 403 and a `vibtra.policy/v1` refusal. Blocking a
whole host, or blocking by DNS, could not do this: claude.ai and chatgpt.com serve both the blocked and the allowed
clients.

## What was tested

Live acceptance on 22 October 2026, in an isolated macOS virtual machine, with synthetic prompts ("reply with the
single word PONG"). Each verified row was checked blocked with the switch on, allowed with it off, working again
after it was turned off, and with no effect on the other clients listed.

| Item | Version |
|---|---|
| macOS | 26.6.2 (supported minimum: macOS 14; earlier versions were not part of this acceptance) |
| Guard | development builds 30 to 34 (the block, allow and recovery rows ran on builds 31 to 34), not a release build. The signed release has not been through this acceptance yet. |
| Google Chrome | 156.0.8078.48 |
| Claude for macOS | 3.1623.1 |
| Claude Code | 2.1.308 |
| ChatGPT for macOS | 26.1016.51333 (ChatGPT and Codex in one app) |
| Codex CLI | 0.163.0-alpha.11 |

A newer client release does not inherit "verified". It has to be captured and tested again.

"Content rules" below says whether content rules (keywords, card numbers and so on) have been shown to work on that
same send request: **checked separately** means in tests outside this acceptance; **not proven** means not shown yet.
Service rules and switches do not depend on it.

### Block the Claude website (`claude-web`)

claude.ai in Google Chrome only.

| Action | Status | Content rules |
|---|---|---|
| Send a text chat message | Verified | Not proven |
| Retry or regenerate | Candidate: in the rules, not tested live | Not proven |
| File upload, connectors and MCP, voice, artifacts, projects | Untested. Not blocked by this switch. | |
| Sign-in, session refresh and the site's telemetry | Deliberately allowed | |
| Safari, Firefox, Edge and other browsers | Unsupported | |

Not affected when on (tested): the Claude Mac app and Claude Code.

### Block the Claude macOS app (`claude-macos`)

Claude for macOS 3.1623.1, the Chat tab.

| Action | Status | Content rules |
|---|---|---|
| Send a text chat message | Verified | Checked separately |
| Retry | Candidate: in the rules, not tested live | Checked separately |
| The older 2.x app's send | Untested. Not in the rules. | |
| Code tab, file upload, connectors, voice, updater, telemetry | Untested or allowed. Not blocked by this switch. | |

The app shows its own generic error. Guard's notification gives the reason. Not affected when on (tested): claude.ai
in Chrome and Claude Code.

### Block the ChatGPT website (`chatgpt-web`)

chatgpt.com in Google Chrome only.

| Action | Status | Content rules |
|---|---|---|
| Send a text message, signed in | Verified | Checked separately |
| Send a text message, signed out | Verified | Not proven |
| Two older conversation routes the current site does not use | Untested. Not in the rules. | |
| File upload, voice, image generation, GPTs and apps, connectors, deep research | Untested. Not blocked by this switch. | |
| Shared sign-in, request checks and telemetry | Deliberately allowed, because Codex uses them too | |
| Other browsers | Unsupported | |

Not affected when on (tested): the Codex CLI and the ChatGPT Mac app in both modes.

### Block the ChatGPT macOS app, ChatGPT and Codex (`chatgpt-macos`)

ChatGPT for macOS 26.1016.51333.

| Action | Status | Content rules |
|---|---|---|
| Send in ChatGPT mode and in Codex mode | Verified, both together | Checked separately |
| The app's fallback after a refused connection | Verified | Checked separately |
| Block ChatGPT mode only and leave Codex working | Not possible | |
| The Codex CLI inside the app | Blocked too | |
| A separately installed Codex CLI | Not covered | |
| Uploads, voice, images, connectors, updater, telemetry | Untested or allowed | |

**Why one switch.** The app sends both modes over the same connection, to the same address, from the same signed
process. Guard cannot tell them apart, so it cannot block one without the other. Not affected when on (tested):
ChatGPT in Chrome. The acceptance summary also records Claude and Claude Code as unaffected; those two have no
numbered result row.

## Limits

- **New requests only.** A reply that is already streaming is not cut off.
- **Vendor errors.** The Mac apps and websites show their own generic error. The reason, rule and next step are in
  Guard's notification and block page. No in-chat explanation is claimed. See
  [troubleshooting.md](troubleshooting.md#what-a-block-looks-like).
- **Notification timing.** Guard acts when a client opens a connection. ChatGPT mode and the websites may open one
  while you type, so the notification can appear before you press Send. Codex mode connects on Send.
- **One notification per burst.** Repeated blocks of the same switch or rule, service and app within 10 seconds of
  each other give one notification. Every attempt is still recorded.
- **Unattributed apps.** A switch needs a verified app identity. Traffic Guard cannot attribute to a signed app is
  never matched by a switch. Service and content rules still apply to it.

## Availability: Guard fails open

Guard is built so that an AI site never hangs because of it.

- If the agent stops answering, the network extension sends AI traffic straight to the service. That traffic is
  not checked. A connection that the agent does not answer within 3 seconds is replayed directly.
- The extension checks the agent every 2 seconds. Checking resumes for new connections once it answers.
- The app does not start itself at login in this release, so after a restart traffic is unchecked until Vibtra Guard
  is opened. See [restart.md](restart.md).
- HTTP/3 (QUIC) to catalogued AI hosts is dropped, so browsers fall back to HTTPS over TCP, which Guard checks.
  A managed Chrome can also turn QUIC off with the `QuicAllowed: false` policy.

## When Guard cannot inspect

Guard cannot protect some Macs: a Mac without a Secure Enclave, a Mac where Guard cannot make its key, and a build
not signed by your Apple team. On these Macs Guard does not decrypt AI traffic. It passes through unchecked.

- Blocks that need Guard to read the request do not apply: app and website switches and content rules.
- A service rule set to block or ask still applies in one case: the network extension is on and the Mac is in
  Enforce mode. The extension then drops all traffic to that service. Tools that use Guard as a proxy
  (`HTTPS_PROXY`), and builds that cannot turn the extension on, get no blocks at all.
- The Mac shows **This Mac is not protected**, and the dashboard lists it as not protected.

A new Guard certificate that is not trusted yet also lets AI traffic through unchecked, and the panel asks the user
to trust it. Through the network extension, AI requests go through within a few seconds. Tools that use Guard as a
proxy wait up to about 90 seconds first. Checking resumes once the certificate is trusted.

While the Guard app is restarting, or when Guard cannot sign a certificate for one site, the network extension sends
that traffic straight to the service within 3 seconds, as described above. Tools that use Guard as a proxy get an
error (HTTP 502) instead.

## Local inspection

- Content rules run on the Mac, in memory. Request bodies are never stored and never sent to the server.
- Bodies up to 4 MiB are checked: JSON, URL-encoded forms, multipart text and file names, plain text, and common
  compressed forms. Readable protobuf and Connect fields are checked too.
- PDF, image and Office file contents, and client-side encrypted content, are not inspected.
- In Enforce mode, a body Guard cannot read safely (unreadable, or in an encoding it does not know, or too large when
  compressed or Connect-framed) is refused with `GUARD_INSPECTION_UNAVAILABLE`. In Monitor mode it is recorded and let
  through.
- An uncompressed body over 4 MiB is not inspected. Service rules and switches still apply, but content rules cannot
  match it, so it is let through.
- Traffic to hosts outside the enabled catalogue is not decrypted.

## What Guard reports

- Each event is metadata only: the service, host, app, rule, match type and count, size and time. A short redacted
  fragment is kept only when the organisation's setting allows it (**Settings**, redacted examples).
- The server rejects an uploaded event with any extra field. It does not accept prompt or file contents.
- The Mac keeps its recent activity in memory (the last 300 decisions) and queues events until the server
  acknowledges them.
- The AI services' own telemetry is not Guard's. Guard lets it through and does not read it for reporting.
