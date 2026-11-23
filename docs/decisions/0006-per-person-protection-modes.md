# 0006 — Per-person protection modes: Off, Monitor, Enforce

- **Status:** Accepted, 23 November 2026. Not built yet.
- **Decided by:** Tyler Stewart (delivery, expiry fallback, health reporting, free edition, no group-level modes).
- **Depends on:** ADR 0005 (the network extension is the only way into Guard). "Off" is only safe once no process is hard-wired to Guard's proxy through `HTTPS_PROXY`.
- **Design input:** four independent model opinions on delivery (GPT-6.2 Sol, GPT-6.2 Astra, Claude Opus 5.5, Claude Fable 5.2), drawn in the Eraser file *Cloud-Assisted Web Request Filtering Architecture*.

## The requirement

IT decides, per person, whether Guard is **Off**, **Monitor** (record, never block) or **Enforce** (block), and can change many people at once with a confirmation that says what will happen. Example: Adam selects the 14 people in Finance and moves them from Monitor to Enforce.

Today the mode is one organisation-wide setting (`GuardSettings.clientMode`, `packages/guard-contract/src/bundle.ts:9`) with only `monitor` and `enforce`. Rules are already compiled per person (`audienceAdmits` in `packages/guard-contract/src/compile.ts:27`), so per-person mode fits the existing shape.

## Decision

1. **Each person has an effective mode: their own setting, or the organisation default.** One function, `effectiveMode(person)`, is the only place this is resolved. The API, the policy compiler, the funnel and the dashboard all call it.
2. **The mode travels in each person's signed policy.** The Mac resolves it at runtime, per request, from the verified policy it holds in memory. It never asks the server per request.
3. **Delivery: pull, plus a long-poll hint.** The 60-second check-in stays as the guaranteed path. A content-free long-poll wait tells awake Macs to sync now, so a change applies in about a second. Long polling is only ever an accelerator: if any part of it fails, delivery falls back to the check-in.
4. **Off means no inspection.** The extension steers nothing and the agent decrypts and records nothing. The agent keeps checking in, so IT still sees the Mac.
5. **A signed policy expires after 72 hours.** A Mac that cannot refresh before expiry falls back to **the stricter of its last mode and the organisation default**.
6. **Health is a heartbeat plus changes.** Every check-in carries liveness and the applied version and mode. Full health goes only when it changes, on reconnect and every 15 minutes. Protection breaking or recovering triggers an immediate check-in.
7. **Free in every edition.** No entitlement check. Per-person modes are rollout control, not the paid "group policies" feature.
8. **No group-level modes.** Groups are a selection shortcut in the dashboard only. A group rule that new joiners inherit is the paid group-policies feature, out of scope.
9. **Automatic changes only raise protection.** Modes are ranked `off < monitor < enforce` (`GUARD_MODE_RANK` in the contract). Anything Guard does without an admin choosing it (expiry, an unrecognised mode value) can only move a person up: `raise(a, b)` returns the stricter mode, and an unrecognised value is `enforce`. Only an admin's explicit, audited change can lower a person.

## Design

### Data

```
org settings.clientMode          default for the org: off | monitor | enforce
guard_person_protection (new)    org_id, user_id, mode, revision, set_by, set_at
effectiveMode(person)            = person's row ?? org default
```

`revision` increases by one on every change to that person. Clearing a person back to the default deletes their row and still bumps a per-org revision so their policy changes.

### API (console)

```
GET  /api/console/people/protection            default, each person's effective mode and its source (default or set)
POST /api/console/people/protection/preview    { changes: [{ userIds: [...], mode }] | [{ userIds, clear: true }] | [{ default: mode }] }
                                               -> { revision, summary, people: [{ userId, email, from, to, effect }] }
POST /api/console/people/protection/apply      { changes, revision }
                                               -> 200 { revision, applied, unchanged }
                                               -> 409 the revision is stale; nothing changed
                                               -> 422 an id is not a member; nothing changed
GET  /api/console/people/protection/rollout?revision=  each person's Macs: applied or pending, last seen
```

