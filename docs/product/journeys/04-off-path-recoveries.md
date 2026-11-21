# Journey 4: Recover when off the email links

- **Persona:** [Employee](../personas.md#employee)
- **Trigger:** the person does not follow the email in order. They sign in from a bookmark, use the wrong account,
  lose the email, open it on a phone, or find Guard already installed by IT.
- **Ticket:** VIB-74 (done). The rule it set: each person always has a next step that works without IT.
- **Code:** `apps/registry/src/guard/entry-pages.ts` (the `/start` page) and
  `apps/registry/src/onboarding/entry-routes.ts` (`/guard/enrol`); the Mac side is
  `guard/mac/VibtraGuard/EnrolView.swift`.

## Recovery 1: signs in without the invitation link

1. The person opens `/login` directly and signs in with the invited address.
2. They have no organisation yet, so `/start` asks the server for live invitations to their verified address
   (`GET /api/onboarding/invitations`).
3. **One invitation:** the page says "Join <org>" and "<inviter> invited <email> to <org> on Guard. The invitation
   expires on <date>." with a **Join <org>** button.
4. **Several:** "Choose your organisation", one button per organisation with "Invited by … Expires …".
5. **Join** accepts the invitation and opens the dashboard. Funnel: **Signed in**.

Branches: an unverified address sees "Your address is not verified" and is told to open the email link or use another
account. An address with no live invitation sees "No organisation yet… Ask an admin of your organisation to invite
it". Expired and cancelled invitations are not offered.

## Recovery 2: signs in with the wrong account

1. The person opens the invitation link but signs in with another account.
2. `/start` shows "This invitation is for another address" and "You are signed in as <email>, and this invitation was
   sent to a different address."
3. **Sign in with another account** signs them out and returns to `/login` with the invitation kept. The provider is
   asked to show its account picker.

The invited address is not shown. An invitation link that no longer works shows "This invitation link no longer
works. It expired, was cancelled, or a newer email replaced it."

## Recovery 3: Guard is on the Mac, but there is no enrol link

1. The panel says "Not enrolled. Use Enrol… with the link IT sent you." The person chooses **Enrol…**.
2. The **Enrol this Mac** window has **No enrol link? Get one**. It opens `<server>/guard/enrol` in the browser. A
   signed copy of Guard always uses its built-in server.
3. **Not signed in:** "Sign in to enrol this Mac". After sign-in, Guard brings them back.
4. **Signed in but in no organisation:** "Join your organisation first" with **See your invitations**
   (recovery 1, then back here).
5. **Member with a verified address:** "Enrol this Mac in Guard", **Make my enrol link**, then "Your enrol link is
   ready" with **Open Guard and enrol** ([journey 3](03-employee-onboarding.md) from step 6).
6. The system records an enrol link minted by the person for themselves (`via: "enrol_page"`), with the same audit
   event as an admin's link.

## Recovery 4: opens the enrol link before Guard is installed

The "Your enrol link is ready" page says "Install Guard first, if it is not on this Mac yet." with **Download Guard**
(or "Your IT team sends it." when the server has no download address), then the enrol link.

## Recovery 5: opens the email on a phone

On a device whose browser says it is not a Mac, the enrol page makes no link. It says "Open this email on the Mac you
are enrolling", or, for `/guard/enrol`, "Open this page on the Mac you are enrolling" and shows the address to open.

## Gaps and open questions

- **Any member can enrol any Mac for themselves.** There is no per-organisation switch to turn self-serve off, and
  no limit on how many Macs a person enrols, beyond 30 page opens a minute. Each link is audited. Decide whether
  admins need a switch.
- **Self-serve on a self-hosted server with Vibtra's download** opens `https://vibtra.app/guard/enrol`, not the
  self-hosted server, because a signed copy uses its built-in server ([journey 10](10-self-host.md#gaps-and-open-questions)).
- **The panel still says "the link IT sent you"** (`guard/mac/VibtraGuard/StatusPanel.swift:109`). It does not
  mention **Get one**, which is only inside the Enrol window.
- **Phone detection is by User-Agent.** An iPad in desktop mode reports itself as a Mac and gets a link it cannot use.
- **Expired-link pages still say "Ask IT".** "This link has expired. Ask IT to send it again" is right for the email
  links, but the person could also make their own link at `/guard/enrol`. The page does not say so.
- **No sign-in inside the Mac app.** Out of scope in VIB-74. Every recovery goes through the browser.
