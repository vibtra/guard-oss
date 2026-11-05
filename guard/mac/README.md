# Vibtra Guard for macOS (`guard/mac`)

The laptop app of Vibtra Guard v0 (issue #24, `docs/guard.md` §7): a SwiftUI **menu-bar app** that bundles and
supervises the Go/uTLS agent (`guard/agent-go`), handles `vibtra-guard://` links, and installs **one system extension**
holding both Network Extension providers. Apache-2.0, like the rest of `guard/`.

**Management is the web dashboard only** ([ADR 0001](../../docs/decisions/0001-web-dashboard-only.md)). The native
Overview/Activity/Rules dashboard (`GuardDesktop.swift`, `DesktopWindow.swift`) is deprecated: launch, reopen, the menu
bar and `vibtra-guard://` links never open it, and the floating Blocked window is no longer shown. The code stays until
a later cleanup; `BlockNoticeTests.testNoEntryPointOpensTheNativeDashboard` keeps it unreachable. The menu-bar panel
keeps minimal setup only: enrol, trust the certificate, the extension's approval action, protection status, **Open web
dashboard** (`<server>/<org>/guard` from the enrolment) and **Remove Guard…** ([docs/removal.md](../../docs/removal.md)).

When Guard blocks something, a browser navigation shows the agent's HTML block page in the tab. Fetch/SSE/WebSocket
and native clients cannot show it, so the agent marks those decisions `delivery: notice` and the app posts one
notification per retry burst that opens the same page when clicked (`Shared/BlockNotice.swift`,
`VibtraGuard/BlockNotifier.swift`, [refusal.md](../agent-go/refusal.md)). It never opens a tab or window by itself.

| Target | Bundle id | What |
|---|---|---|
| `VibtraGuard` (desktop app + menu-bar companion) | `app.vibtra.guard` | menu-bar panel (person, org, mode, last sync, today's allowed / blocked / asked from `GET 127.0.0.1:9471/status` every 10 s); Enrol…; Trust the Guard certificate; Trust for command-line tools…; Start/Stop agent (supervised `Contents/MacOS/vibtra-guard run --transparent 127.0.0.1:9472`, restart with 1→60 s backoff, log to `~/Library/Logs/Vibtra Guard/agent.log`); Open block page; Open web dashboard; the extension's one action (Install / Turn on / Turn off / Open settings, from the state macOS reports); Remove Guard… (`Contents/Resources/uninstall-guard.sh`); SSE subscriber on `/events` → block notice; URL scheme `vibtra-guard` |
| `VibtraGuardExtension` (system extension) | `app.vibtra.guard.extension` | `FilterDataProvider` (`NEFilterDataProvider`) + `TransparentProxyProvider` (`NETransparentProxyProvider`), both in `NEProviderClasses`, plus an XPC Mach service the app feeds |
| `VibtraGuardIntegrationTests` (tests, no host app) | `app.vibtra.guard.integration-tests` | Swift tests, several against the real agent binary: address steering and the steering rules, the fail-open relay, relay attribution, the host matcher against the shared vectors, the agent's local pages, block notices, the extension inbox and status, the app inputs, the Codex exclusion, the CLI-trust snippet |

`Shared/` is compiled into all three: the contract subset (`GuardModel.swift`), the host matcher (`HostMatcher.swift`,
a port of `packages/guard-contract/src/catalogue.ts`, pinned by `detectors.vectors.json`), the PROXY v1 formatter,
the extension ↔ app XPC protocol and the steering rules, and the lenient parsing of the agent's local pages.

## Identity (team and bundle IDs)

The team ID and the app and extension bundle IDs are build inputs, not constants. `Config/Identity.xcconfig` holds
Vibtra's defaults (team `P2UU927A6W`, `app.vibtra.guard`, `app.vibtra.guard.extension`); a git-ignored
`Config/Identity.local.xcconfig` overrides them for a checkout, and `GUARD_TEAM_ID` / `GUARD_APP_ID` /
`GUARD_EXTENSION_ID` override them for one `build.sh` run. `project.yml` derives the app group, the extension's Mach
service and the agent's signing identifier, and writes all six into both `Info.plist`s (`GuardTeamID`,
`GuardAppBundleID`, `GuardExtensionBundleID`, `GuardAppGroup`, `GuardExtensionMachService`, `GuardAgentSigningID`).
`GuardConstants` reads them from the bundle; `build.sh`, `release.py`, `uninstall-guard.sh` and
`tools/mdm-profile.py` read the same inputs (`tools/identity.py`). `tools/sign-guard.py` signs, notarizes and packages
a release tag under another team; `templates/re-sign-guard.yml` runs it in a customer's CI
([docs/guide/self-signing.md](../../docs/guide/self-signing.md)). The pattern is WireGuard's `Developer.xcconfig`.
Pass overrides through the xcconfig, not as `xcodebuild` settings: Xcode names the embedded extension from the
xcconfig chain only. Customer guide: `docs/guide/managed-macs.md`.

## Build, test, run

```sh
brew install xcodegen                      # once
zsh guard/mac/build.sh                     # signed attempt, then unsigned fallback; last line: SIGNED or UNSIGNED + why
zsh guard/mac/build.sh --unsigned          # skip the signed attempt
zsh tests/mac/run.sh                       # tests/mac/test_*.py, then the VibtraGuardIntegrationTests scheme
python3 -m unittest discover -s tests/mac -p test_release.py -v   # release preflight/build refusal tests, offline
python3 -m unittest discover -s tests/mac -p test_uninstall.py -v # uninstall-guard.sh against a temporary HOME and stand-in tools
open guard/mac/build/Debug/VibtraGuard.app
```

`project.yml` is the source; `VibtraGuard.xcodeproj` is generated by `xcodegen generate` (build.sh runs it) and
committed. The **Bundle the agent** build phase copies `$VIBTRA_GUARD_AGENT_BIN` or
`guard/agent-go/build/vibtra-guard` into `Contents/MacOS/vibtra-guard` and signs it with identifier
`app.vibtra.guard.agent` (ad hoc when unsigned). Packaging requires that binary; `build.sh` builds it first. If an agent already answers on 9471 (a developer's agent process), the app
uses it and does not start its own.

Without the agent: `python3 guard/mac/tools/fake-agent.py [--mode enforce|monitor] [--every 10]` serves `/status`,
`/events` (a `synced`, then a `decision`: TFN blocked on ChatGPT), `/blocked/:id`, `/blocked/:id/request` (approved
20 s later, pushed as `ask-decided`) on 127.0.0.1:9471.

Links the app handles: `vibtra-guard://enrol?server=<url>&token=genr_…` (Enrol, pre-filled),
`vibtra-guard://status` (the panel in a window), `vibtra-guard://install-extension` (the menu item, scriptable),
`vibtra-guard://enable-extension` (the panel's Turn on) and `vibtra-guard://disable-extension` (Turn off network
protection: both configurations disabled, the proxy stopped — the instant rollback for live tests,
`open vibtra-guard://disable-extension`; honoured in Debug builds only, so a web page cannot switch a Release build off).

## What the app reads from the agent (contract gap)

`packages/guard-contract` fixes the PATHS of the agent's local pages but not their JSON. The app parses leniently
(`Shared/AgentLocal.swift`) and expects, from the agent lane:

- `GET /status` → `{ enrolled, agentVersion, deviceId, hostname, person{email,name?}, org{name,handle}, clientMode,
  lastSyncAt, lastSyncError?, bundleVersion, today{allowed,blocked,asked}, settings{requestsEnabled,
  workspaceRedirect{enabled,url?}}, lastBlocked{eventId}, ca{trusted}? }` (also accepted: `mode`, `counts`,
  `personEmail`, `orgName`, `lastBlockedEventId`).
- SSE `decision` → a GuardEvent-shaped object (top level or under `event`) plus `serviceName`, `ruleName`, `enforced`
  (false in monitor mode — no popup), `requestsEnabled`, `workspace{enabled,url}`; `snippet`/`example` is the redacted
  fragment (≤ 80). `synced` → anything (the app re-reads `bundle.json` / `catalogue.json`). `ask-decided` →
  `{ eventId, request{status} }`.
- `POST /blocked/:id/request` `{note?}` → `{ request: GuardAskView }`; `GET /blocked/:id/status` →
  `{ eventId, status, applied }` (polled every 10 s while the window says "Waiting for IT"; `/request` as fallback).

Checked against the agent lane's work in progress (`guard/agent/src/agent.rs` `status_json`, `local.rs`, uncommitted
when this landed): `/status` carries `lastSync{at,ok,error}`, `today`, `caTrusted`, `person`, `org`, `clientMode` —
read as above. Both the `decision` event (`requestsEnabled`, `workspace{enabled,url}`) and `/status`
(`settings{requestsEnabled, workspaceRedirect{enabled,url}}`) carry what the Blocked window offers (docs/guard.md §7),
so it offers "Use the company Vibtra workspace" when IT turned it on. Its PROXY v1 parser accepts
`UNKNOWN`, which the transparent proxy sends for host-name endpoints.

A strict `agent-local.ts` in the contract would let this become plain Codable; proposed to the planner.

## The Network Extension: what it does, and what it cannot do yet

### Disabled Codex work app (build 21)

An explicitly disabled `openai-codex` catalogue row exempts the verified signed OpenAI Codex app/helper/CLI at the
socket boundary, including address-based routing, alternate TCP ports, QUIC and DNS peeking. OS audit-token identity,
Apple trust anchor, exact signing identifier and OpenAI team are checked; an ad-hoc identifier or User-Agent is not
proof. This is conditional policy behavior, not an unconditional production exemption. Separate `com.openai.chat`,
Claude and ordinary browsers remain protected. Codex's embedded browser shares its helper exemption, so cannot prove
web enforcement. Enabling the row affects new sockets; existing direct sessions require reconnect/client restart.

**Content filter** (`FilterDataProvider`): every outbound TCP flow with a `remoteHostname` that matches an enabled
catalogue row → `serviceForFlow(host, source app signing id)` (signing id from the flow's audit token) →
`decideFlow` on the agent's bundle: allow → `.allow()`; block/ask in **enforce** mode → `.drop()` and a GuardEvent
line (`kind flow`, `action blocked|asked`); monitor mode → allow (the agent records the would-block — recording here
too would double-count). Non-catalogued flows are allowed untouched. No content inspection here: that stays the
agent's.

**Transparent proxy** (`TransparentProxyProvider`): `includedNetworkRules` = TCP 443 to each steered domain
(`SteeringRules`: a pattern with a `*` label becomes the suffix after it — `bedrock-runtime.*.amazonaws.com` →
`amazonaws.com`, an approximation; NENetworkRule's 2+-label host covers the whole DNS domain). `handleNewFlow` then
decides with `ProxySteering.decide` (`Shared/FlowSteering.swift`, unit-tested) and returns **false** — the system
sends the flow itself — unless the flow is TCP 443 to a host that EXACTLY matches an enabled catalogue row, is not
the agent's own. Health chooses the relay leg after the extension owns the flow. A healthy steered flow → `NWConnection` to
127.0.0.1:9472 (2 s deadline) → the PROXY v1 line → bytes both ways. A hostname endpoint is sent as
`PROXY UNKNOWN\r\n` (v1 allows only IP literals; the agent reads the host from SNI, port is 443).

**Fail open** (the rule: an AI site never hangs because of Guard; mitmproxy's macOS redirector, MIT, read for
behaviour only). The moving parts live in `Shared/FlowRelay.swift` (`AgentMonitor`, `FlowRelay`) so the harness test
can drive them outside the extension; the decisions are pure in `Shared/FlowSteering.swift`.

- **Health is an application round trip, not a TCP connect** (build 3). Build 2's live test: with the agent
  SIGSTOPped, the kernel still completed handshakes from the listen backlog, the connect-only probe said "up", and
  new connections to chatgpt.com / gemini.google.com hung the client's full 12 s. `AgentMonitor` now writes
  `PROXY UNKNOWN vibtra-health\r\n` (a legal PROXY v1 line) to 127.0.0.1:9472 and wants `VIBTRA-GUARD OK\r\n` back
  within 750 ms (connect included), every 2 s in every state. Two misses in a row → down; one answer → up; unknown
  counts as down. While down, the extension keeps ownership and relays directly without waiting for the agent.
  A miss reported by a flow triggers a probe at once. Verified recovery retires owned direct connections so clients
  establish new connections through the agent. A successful application probe also retires fallbacks created while
  health stayed up. Existing TLS sessions are never migrated or replayed midstream. Slow upstreams that repeatedly
  exceed the answer deadline may therefore force reconnects instead of retaining an indefinite direct bypass.
- **A taken flow must be answered, not just connected.** Agent connection `.waiting` / `.failed` / no `.ready` in 2 s
  → relayed DIRECTLY to its own host and port. Once ready, the agent must send its first byte back (the MITM's
  ServerHello, or the real one for a blind tunnel) within **3 s**. Until it does, every byte the app sent is kept in a
  64 KiB `ReplayBuffer`; a silent agent (or one that closes before answering) is abandoned and those bytes are
  replayed to the destination on a fresh connection — nothing had reached the app, so it cannot tell. If the first
  flight no longer fits the buffer (before the agent answers, or while the direct connection is still coming up), the
  flow is closed with an error — never continued headless. Silence and an early close do not count as monitor misses:
  they trigger an immediate probe and only probes mark the agent down, so an upstream slower than 3 s behind a healthy
  agent costs that one flow a direct relay (it bypasses Guard) rather than switching steering off for everyone. Only
  an agent connection that never becomes ready counts as a miss. No new agent-side ack: the first returned byte
  is the ack, so old and new agents both work.
- The direct connection has 15 s: `.waiting` there means the destination itself is not answering yet (a moment with
  no route, a captive portal), so the flow keeps waiting as a plain client would; only `.failed` or the deadline close
  it with an error. The agent's listener has its own deadlines (PROXY line 5 s, ClientHello 10 s, CONNECT 20 s), and
  its accept loop only accepts (each connection in its own task; accept errors back off 50 ms).
- **Tested end to end** by `VibtraGuardIntegrationTests/FailOpenIntegrationTests.swift`: the real agent binary on ephemeral ports
  (never 9470-9472), SIGSTOPped; a steered connection still gets its answer directly in ~3 s with the ClientHello
  replayed byte for byte, the monitor marks the agent down, an unreplayable flow is closed, and SIGCONT restores
  steering. It installs and signs nothing.

**Live check of the fail-open path (1 minute, the installed app):**

```sh
A=$(pgrep -f 'vibtra-guard run'); echo "agent pid $A"
t() { curl -sk -m 12 -D - -o /dev/null -w 'took %{time_total}s\n' https://chatgpt.com/ | grep -iE 'x-vibtra-guard|took'; }
t                              # X-Vibtra-Guard: observed, well under 1 s (through the agent)
kill -STOP $A; t               # no header, took ≤ ~3.5 s (agent silent → ClientHello replayed direct), not 12 s
sleep 6; t                     # no header, fast (agent marked down: the flow is not taken at all)
kill -CONT $A; sleep 3; t      # header back
log show --last 2m --predicate 'subsystem == "app.vibtra.guard.extension"' | grep -E 'not answering|answers|relaying direct'
```

**QUIC** (`FilterDataProvider`): the filter also sees outbound UDP. UDP 443 to a catalogued AI host is dropped
(`FlowVerdict.decideDatagram`), so Chrome / Safari / Firefox fall back to TCP, which the proxy steers; all other UDP
is untouched. A QUIC socket is usually connected to an ADDRESS with no name, so the host comes from the flow's own
name if it has one, else from `HostAddressCache` — filled from named TCP flows to AI hosts and from resolving the
catalogue's concrete hosts every 5 minutes. An AI host on a shared front end (Google's) therefore makes QUIC to that
address fall back to TCP for everything on it — Google Search and YouTube beside gemini.google.com /
notebooklm.google.com / aistudio.google.com, Facebook beside meta.ai, Microsoft 365 beside copilot.microsoft.com /
sydney.bing.com. Harmless (the same fallback, TCP still works), and the enterprise norm (Zscaler, Netskope, Palo
Alto all say "block UDP 443"), but not host-exact: kept for v0, and the follow-up below (SNI from the QUIC Initial)
makes it exact in both directions.

The drop is by remote ADDRESS, so it has a gap in the other direction too: a QUIC socket to an address the
extension never learnt is allowed. Chrome's own resolver (and Secure DNS) can hand Chrome a different front-end or
anycast address than the extension's `getaddrinfo` returned, and its TCP flows may carry no `remoteHostname` to
teach the cache. **Not yet verified for Chrome** — only curl (system resolver) was seen live. If the live check below
shows Chrome still reaching an AI host over HTTP/3, the fix is a host-exact drop: return `.filterDataVerdict` for UDP
443 flows with no known host and read the SNI from the QUIC Initial in `handleOutboundData` (RFC 9001: the Initial
keys derive from the client's DCID, no secrets needed), dropping only on a catalogue match. Until then, the
guarantee on a managed Mac is Chrome's **`QuicAllowed: false`** policy (MDM / `com.google.Chrome` profile).

**Browsers that resolve names themselves (build 4).** Host rules (`includedNetworkRules`) and
`NEFilterSocketFlow.remoteHostname` only know a name the SYSTEM resolver saw. Chrome's built-in DNS client, Node and
Firefox's TRR resolve the name themselves and connect to an ADDRESS — seen live on 17 Oct 2026: Chrome reached
chatgpt.com with its real (WE1 / Google Trust Services) certificate and the agent saw no Chrome flow, while `curl`
(by name) was steered. Build 4 steers by address too, the way mitmproxy's macOS local mode and enterprise SWGs do
(decide per flow, then by SNI):

1. **Learn the addresses of ENABLED catalogue hosts** (`ExtensionState.addresses`, a `HostAddressCache`): the extension
   resolves the catalogue's concrete hosts every 5 minutes, learns from named flows to AI hosts, and the content filter
   peeks at the first answer of every UDP flow to port 53 (`DNSAnswer`; always allowed, never held) — so Chrome's own
   lookups teach it the addresses Chrome is about to use. Only the FIRST inbound datagram of each UDP/53 flow is
   read: mDNSResponder (getaddrinfo) and Chrome open a socket per query, but a resolver that reuses one socket (c-ares,
   i.e. Node `dns.resolve`) teaches only its first answer — named flows and the 5-minute resolution cover the rest.
   A row switched off purges its addresses at once (`ExtensionState.load`, whichever provider is running).
   The DNS peek lives in the CONTENT FILTER, not the proxy, so the agent health probe cannot undo it: if lookups
   ever stall after an install, roll back with `open vibtra-guard://disable-extension` — quitting the app does NOT
   stop the filter. Check on install: the `log stream` below shows `learnt N addresses of <host> from a DNS answer`
   and `dig chatgpt.com` latency is unchanged.
2. **Steer TCP 443 to those addresses**: one /32 or /128 `NENetworkRule` per address (at most 512), next to the host
   rules, re-applied when the set changes (the first new address at once, then at most once a second).
   `ProxySteering.decide` takes an address-only flow when its address maps to an enabled host
   (`.steerByAddress`) — never a loopback, private, link-local or CGNAT address, never the agent's own flow, never
   while the agent is down — and writes `PROXY TCP4|TCP6 … <address> … 443`.
3. **The Go agent decides by SNI** (`guard/agent-go/transparent.go`): an enabled catalogue host is intercepted.
   Any other SNI is tunnelled to the original destination. A complete no-SNI or
   unreproducible TLS hello follows the signed Uninspectable TLS policy: block by default and always under enforce;
   only monitor plus an explicit tunnel preference permits an uninspected tunnel. These coverage events record the
   destination and process attribution. Incomplete idle or closed preconnections are closed quietly.
   The native dashboard is deprecated under ADR 0001; inspect TLS coverage events in the web console Activity and
   Overview. No native uninspected counter is planned.
4. **QUIC**: the content filter already drops UDP 443 to those same addresses, so Chrome falls back to TCP. Other
   sites on a shared address (a CDN front end) lose HTTP/3 too and ride a blind tunnel through the agent.

Limits, honestly: DNS over HTTPS (Chrome Secure DNS in "automatic" mode upgrades to DoH when the system's resolver
supports it; Firefox TRR) is not seen, so those lookups are covered only by the 5-minute resolution, which can miss a
CDN's rotating addresses. The first connection after a never-seen address can beat the rule re-apply and go direct
(the re-apply is asynchronous): in a fresh profile the first load of chatgpt.com may show the real certificate once;
reload or open a second tab and expect `X-Vibtra-Guard` on that connection. The `BuiltInDnsClientEnabled=false`
policy below closes this race. Sites sharing an address with an enabled AI host lose HTTP/3 and ride a blind
tunnel. The cache keeps one host per address (the last seen), so a `steering … (an address last seen for <host>)`
or `dropped QUIC` line can name the wrong site on a shared address — cosmetic, since the agent decides by SNI.
**An address-steered flow whose SNI is not enabled still passes through the agent** (blind): if the agent dies
mid-flow that connection drops (new flows go direct within one health probe). **Encrypted Client Hello**: with ECH
the browser sends an OUTER SNI (e.g. `cloudflare-ech.com`) and hides the real name; the agent correctly tunnels that
blind, so an AI zone that turns ECH on would bypass interception (fail-open, never a wrong interception). Not a
factor on 17 Oct 2026: the HTTPS records of chatgpt.com and chat.deepseek.com advertise `alpn=h2` with no `ech` key,
and gemini.google.com has no HTTPS record. The `EncryptedClientHelloEnabled=false` policy below closes it.

**Managed Macs (the enterprise path)**: push these Chrome / Edge policies by MDM (a configuration profile for
`com.google.Chrome` / `com.microsoft.Edge`) so the browser uses the system resolver and TCP, and the name rules see
every flow:

| Policy | Value | Why |
|---|---|---|
| `BuiltInDnsClientEnabled` | `false` | Chrome / Edge resolve through the system (flows are opened by name) |
| `DnsOverHttpsMode` | `off` | no DoH lookups that bypass the system resolver |
| `QuicAllowed` | `false` | no HTTP/3: everything on TCP 443 |
| `EncryptedClientHelloEnabled` | `false` | the real host name stays in the SNI the agent decides by (no ECH outer SNI) |

Firefox: `DNSOverHTTPS` → `Enabled: false, Locked: true`, `network.http.http3.enable=false` and
`network.dns.echconfig.enabled=false` via its enterprise policies. Zscaler, Netskope and Palo Alto give the same advice for their endpoint agents.

**Before any live check with address steering (build 4+) — the Anthropic constraint.** Address steering catches
every process that connects by address, Node (and so Claude Code) included, and the agent then decides by SNI. In
catalogue `2026-10-16+org.1` (what the demo registry still serves) `api.anthropic.com`, `console.anthropic.com` and
`statsig.anthropic.com` sit INSIDE the `anthropic-claude` row — there is no separate `anthropic-api` row — and
claude.ai and api.anthropic.com share an address (160.79.104.10). Switching the Claude row ON in that shape steers
Node's api.anthropic.com flows by address and the SNI check then INTERCEPTS them (seen in the build-4 review: a
Guard-minted certificate for SNI api.anthropic.com). So: **with the old catalogue shape the Claude row stays OFF**,
and there is no claude.ai live test until the registry serves the contract catalogue with a separate `anthropic-api`
row, the agent has re-synced, and `should_intercept("api.anthropic.com")` is confirmed false with that row OFF (the
agent's `/status` or `catalogue.json` rows). Before and after every live step, check
`curl -sv https://api.anthropic.com/ 2>&1 | grep issuer` does not name the Vibtra Guard CA; if it does, roll back
(`open vibtra-guard://disable-extension`) and stop.

**Narrow the blast radius for the first build-4 install.** The demo org has 46 enabled rows, and Google
(gemini.google.com shares 142.251.15x.x front ends), Microsoft, Grammarly and Hugging Face addresses are shared with
high-traffic non-AI sites: those sites lose HTTP/3 and ride blind tunnels through the agent (dropped if the agent
dies mid-flow). For the first install enable only the rows under test (`openai-chatgpt`, `deepseek`,
`google-gemini`), watch the volume of `steering … possibly shared` lines in the log, and widen afterwards.

**Live check (3 minutes, the founder's Mac, agent running with `--transparent 127.0.0.1:9472`):** in a terminal start
`log stream --predicate 'subsystem == "app.vibtra.guard.extension"' --level debug`, turn the extension on, then in
Chrome AND Safari load chatgpt.com and gemini.google.com, then turn it off. (The signal lines — per-flow steering,
`dropped QUIC`, `agent listener … is up`, `agent unreachable, relaying direct` — are logged at `notice`, so
`log show --predicate 'subsystem == "app.vibtra.guard.extension"' --last 5m` afterwards also has them; `info` and
`debug` lines are not kept by the log store.) Expected:
`steering chatgpt.com:443 from com.google.Chrome… to the agent` lines from the proxy for the browser's page loads, and `dropped QUIC to …` from the filter for both hosts.
If chrome://net-internals shows `h3` for either host, or no steering lines appear for Chrome, apply the fixes above
(or the Chrome policies).

**The agent's own flows** are never steered or dropped (they would loop into the agent), and neither are the
extension's own (`app.vibtra.guard.extension`: the fail-open relay's direct connection, which the content filter
would otherwise drop on a blocked row and count twice). The signing identifier
alone is not proof, so a Release build also requires the process to be signed by team P2UU927A6W
(`SigningIdentity.isOwnAgent`); a Debug build accepts an unsigned development agent. Signature reads are cached per
audit token (one per process instance). A process that calls itself `vibtra-guard*` but fails the team requirement
is logged once (category `signing`): an error in Release, where its upstream flows would be steered back into the
agent and end only at the agent's 20 s CONNECT deadline.

**Release checklist (the extension):** the agent binary shipped in the app (and any agent distributed on its own,
npm included) must be **signed by team P2UU927A6W** — check `codesign -dv --verbose=4 <agent>` shows
`TeamIdentifier=P2UU927A6W`; an ad-hoc or unsigned agent breaks with a Release extension. Check the extension log
for the `signing` error after the first steered flow.

**Feeding it** (honest): a system extension runs as **root**, so the App Group container `<team>.<app ID>` (`P2UU927A6W.app.vibtra.guard`) it
sees is root's, not the person's. The app therefore hands documents over by (1) the filter's `vendorConfiguration`
and the proxy's `providerConfiguration` at install, and (2) XPC `update(bundle:catalogue:)` after every `synced`
event. It still mirrors the files into its own group container, as briefed, once the extension is on. **The
extension's events** come back over XPC (`drainEvents`) and the app appends them to
`<agent data dir>/events-from-extension.jsonl`; **the agent must fold that inbox into its upload queue** — not done
by the agent lane yet (a gap, reported).

**Until it is signed**: nothing in the extension runs. `OSSystemExtensionRequest` fails at once, cleanly, and the
panel shows it. Captured on this machine (unsigned build, 16 Oct 2026):
`activation failed: Missing entitlement com.apple.developer.system-extension.install (OSSystemExtensionErrorDomain …)`
(screenshot `mac-extension-unsigned.png`). Interception then is the agent's explicit proxy (:9470) only. Even signed,
activation also needs the app in `/Applications` and the person's approval in System Settings → General → Login
Items & Extensions → Network Extensions (the panel says so).

Entitlements (comment-free plists — AMFI rejects comments, `apps/hello-dmg/NOTARIZE.md`). The extension is
sandboxed and carries `com.apple.security.network.client` — without it every connect, loopback included, fails with
EPERM (the build of 16 Oct 2026). Debug uses `*.dev.entitlements` (the plain values development profiles grant),
Release the `-systemextension` values; `project.yml` sets both, so `xcodegen generate` keeps them.
`com.apple.developer.networking.networkextension` = `content-filter-provider-systemextension`,
`app-proxy-provider-systemextension` (a transparent proxy is an app-proxy provider; the brief's
`transparent-proxy-systemextension` is not an Apple value), `com.apple.security.application-groups` =
`<team>.<app ID>` (`P2UU927A6W.app.vibtra.guard`); the app adds `com.apple.developer.system-extension.install` and app-sandbox **false** (it
runs the agent via `Process`); the extension is sandboxed. If Apple's development profile only carries the plain
values (`content-filter-provider`, `app-proxy-provider`) the signed build's error says so — use those for
development and the `-systemextension` values for Developer ID.


## Founder steps

1. **Xcode → Settings → Accounts**: select the Apple account (team P2UU927A6W) and sign in again (its login was
   rejected). Nothing else in Xcode needs touching.
2. **developer.apple.com → Certificates, Identifiers & Profiles → Identifiers**: Xcode can create these itself in
   step 3; if it does not, create App IDs `app.vibtra.guard` (capabilities: Network Extensions, System Extension,
   App Groups) and `app.vibtra.guard.extension` (Network Extensions, App Groups), and the App Group
   `P2UU927A6W.app.vibtra.guard` assigned to both. Register this Mac under Devices if Xcode asks (Mac development
   profiles name devices).
3. `zsh guard/mac/build.sh` — `-allowProvisioningUpdates` mints the Mac App Development profiles; the last line must
   say `SIGNED` (the script checks `codesign --verify` and the embedded profiles before saying so).
4. Copy `build/Debug/VibtraGuard.app` to `/Applications`, open it, **Install network extension**, approve in System
   Settings, then allow the content filter and the proxy configuration when macOS asks. **Before installing build 4
   or later** (address steering): if the org's catalogue still has `api.anthropic.com` inside the `anthropic-claude`
   row (catalogue `2026-10-16+org.1`), keep that row OFF, and narrow the enabled rows to the ones under test — see
   "Before any live check with address steering" above.
5. **Distribution to other Macs**: a *Developer ID Application* certificate (Account Holder only), Developer ID
   provisioning profiles for both ids (System Extension + Network Extensions with the `-systemextension` values),
   hardened runtime (already on), then `notarytool submit --wait` + `stapler staple` — the steps and credential
   lanes are in `apps/hello-dmg/NOTARIZE.md`.

**Why not `systemextensionsctl developer on`** on the founder's own Mac: it only works with System Integrity
Protection relaxed (`csrutil` from Recovery), which turns off protections for the whole machine — kernel extension
and system-file protections included — on the Mac that holds the company's signing identity and admin sessions. It
also tests a different path (unsigned, not from /Applications) than the one customers will run. A spare Mac or a VM
is the place for it, if anywhere; the signed development build in steps 1–4 is the right test.

## What the panel says about the extension

The **Network extension** line is what macOS reports, read at launch and on every change (`ExtensionController`:
`OSSystemExtensionRequest.propertiesRequest`, `NEFilterManager`, `NETransparentProxyManager`, and the
`NEFilterConfigurationDidChange` / `NEVPNConfigurationChange` / `NEVPNStatusDidChange` notifications; mapped by
`ExtensionStatus.from`, unit-tested): Not installed · Waiting for approval · Turned off in System Settings · Off ·
Starting… · On · Partly on (which half) · Problem (the system's words). Its one action follows: Install network
extension · Open Network Extensions settings · Turn on network protection (both configurations enabled, the proxy
started; also offered on "Partly on: content filter on, transparent proxy not running" — the tunnel the system
stopped after a provider crash or a reboot — where it restarts the tunnel in one press) · Turn off network protection (both disabled, the proxy stopped; the system extension stays installed).
Pushing documents to the extension and draining its events follow the REPORTED state, so they keep working after
the app restarts.

**Trust for command-line tools…** writes `guard-ca.pem` (the Guard CA, for `NODE_EXTRA_CA_CERTS`, which adds to
Node's roots) and `guard-ca-bundle.pem` (macOS's system roots + the admin-trusted CAs in `/Library/Keychains/System.keychain`, where
a managed Mac's corporate TLS-inspection CA lives + the Guard CA, for `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, which REPLACE the trust store) into the agent's data dir,
then shows the five `export` lines with a Copy button. It never edits a shell file.

## What went wrong on 17 Oct 2026 (the first live run), and the fix

Signed Debug build in /Applications, extension `[activated enabled]`, enrolled to the demo registry as Ada (enforce).
Read from the extension's unified log (37,154 lines, 07:18–07:26 AEDT):

1. **Steered TCP hung at connect** — the extension was sandboxed without `com.apple.security.network.client`, so
   every connect to 127.0.0.1:9472 failed with EPERM (`connectx failed … [1: Operation not permitted]`, 1,104 times,
   none ever `.ready`); `handleNewFlow` had already taken each flow, `.waiting` was ignored and nothing timed out.
   The suffix rules also took every `googleapis.com` / `amazonaws.com` flow. Fix: the entitlement; fail open as above;
   exact-host re-check per flow.
2. **Chrome bypassed Guard over QUIC** — TCP-only steering. Fix: the UDP 443 drop above (address-based; Chrome not
   yet verified — see the live check and the `QuicAllowed: false` policy).
3. **"Not installed" after an app restart** — the line was a string the app set itself. Fix: the reported state above.
4. **Claude Code would break under interception** (it does not read the keychain). Fix: `api.anthropic.com`,
   `console.anthropic.com` and `statsig.anthropic.com` are now the **Anthropic API** row (like OpenAI API), `claude.ai`
   stays Claude; and "Trust for command-line tools…".

## Not in v0

Sparkle updates (MIT; named in NOTICE, not wired), MDM configuration profiles (the content filter and the system
extension can be pre-approved by MDM), and the per-app pinning of desktop apps (Claude, ChatGPT, Codex) through the
transparent proxy — untested until signed. LuLu (GPL-3.0) and HTTP Toolkit (AGPL-3.0) were read for shape only; no
code from either is here.

## Company branding

Guard is a regular Dock application with a menu-bar companion. Clicking its Dock icon opens the main window.
`Brand.xcassets` contains the macOS `AppIcon` and a template `VibtraMark` used in the sidebar and menu bar. Both
come from the console’s canonical `VIBTRA_MARK_PATH`, preserving the company artwork and adapting the template
mark to light/dark appearances. Regenerate the committed assets after an artwork change with:

```sh
swift guard/mac/tools/generate-brand-assets.swift
```
