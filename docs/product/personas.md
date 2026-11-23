# Personas

Five people use Guard. Each one is defined by what the product lets them do today, not by a market segment. In a
small company one person can be several of them: the owner who signs up is often also the IT admin and the security
lead.

| Persona | Role in Guard | Where they work |
|---|---|---|
| [Org owner](#org-owner) | Owner | Sign-in page, dashboard **Settings** |
| [IT admin](#it-admin) | Admin (or owner) | Dashboard **People** and **Devices**, their MDM tool |
| [Security lead](#security-lead) | Admin (or owner) | Dashboard **Rules**, **Activity**, **Requests**, **Settings** |
| [Employee](#employee) | Member | Email, the Mac panel, the block page |
| [Self-hoster](#self-hoster) | Server operator, often also the owner | Docker host, env file, identity provider |

## Org owner

The first person from the company to sign in. Guard creates the organisation and makes them its owner.

- **Goal:** get the company onto Guard and hand the day-to-day work to the right people.
- **Context:** they decided to try Guard, often after a scare about staff pasting data into ChatGPT or Claude. On
  Vibtra Cloud they were added by hand first. On a self-hosted server they are the first verified address on the
  operator domain, or the address in `REGISTRY_OWNER_EMAIL`.
- **Touches:** `/login`, the dashboard, **People** (to invite admins and change roles), **Settings** (mode, staff
  notice). Only an owner can make or unmake an owner. Sign-in settings and the join policy have no page in the
  dashboard today ([journey 1](journeys/01-org-setup.md#gaps-and-open-questions)).
- **Worries:** staff seeing Guard as spying. Breaking people's work on day one. Anyone on the company domain joining
  without being asked. Being the last owner and locking the company out.
- **Done looks like:** the organisation exists, at least one other admin is in, the staff notice is written, and the
  organisation is in Monitor while people enrol.
- **Journeys:** [1 Set up the organisation](journeys/01-org-setup.md).

## IT admin

Rolls Guard out to every Mac and keeps it running.

- **Goal:** every person in scope has a Protected Mac, and stays that way.
- **Context:** manages tens to a few hundred Macs, often with an MDM tool. Cannot sit with each person. Measured on
  coverage: how many Macs are protected.
- **Touches:** **People** (invite, resend, remind, the funnel and the chase list), **Devices** (enrol links,
  **Distribute Guard**, device status, **Revoke…**), `sign-guard.py` and `mdm-profile.py` if they sign Guard
  themselves.
- **Worries:** people who never finish setup. Macs that stop checking in, are not protected, or were tampered with.
  Support tickets from people who are stuck. Leavers whose Mac keeps a working Guard enrolment.
- **Done looks like:** the funnel shows everyone at **Protected**, the chase list is empty, and nobody is **Late**.
- **Journeys:** [2 Invite and onboard](journeys/02-invite-and-onboard.md),
  [8 Late or tampered](journeys/08-device-late-or-tampered.md),
  [9 Offboard](journeys/09-offboarding-and-removal.md),
  [11 Track B MDM](journeys/11-track-b-mdm.md) (planned).

## Security lead

Decides what may be sent to AI services, and checks that the rules work.

- **Goal:** stop sensitive data (customer numbers, keys, health and tax identifiers) reaching AI services, and
  control which services people use, without blocking useful work.
- **Context:** owns the AI usage policy, answers to compliance or a client audit. Often the same person as the IT
  admin in a small company. Has to justify each block.
- **Touches:** **Rules** (services, content, apps and websites, starters, the "would this be blocked?" box),
  **Settings** (the default mode: Off, Monitor or Enforce; request access, uninspectable TLS, staff notice, what a
  fragment may show), **People, Protection** (each person's mode),
  **Activity**, **Requests**.
- **Worries:** false positives that make people work around Guard. Gaps in coverage they cannot see. Guard storing
  the very data it is meant to protect: it must not. Being asked to prove a rule was in force at a given time.
- **Done looks like:** rules tried in Monitor, then Enforce. Activity shows blocks with the rule, the service and the
  app, and no content. Requests are answered within days, not left to expire.
- **Journeys:** [5 Rules](journeys/05-rules.md), [6 Requests](journeys/06-blocked-and-requests.md),
  [7 Activity](journeys/07-activity.md).

## Employee

Works on a Mac that Guard protects. Has the member role, or no account yet.

- **Goal:** get set up quickly, then keep working with AI tools without surprises.
- **Context:** received an email from IT, or found Guard already installed. Not technical. Sees Guard only during
  setup, when something is blocked, and in the menu bar.
- **Touches:** the invitation email, `/login` and `/start`, `/guard/enrol`, the Mac panel (**Enrol…**, **Trust the
  Guard certificate**, the network extension action), macOS prompts, the block page and its **Request access** form,
  desktop notifications.
- **Worries:** what Guard can see (the staff notice answers this). A chat app failing with a vague error. Being
  stuck in setup with nobody to ask. A Mac password prompt they do not understand.
- **Done looks like:** the panel shows the Mac is protected and the email steps are finished. When blocked, they know
  why and what to do next.
- **Journeys:** [3 Get my Mac protected](journeys/03-employee-onboarding.md),
  [4 Recover off the email links](journeys/04-off-path-recoveries.md),
  [6 Blocked and asking](journeys/06-blocked-and-requests.md),
  [9 Remove Guard](journeys/09-offboarding-and-removal.md).

## Self-hoster

Runs the Guard server for their organisation instead of using Vibtra Cloud.

- **Goal:** a working, backed-up Guard server on their own infrastructure, signed in through their own identity
  provider, with no data leaving it.
- **Context:** an operator or platform engineer. Comfortable with Docker, TLS and OIDC. Uses the Community Edition,
  or a licensed self-host.
- **Touches:** the env file, `docker compose`, the server logs, their identity provider, a TLS proxy, backups.
  Usually also an Apple Developer account, to sign Guard for their server.
- **Worries:** losing `secrets.env` and having to re-enrol every Mac. Upgrades that break enrolment. Settings that
  look live but do nothing. Anything that calls home to Vibtra.
- **Done looks like:** `dc up -d --wait` is healthy, the first owner signed in, one Mac enrolled against the server,
  and a restore has been tested.
- **Journeys:** [10 Run your own server](journeys/10-self-host.md), then [1 Set up the organisation](journeys/01-org-setup.md).

## Who is not a persona yet

- **A Windows or Linux user.** Guard runs on Apple silicon Macs with macOS 14 or later only.
- **An auditor reading exports.** Long audit retention, export and SIEM export are listed as coming in the paid
  edition. Nothing ships for them today.
- **A group manager.** Rules can name groups and people, but there is no role between admin and member.
