# Journey 5: Write and change rules

- **Persona:** [Security lead](../personas.md#security-lead)
- **Trigger:** a new organisation needs its first rules, a new AI service appears in **Activity**, or a block turns
  out to be wrong.
- **How-to:** [guide/rules.md](../../guide/rules.md) explains each field. [guide/coverage.md](../../guide/coverage.md)
  says what each switch really blocks.

## Happy path

1. **Start in Monitor.** **Settings**, **Protection**, **Mode** is **Monitor** for a new organisation. Guard records
   what the rules would block and lets requests through. **Overview** shows "Would have blocked" instead of
   "Blocked". Connections Guard cannot inspect are still blocked unless **Uninspectable TLS** is "Allow without
   inspection".
2. **Set the default.** **Rules**, **Services** tab, the row **Any other AI service**: Allow (the default), Ask IT
   or Block.
3. **Add service rules.** **Add rule** for one service: Block, Ask IT, Allow, or "Off (kept, not applied)". Add
   **Exceptions** for groups or named people ("A person named directly beats their groups."). Fill in **Why (shown
   on the block page)**.
4. **Switch off chat clients if needed.** Under the Services tab, **Apps and websites** has four switches: the Claude
   website, the Claude macOS app, the ChatGPT website, and the ChatGPT macOS app (ChatGPT and Codex). Each blocks only
   the tested send action ([coverage.md](../../guide/coverage.md)). No one can request an exception to a switch.
5. **Add content rules.** **Content** tab, **Add rule** or **Add starters** (nine starter rules). Choose what it
   detects (keywords, file types, or a built-in detector), which services, who it applies to, and **When it
   matches**: Block, Ask IT or Record only.
6. **Try it.** Each rule sheet ends with **Would this be blocked?**: pick a service or another host, optionally a
   person, type what they would send or the files they would attach. The answer is Allowed, Blocked, Asked or Not
   an AI service. It runs the saved rules on the server, not on a Mac.
7. **Save.** The toast says "Saved. Laptops pick the rules up at their next check-in (about a minute)." The system
   records a new rules revision and the audit event `guard.rules.changed`, and signs the policy for each Mac.
8. **Watch Activity in Monitor** for a while ([journey 7](07-activity.md)). Look for false positives, especially
   from **Personal identifiers** ([decision 0003](../../decisions/0003-identifiers-rules-only.md)).
9. **Enforce.** **Settings**, **Mode**, **Enforce**. The dashboard asks for confirmation and reminds the lead to give
   staff the notice first. Records `guard.settings.changed`. Macs enforce from their next check-in.

## Changing a rule later

- **Turn off / Turn on** in the row menu keeps the rule but stops applying it. **Delete…** removes it after a
  confirmation.
- **Remove every rule for this service…** clears a service.
- A grant from an approved request is separate from the rules. It expires on its own
  ([journey 6](06-blocked-and-requests.md)). To allow something for good, change the rule.
- **Emergency.** In Enforce, **Settings** shows **Pause enforcement on all laptops**: "Every laptop goes back to
  monitor at its next check-in."

## Branches

- **Two admins edit at once.** Saving replaces the whole rules document and checks the revision it started from. The
  second save is refused with a conflict and must be redone on the new rules.
- **A switch for a disabled service.** Refused: "Surface blocks require their AI catalogue service to remain enabled".
  Clear the switch first, or re-enable the service in **AI services**.
- **A switch not yet available** on this server shows "Not available yet."
- **A Mac misses the change.** It keeps its last verified rules until it checks in. A Mac that is **Late** or
  **Quiet** runs old rules ([journey 8](08-device-late-or-tampered.md)).
- **Monitor and uninspectable connections.** In Enforce, **Uninspectable TLS** is locked to Block.

## Gaps and open questions

- **No rule history or audit view.** Every save writes `guard.rules.changed` and `guard.settings.changed`, but no
  dashboard page shows the audit log or past revisions. The security lead cannot prove which rules were in force on a
  given day, or see who changed what.
- **No per-Mac "rules version in force" view.** The device sheet shows the bundle version; there is no fleet-wide
  "N Macs still on the old rules" signal after a save.
- **The tester is hidden in rule sheets.** There is no page-level "would this be blocked?" for a question that is not
  about one rule (`apps/guard-console/src/rules/TestBox.tsx`).
- **Switches live in two places** with different labels: **Rules**, **Apps and websites**, and the "Surfaces" column
  on **AI services** (`apps/guard-console/src/pages/Services.tsx:59`).
- **"Requests, 7 days" on the Services tab counts events, not requests** (`apps/guard-console/src/pages/Rules.tsx:229`).
  It does not match the **Requests** page.
- **"Exception" means two things**: a service rule's exceptions for groups and people, and a grant from an approved
  request ("Revoke exception" on **Requests**).
- **The content empty state lists only some starters.** It leaves out Personal identifiers and Bulk phone numbers
  (`apps/guard-console/src/pages/Rules.tsx:435`).
- **Group policies** (different rules per group beyond exceptions) are listed as coming in the paid edition. Today
  every rule is organisation-wide with exceptions.
