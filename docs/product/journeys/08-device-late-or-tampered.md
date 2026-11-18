# Journey 8: A Mac goes late or tampered

- **Persona:** [IT admin](../personas.md#it-admin)
- **Trigger:** a Mac stops checking in, stops checking traffic, or (by design) fails an integrity check.
- **How-to:** [guide/restart.md](../../guide/restart.md) and [guide/coverage.md](../../guide/coverage.md#availability-guard-fails-open).

## How a Mac reports

Each Mac checks in about once a minute. It sends its facts (host name, macOS and agent versions, model) and health:
whether the proxy is listening, whether Guard can inspect traffic and why not, the signing key state and whether the
certificate is trusted. It does not send the network extension state. After errors it backs off from 10 seconds up to
10 minutes.

## Device states on Devices

Checked in this order (`deviceState` in `apps/guard-console/src/people/fleet.tsx`):

| State | Means |
|---|---|
| Revoked | An admin revoked it. |
| Not protected | Guard is not inspecting: certificate not trusted, no Secure Enclave, key unavailable, unsigned build, unsupported platform, or the signer (the app) is not running. |
| Quiet | No check-in for **Quiet laptops** (1 hour to 3 days; default 24 hours). |
| Late | No check-in for **Late laptops** (3 or 15 minutes; default 3). |
| No policy yet | Enrolled, no rules applied yet. |
| Sync failing | It is seen, but its last complete sync is more than 5 minutes old. |
| Protected / Monitoring | Healthy, in Enforce or Monitor. |

**People** shows the funnel stage instead ([journey 2](02-invite-and-onboard.md)), with an attention bar: "N people's
Macs stopped syncing" (**Show Late**) and "… failed an integrity check" (**Show Tampered**).

## Happy path: a Mac goes late and comes back

1. The person restarts the Mac. Guard does not start at login, so nothing checks in.
2. After 3 minutes the device shows **Late**; the person's stage shows **Late**; the attention bar appears.
3. AI traffic on that Mac goes straight to the services, unchecked (Guard fails open).
4. The admin opens the device sheet: last seen, agent version, health. They ask the person to open Vibtra Guard.
5. The person opens the app. The agent starts, checks in, uploads queued events and gets current rules. The state
   returns to **Protected** or **Monitoring**.

## Branches

- **The person chose Stop Guard….** The alert warned "Your admin sees that this Mac stopped checking in." Same as
  above.
- **The person quit the app.** Quit only hides the icon. Guard keeps checking. Nothing changes on the dashboard.
- **The app crashed.** The agent keeps running but nothing restarts it. Then same as a restart.
- **Certificate key lost** (keychain reset, new Mac). Guard makes a new certificate and asks the person to trust it.
  Until then the device is **Not protected** and the funnel goes back to **Enrolled**.
- **Signing key or server problem.** The panel shows a **Signing key** or **Server** problem. The device keeps its
  last verified rules. The device sheet's **Policy signing key** row says, for example, "Pinned for another device or
  organisation: enrol again". Fix: enrol again.
- **A patched, re-signed agent.** It runs as an unsigned copy. **Policy signing key** says "in a file the person can
  change" ([mac.md](../../guide/mac.md#which-server-guard-talks-to)). This is today's only tamper sign.
- **Revoke.** **Devices**, row menu, **Revoke…**, "Revoke laptop". Records `guard.device.revoked`. The Mac's next
  check-in is refused; it drops its rules, stops checking traffic and shows "This device's access was revoked…
  Ask your admin for a new enrolment link." Its queued events are lost.
- **The Mac goes quiet for good.** After **Quiet laptops** it shows **Quiet**. It never leaves the list on its own.

## Gaps and open questions

- **Tampered cannot happen.** The stage exists, the database has `integrity_failed_at`, the attention bar has copy for
  it, but no agent or route reports an integrity result (`apps/registry/src/guard/store.ts:237`). Decide what an
  integrity check is (code signature, extension present, certificate untouched, proxy steering) and build it, or
  hide the stage.
- **Removed, stopped, offline and tampered all look the same.** A removed Mac tells the server nothing
  ([journey 9](09-offboarding-and-removal.md)). It goes Late, then Quiet, like a Mac that is switched off.
- **Late after every restart.** No login item (`guard/mac`, no `SMAppService` or LaunchAgent). A 3-minute default
  makes every reboot a Late flag and trains admins to ignore it.
- **No alert.** Late, Quiet and Not protected are only visible on the dashboard. No email or digest to the admin.
- **Extension state is not reported.** A Mac with the network extension turned off can show **Protected** on
  **Devices**, because the device state ignores the extension. Traffic goes nowhere near Guard.
- **Two Lates.** **People** measures from the last sync, **Devices** from last seen (`apps/registry/src/onboarding/funnel.ts:47`,
  `apps/registry/src/guard/service.ts:927`). The same Mac can be Late on one page and not the other.
- **Revocation fails open and silently.** The person gets no notification, only a panel card, and the Mac stops
  checking traffic. Decide whether a revoked Mac should block AI services instead.
- **Units differ.** "3 missed check-ins (3 minutes)" sits next to "15 minutes"
  (`apps/guard-console/src/pages/Settings.tsx:56`), and the words laptop, device and Mac are mixed across pages.
