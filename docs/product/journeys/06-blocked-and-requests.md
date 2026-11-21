# Journey 6: Blocked, ask for access, admin decides

- **Personas:** [Employee](../personas.md#employee) (blocked, asks), [Security lead](../personas.md#security-lead) or
  [IT admin](../personas.md#it-admin) (decides).
- **Trigger:** a rule blocks or holds a request while the organisation is in **Enforce**.
- **How-to:** [guide/troubleshooting.md](../../guide/troubleshooting.md#what-a-block-looks-like) lists what each client
  shows. [guide/rules.md](../../guide/rules.md#requests) covers **Request access**.

## Happy path

### The employee is blocked

1. **The request is refused on the Mac** before it reaches the service. The agent records an event: the rule, the
   service, the app, a count, and at most a short redacted fragment if **Redacted examples** allows it. No body is
   stored or sent.
2. **What they see depends on the client.**
   - A page opened in the browser: Guard's block page in that tab.
   - A chat send on a website, or a Mac chat app: the vendor's own error, and one notification, "Request blocked"
     ("Vibtra Guard blocked a request to X by the rule "R". Click to see why and what to do next.") or "Approval
     needed" for an Ask IT rule. One notification per burst, with a 10 second quiet gap.
   - An API client or tool: HTTP 403 with a `vibtra.policy/v1` JSON body and a code such as `GUARD_CONTENT_BLOCKED`.
3. **The block page** (click the notification, or **Open block page** in the panel) shows "Request blocked" or "Ask
   IT for access", the organisation, the service, the rule ("Service policy" if none), the match count, the admin's
   **Why** text, and **What to do next**:
   - content rule: "Remove or replace the matched data, then send it again.";
   - service rule with requests on: "Request access below. Try again only after your administrator approves it.";
   - a switch, or a connection Guard could not inspect: ask your administrator. No form.
4. **Request access.** "Why do you need access?" (up to 280 characters, no secrets), then **Request access**. The
   agent sends it to the server for the person and Mac that are enrolled. The system records a `requested` event
   and a pending request that expires in 14 days.
5. **The page waits.** While the tab is open it checks every 3 seconds and shows "Request pending".

### The admin decides

6. **Admins are emailed** (mail on): "<person> asked IT for <words>", with a link to the request. Not sent again if
   the same ask was declined or expired in the last 24 hours. The **Requests** count in the sidebar and the top-bar
   inbox show it too.
7. **Requests**, **Needs review**. The request sheet shows the facts: the service, the rule, the Mac, other open
   requests for the same thing, and live grants.
8. **Approve.** **For** 1 hour, 8 hours, 7 days or 30 days. **Who**: "This person" or "Everyone". Optional note. The
   system records a grant with an end time and the audit event `policy.request.decided`. The grant is signed into
   the next policy, so it applies from the Mac's next check-in.
9. **Or decline.** A **Reason** is required (up to 280 characters).
10. **The employee finds out.** If the block page is still open, it changes to "Access approved. Retry your
    request." or "Request declined". They send again.

## Branches

- **Requests turned off.** **Settings**, **Block page**, **Request access** off: the block page says "Access requests
  are turned off on this device" and shows no form. A request sent anyway is refused (`GUARD_REQUESTS_OFF`).
- **Same request twice.** The server returns the existing pending request instead of a new one.
- **Nobody decides.** After 14 days the request becomes **Expired** when someone next reads it.
- **Monitor mode.** Nothing is blocked, so nothing is asked. Activity shows "would have blocked".
- **Revoke a grant early.** **Requests**, **Grants**, **Revoke…** ("Revoke exception"). Applies at the next
  check-in.
- **Grant lapses.** Shows as **Lapsed**. The person is blocked again and can ask again.
- **The agent restarted.** Block pages live in the agent's memory. After a restart the block page link returns
  `GUARD_EVENT_UNKNOWN`, and **Open block page** is greyed out.

## Gaps and open questions

- **The employee is not told the decision.** No email, no notification. They learn only if the block page tab is
  still open and polling (`guard/agent-go/local.go:273`). Decide how a decision reaches them: notification,
  email, or both.
- **The decline reason is never shown,** although the decline sheet says "They see your reason on the block page"
  (`apps/guard-console/src/requests/DecideSheet.tsx:131`). The page shows only "Request declined".
- **No reminder.** Each request stores `reminderAt` (7 days), but nothing reads it
  (`apps/registry/src/guard/requests/service.ts:143`). Requests can silently expire.
- **The form comes back after submit.** The page reloads and shows the same form again, which invites duplicate
  asks.
- **Content blocks offer a request** next to "Remove or replace the matched data". Should a person be able to ask to
  send data a content rule exists to stop? ([guide/rules.md](../../guide/rules.md#requests) says yes; decide
  deliberately.)
- **No request from the panel.** The Mac app's native request sheet is unreachable dead code
  (`guard/mac/VibtraGuard/BlockedView.swift`); the block page is the only way to ask.
- **Old product wording in mail.** The arrival mail for other kinds says "workspace policy", and approval refuses
  "requests from the retired workspace platform" (`apps/registry/src/mail/templates.ts`,
  `apps/registry/src/guard/requests/service.ts`).
- **No approval history per person.** **Reviewed** lists decisions, but there is no view of one person's grants
  across time.
