# Guard product docs: personas and journeys

Internal reference for the people and coding agents who design and build Guard. It says who uses Guard, what they
are trying to do, and what Guard does for them today, step by step.

These pages describe **shipped behaviour**, read from the code. Where the code and an intention differ, the page
follows the code and lists the difference under "Gaps and open questions". A journey that is not built is marked
**Planned** at the top.

The install guide in [docs/guide/](../guide/README.md) tells a customer how to do each step. These pages do not
repeat it. They link to it.

## The pages

- [Personas](personas.md): the five people Guard serves.
- Journeys, one file each:

| # | Journey | Main persona |
|---|---|---|
| 1 | [Set up the organisation](journeys/01-org-setup.md) | Org owner |
| 2 | [Invite and onboard people (Track A)](journeys/02-invite-and-onboard.md) | IT admin |
| 3 | [Get my Mac protected](journeys/03-employee-onboarding.md) | Employee |
| 4 | [Recover when off the email links](journeys/04-off-path-recoveries.md) | Employee |
| 5 | [Write and change rules](journeys/05-rules.md) | Security lead |
| 6 | [Blocked, ask for access, admin decides](journeys/06-blocked-and-requests.md) | Employee, IT admin |
| 7 | [Read activity](journeys/07-activity.md) | Security lead |
| 8 | [A Mac goes late or tampered](journeys/08-device-late-or-tampered.md) | IT admin |
| 9 | [Remove Guard and offboard a person](journeys/09-offboarding-and-removal.md) | IT admin, Employee |
| 10 | [Run your own server](journeys/10-self-host.md) | Self-hoster |
| 11 | [Zero-touch enrolment through MDM (Track B)](journeys/11-track-b-mdm.md) | IT admin. **Planned.** |

## How to use these pages

- **Designing a feature.** Find the journey it changes. Read the steps and the gaps. Say in the ticket which step
  changes and which gap it closes.
- **Building a feature.** Each step names what the person sees and what the system records. Keep both true, or
  change the page.
- **Reviewing a change.** If a pull request changes a step and leaves the page alone, ask for the page.
- **Checking a claim.** Each gap names the file it comes from. Read the file before you act on the gap; the code may
  have moved.

## Words

Use the product's own words, as the UI shows them. The same word means the same thing on every page.

| Word | Means |
|---|---|
| Organisation | One customer's tenant. One per server unless `GUARD_MULTI_ORG=1`. |
| Owner, admin, member | The three roles. Owners and admins manage Guard in the dashboard. Members do not. |
| Dashboard | The web console at `<server>/<organisation>/guard`. Management lives only here ([decision 0001](../decisions/0001-web-dashboard-only.md)). |
| Panel | The Mac app's menu-bar panel. Setup, status and removal only. |
| Invitation | A pending invite to join an organisation, made on **People**. |
| Enrol link | A single-use `vibtra-guard://enrol?...` link that connects one Mac to the organisation. |
| Onboarding link | A signed link in an email: `/guard/download/…` or `/guard/enrol/…`. Valid up to 14 days. Not the same as an enrol link. |
| Funnel stage | Invited, Signed in, Enrolled, Certificate trusted, Protected, Late, Tampered. |
| Chase list | People who are Invited or Signed in for longer than the org's chase threshold (7 days by default). |
| Monitor, Enforce | The organisation's protection mode. Monitor records what rules would block. Enforce blocks. |
| Rule | A service rule, a content rule, or an app and website switch. |
| Request | A person's ask for an exception to a block. An admin approves or declines it. |
| Grant | What an approved request creates: an exception for a set time (7 days by default, at most 90). |
| Check-in, Last sync | The Mac's call to the server, about once a minute. |

## Keep them true

- **Same pull request.** A change to shipped behaviour that a journey describes updates that journey in the same
  pull request. This covers UI copy, a new branch or error, a changed default, and a closed or new gap.
- **Gaps are a to-do list.** When a pull request closes a gap, delete the gap line. When you find a new dead end,
  add it with its file path, even if you do not fix it.
- **Planned stays marked.** A planned journey stays marked **Planned** until the code ships. Then rewrite it from the
  code, not from the ticket.
- **Quote the UI.** Copy button and page text exactly from the code. If the copy changes, change it here.
- **No customer data.** This repository is open source. No real customer names, contacts, prices or deal terms.
- **Short.** Each page should read in a few minutes. Link to the guide and to code instead of repeating them.
