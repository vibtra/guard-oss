# Journey 7: Read activity

- **Persona:** [Security lead](../personas.md#security-lead)
- **Trigger:** a weekly review, a rule tried in Monitor, a question from management ("who uses which AI?"), or a
  block someone complains about.
- **How-to:** [guide/coverage.md](../../guide/coverage.md#what-guard-reports) says what an event carries.

## Happy path

1. **Overview.** "7 days" or "30 days". Cards: AI services seen, People using AI, Blocked (or "Would have blocked" in
   Monitor), Devices. Tabs: **Services** (people, devices, blocked, sent, last used per service; click a row for
   "People using X"), **Apps**, **Blocks** (by rule, as content rule, service rule or default), **Latest** (links to
   **All activity**).
2. **Activity.** Tabs **All**, **Blocked**, **Asked**, **Allowed**. Search "host, app, service, rule or person".
   Filters: Service, Decision, Person, Device. The filters stay in the address, so a view can be shared with another
   admin.
3. **Read one event.** The sheet shows the decision, the rule, what kind of data matched and how many times, a
   "Redacted example" if allowed, the app, the service, the host with a hint of the path, the Mac, the request size,
   the reason, the rules version, and when it happened and was received. The page says: "Guard keeps the rule, the
   kind of match and a count, and at most a redacted fragment. Never what was sent."
4. **Follow up.** From an event, open the person or the device. Change a rule ([journey 5](05-rules.md)) or answer a
   request ([journey 6](06-blocked-and-requests.md)).

What the system records: each Mac queues its events and uploads them at check-in, in batches of up to 500. The
server stores metadata only. Request bodies never leave the Mac.

## Branches

- **Monitor.** Events say **Observed** where Enforce would block. Overview counts "Would have blocked".
- **Counts only.** With **Settings**, **Redacted examples** set to "Counts only", no fragment is kept.
- **A Mac is offline.** Its events arrive when it next checks in. "When" and "received" differ.
- **A Mac is revoked.** Its queued events are never uploaded ([journey 8](08-device-late-or-tampered.md)).
- **A person is removed.** "What they did stays in the activity history."
- **No events yet.** **Overview** shows "No laptop has checked in yet" with **Enrol the first laptop**.

## Gaps and open questions

- **No export.** No CSV, no API for a SIEM, no report. Audit export and SIEM export are listed as paid and coming.
- **No retention rule.** No Guard event retention code was found under `apps/registry/src/guard`, so events are kept
  for ever and the database grows. Decide the default and whether it is configurable.
- **Tabs cover four of six decisions.** **Redirected** and **Requested** are only in the Decision filter
  (`apps/guard-console/src/pages/Activity.tsx`).
- **Quiet Macs are not on the Overview.** Settings says quiet laptops are "counted on the Overview"
  (`apps/guard-console/src/pages/Settings.tsx:224`); the server computes them, but the page does not show them.
- **Coverage is invisible here.** Activity shows what Guard saw. It cannot show AI use Guard does not cover (other
  browsers, uploads, uncovered clients), and nothing on the page says so.
- **No scheduled summary.** The security lead has to open the dashboard; nothing is emailed.