- The console expands a group into explicit ids before preview, so preview and apply cover exactly the same people.
- Apply is one transaction, idempotent, capped (1,000 ids), and writes one `guard.protection.changed` audit line per person (actor, from, to).
- The `effect` text describes the consequence, not the setting: "matches will now be blocked", "Guard starts inspecting their AI traffic", "Guard stops checking their AI traffic; nothing is recorded".

### Compile

Every read of `settings.clientMode` in `apps/registry/src/guard/service.ts` (`:328`, `:343`, `:367`, `:592`, `:625`) becomes `effectiveMode(person)`. A person's policy fingerprint changes when their mode changes, so the existing preflight comparison (`rulesChanged`, `service.ts:373`) already tells their Mac to download.

Each policy carries a **stamp** `(orgRulesVersion, personRevision)` and an **expiry** (`validUntil`).

### Delivery: pull plus long-poll hint

```
Mac:    GET /sync/wait?stamp=(44,6)      held up to 25-55 s, below the load balancer's idle timeout
Server: stamp stale?  -> answer "changed" now
        otherwise     -> park the request in memory (map: device -> waiting response)
Save:   apply endpoint, in its transaction: write rows, audit, pg_notify('guard_policy', {org, people: {ana: 8}})
        on COMMIT Postgres delivers the notice to every server's single LISTEN connection
Each server: update its in-memory stamp cache, answer the parked waits it holds for those people
Mac:    on "changed", run a normal check-in: preflight, download the signed policy, verify, apply, postflight
```

- The wait carries no policy data and writes nothing to Postgres. Health and events stay on the check-in.
- Each server's stamp cache is written only by its own lazy loader (one indexed read on a miss) and its `LISTEN` handler. Entries are dropped when no wait for that person is parked.
- A batch too big for one notice (about 8 KB) sends `{org, peopleChanged: true}`; each server reloads the revisions for the people it holds.
- No sticky sessions: any server can take any wait, and the broadcast finds the one that holds it.
- Pub/sub through Postgres, not a transactional outbox: the notice is a hint, `pg_notify` is already delivered only on commit, and a missed notice costs only delay because the next wait or check-in compares stamps. An outbox is right for messages that are the data (an email to the employee, webhooks), not here.
- No Redis: self-hosters already run Postgres, and a socket can only be answered by the server that holds it, so a central cache would not remove the fan-out.

**Requirements, each with a test:**

| Risk | Requirement | Test |
|---|---|---|
| A pooler (PgBouncer in transaction mode) drops `LISTEN` | The listener connects directly (`GUARD_LISTEN_DATABASE_URL`, default the main URL). At startup the server sends itself a test `NOTIFY`; if it does not arrive within a few seconds, long polling is off, pull continues, and one clear warning is logged | Listener behind a dropping pooler: the server reports long polling off, and Macs still get changes within 60 s |
| Notices lost while the listener reconnects | On reconnect, clear the stamp cache and answer every parked wait with "recheck" | Kill the listener, change a mode during the gap, reconnect: the Mac gets the change without a full interval |
| A silently dead idle listener | TCP keep-alive and a self-addressed heartbeat `NOTIFY` every 30 s; a missed heartbeat runs the reconnect path | Black-hole the listener's traffic: detected within about a minute, then reconnect and recheck |
| A herd of reconnects after a restart | Random 0-30 s delay before a Mac reconnects; random spread on the 60 s timer (today `syncLoop` has none) | Restart the server with many agents: arrivals spread, no error spike |
| The Mac's client cancels its own wait | The wait's client timeout exceeds the hold (for example 65 s for a 55 s hold) | Hold at the maximum: the wait completes, not cancelled |
| A proxy cuts holds earlier than expected | The Mac notices early cuts and shortens its hold | A proxy with a 20 s idle cut: waits shrink, delivery still works |

The Mac also syncs immediately on wake and on a network change (today only the local "sync now" fires `a.wake`).

### On the Mac

