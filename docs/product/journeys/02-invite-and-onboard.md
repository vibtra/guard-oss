# Journey 2: Invite and onboard people (Track A)

- **Persona:** [IT admin](../personas.md#it-admin)
- **Trigger:** the organisation is set up ([journey 1](01-org-setup.md)) and people's Macs need protecting.
- **The other side:** [journey 3](03-employee-onboarding.md) is what the employee does with the email.
- **Tickets:** VIB-68 (Track A), VIB-69 to VIB-71 (layers), VIB-74 (recoveries). Track B is
  [journey 11](11-track-b-mdm.md), planned.

## Happy path

1. **Open People.** **People** has four tabs: **People**, **Protection** ([journey 12](12-protection-modes.md)),
   **Chase** (with a count) and **Groups**. The **People** table shows Name, Stage, Role, Groups, Devices, Last
   signed in and Added. Filters: Stage, Role, Group.
2. **Invite.** **Invite people**. One email address at a time. Role **Member** or **Admin**. The button reads
   **Send invitation** when mail is on, **Create invitation** when it is off.
3. **The system records** a Better Auth invitation (pending, with an expiry) and the send time. The person shows as a
   row with stage **Invited** and "Invitation pending".
4. **The email goes out** (mail on). Subject "<admin> invited you to <org> on Vibtra". Three numbered steps: accept
   the invitation, download Guard, enrol your Mac. Then the staff notice. The download and enrol links are signed
   onboarding links, valid until the invitation expires or 14 days, whichever is sooner
   (`apps/registry/src/onboarding/links.ts`). The dashboard says "Invitation sent".
5. **Watch the funnel.** The Stage column moves as the person acts. Code: `funnelPosition` in
   `apps/registry/src/onboarding/funnel.ts`. A person's stage is the furthest stage of any of their Macs.

| Stage | Reached when |
|---|---|
| Invited | The invitation is pending. |
| Signed in | The person has signed in at least once. |
| Enrolled | A Mac is enrolled and its Guard certificate is not trusted yet. |
| Certificate trusted | The certificate is trusted and the network extension is not reported active. |
| Protected | The certificate is trusted and the network extension is reported active. |
| Late | A Mac has not checked in for longer than **Late laptops** (3 or 15 minutes). |
| Tampered | A Mac failed an integrity check. |
| Not in scope | The person's mode is Off ([journey 12](12-protection-modes.md)). Never chased. |

6. **Done.** The person reaches **Protected**. An attention bar flags people at **Late** or **Tampered**
   ([journey 8](08-device-late-or-tampered.md)).

## Chase list

- **Who is on it.** People at **Invited** or **Signed in** whose invitation or last reminder is older than
  **Settings**, **Onboarding**, **Chase after** (3, 7, 14 or 30 days; default 7). Code: `chaseDue` in
  `funnel.ts`.
- **Columns.** Name, Stage, "Waiting since". Empty state: "Nobody is stuck".
- **Invited row: Re-send invitation.** Makes a new invitation with a new expiry, cancels the old one if its id
  changed, and sends a new email. Old onboarding links stop working.
- **Signed in row: Send reminder.** Sends "Reminder: set up Guard on your Mac for <org>" with fresh download and
  enrol links. "These links replace the ones in any earlier email."
- **Limits.** Five sends per person per hour. An owner invitation cannot be re-sent from the dashboard.
- Email cannot make anyone install Guard. A person who ignores every email stays on the list.

## Branches

### Mail off

The server has no mail adapter ([journey 10](10-self-host.md#optional-turn-on-mail)). The dashboard shows "Send this
link yourself" with **Copy link**: "Email is not set up on this server, so nothing was sent." The link is the
sign-in link `/login?invitation=<id>` only. It carries no download or enrol link. For a reminder, the copied link is
the signed enrol link.

### Email send failed

"The email was not sent" with the same copyable link. The send is not recorded, so the chase clock does not reset.

### Admin enrols the Mac directly

**Devices**, **Enrol laptop**, pick the person (must already be a member), "Open a link" or "Run a command", how long
the link works (1 hour to 7 days, default 24 hours). The result shows both the enrol link and the command once:
"This will not be shown again". The admin sends it by any channel. This skips the email path and is the fallback
for any stuck person.

### Person joins without an invitation

Someone on the claimed domain signs in and joins as a member (join policy `domain`). They enter the funnel at
**Signed in** with no invitation email. They need a reminder, a direct enrol link, or `/guard/enrol`
([journey 4](04-off-path-recoveries.md)).

### Invitation expires

The row stays at **Invited**. The person's links show "This link has expired. Ask IT to send it again".
The admin uses **Re-send invitation**.

## Gaps and open questions

- **Protected is never reached by a real Mac.** The funnel needs `health.extensionActive`
  (`apps/registry/src/onboarding/funnel.ts:52`), but the agent never sends it (`guard/agent-go/sync.go:458`). Every
  enrolled Mac with a trusted certificate stops at **Certificate trusted**. The device sheet's extension row always
  says "Not reported".
- **Tampered is never reached.** Nothing writes an integrity result (`apps/registry/src/guard/store.ts:237` has no
  caller that passes one). The attention bar's "failed an integrity check" can never show.
- **Two meanings of Late.** The funnel measures from the last sync (`apps/registry/src/onboarding/funnel.ts:47`); the Devices page measures from
  last seen (`apps/registry/src/guard/service.ts:927`). Devices also has states the funnel lacks: Not protected,
  Quiet, No policy yet, Sync failing, Monitoring.
- **Stage help text disagrees with the code.** "Certificate trusted" says the Mac "has not applied a policy yet", and
  "Protected" says it "passes its integrity checks" (`apps/guard-console/src/people/onboarding.tsx:19-20`).
- **The mail-off link is only the sign-in link.** A person who gets it has no download or enrol step. After sign-in
  they land on a dashboard page that says "That page is for organisation admins".
- **Invitation lifetime is Better Auth's default.** The registry sets no `invitationExpiresIn`
  (`apps/registry/src/auth/better-auth.ts`), so invitations expire quickly and the email's onboarding links expire
  with them. The email prints the raw expiry timestamp ("The link stops working on <ISO time>",
  `apps/registry/src/mail/templates.ts:30`).
- **Re-send may keep the old sign-in link.** When Better Auth renews the same invitation id, the old
  `/login?invitation=` link keeps working (VIB-73, backlog).
- **No bulk invite, no cancel.** One address at a time. The API can cancel an invitation
  (`DELETE /people/invitations/:id`), but the dashboard has no button.
- **Everyone is chased.** Owners and admins who have no Mac to protect sit at **Signed in** and join the chase list.
  There is no "no Mac" or "not in scope" state.
- **"Anyone with this link can use it"** under the copied invitation link is not true: it works only for the invited
  address (`apps/guard-console/src/people/delivery.tsx`).