- **Agent** (`guard/agent-go`): accept `off` (`agent.go:271` refuses it today). In Off, no TLS interception and no events; keep checking in. The mode is already read per request from an immutable snapshot (`agent.snapshot()`, `proxy.go:502`, `websocket_proxy.go:268`), so a new policy applies on the next request after the swap.
- **Extension** (`guard/mac/VibtraGuardExtension`): read the mode from the policy; in Off, an empty steering list and `handleNewFlow` returns false. **Verify the policy signature with the pinned org key and reject older stamps before using it** (today `Shared/GuardModel.swift:150` decodes `SignedBundle` without verifying).
- **Switching order:** to Off, the extension stops steering before the agent stops inspecting; from Off, the agent is ready to inspect before the extension steers.
- **Expiry:** past `validUntil` (72 hours after signing) with no refresh, the Mac applies `raise(lastMode, orgDefault)` from the same signed policy, never a lower mode, and the panel says so. A Mac seeing a mode value it does not recognise applies `enforce`. On wake or a network change the Mac syncs first and applies the fallback only if that refresh fails, so a laptop back from days offline goes straight to its newest policy. The fallback only matters when the Mac has internet but cannot reach the server (the server is blocked or down); with no internet there is no AI traffic to check.
- **Panel:** "Guard is checking and blocking", "Guard is watching, not blocking", "Guard is off for you".

### Health reporting

| What | When |
|---|---|
| Heartbeat: last seen (server time), applied stamp and mode | Every check-in |
| Full health snapshot | On change, on reconnect, every 15 minutes |
| Protection breaks or recovers | Immediate check-in, rate-limited |
| Decision events | Batched, acknowledged, as today |

The heartbeat also confirms a rollout if a postflight was lost.

### Funnel and dashboard

- A person in Off is **Not in scope** and never chased.
- **Protected** needs mode not Off and the network extension active (the agent must start reporting `extensionActive`).
- A Protection page (or People tab): the default, everyone's effective mode with filters, multi-select "Set to…", the preview dialog, and the rollout view ("9 of 14 Macs now blocking, 5 pending, last seen 2-40 min ago").
- Overview counts by mode.

## What changes

| Service | Change |
|---|---|
| `packages/guard-contract` | `off` in `GUARD_CLIENT_MODES`; stamp and `validUntil` in the bundle; protection API types |
| `apps/registry` migrations | `guard_person_protection` |
| `apps/registry/src/guard` | `effectiveMode`, per-person compile, stamp, expiry, `/sync/wait`, listener, stamp cache |
| `apps/registry/src/console-api` | protection read, preview, apply, rollout |
| `apps/registry/src/onboarding` | Not in scope; Protected needs extension active and mode not Off |
| `apps/guard-console` | Protection page, preview dialog, rollout view, overview counts |
| `guard/agent-go` | `off`, wait loop, jitter, sync on wake and network change, heartbeat and health-on-change, `extensionActive` |
| `guard/mac` | extension Off behaviour, signature and stamp check, expiry fallback, panel text |
| `docs` | `docs/product/journeys`, `docs/guide`, `docs/self-host.md` (direct Postgres connection for the listener) |

Not changed: licences and plans (`guard/ee`), the rules engine, the catalogue.

## Delivery, in order

Each step ships with its tests.

1. Contract, migration, `effectiveMode`, per-person compile, stamp and expiry.
2. Console API (read, preview, apply, rollout) and the funnel changes.
3. Mac: extension signature and stamp check, Off in agent and extension, expiry fallback, panel text, `extensionActive`.
4. Agent sync: jitter, sync on wake and network change, heartbeat plus health on change.
5. Long polling: `/sync/wait`, listener, stamp cache, and every requirement in the table above.
6. Dashboard: Protection page, preview, rollout view.

Steps 1-4 already give per-person modes with delivery within 60 s; step 5 brings it to about a second.

## Settled questions

1. **Telling the employee.** No notification or email when a person's mode changes. The panel shows their current mode.
2. **Load test.** Not before design partners. The design will change before then; measure parked waits and memory when it is close to launch.
