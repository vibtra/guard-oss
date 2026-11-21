# Journey 11: Zero-touch enrolment through MDM (Track B)

> **Planned. Not built.** Ticket VIB-72, in the backlog and not scheduled. This page records the intended journey
> and what exists today, so nobody builds on parts that are missing. Rewrite it from the code when it ships.

- **Persona:** [IT admin](../personas.md#it-admin), with a device-management (MDM) tool such as Jamf Pro, Kandji or
  Intune. The [employee](../personas.md#employee) does nothing.
- **Trigger:** the organisation has more Macs than it wants to chase one by one, or must not depend on each person
  following an email ([journey 2](02-invite-and-onboard.md) is Track A).

## Intended journey

1. The IT admin signs Guard under their own Apple team for their server
   ([self-signing.md](../../guide/self-signing.md)).
2. The MDM pushes the app and a configuration profile: system extension, content filter and notifications.
3. The MDM also delivers an organisation enrol secret.
4. The Mac enrols itself. The person's identity comes from the MDM or from single sign-on.
5. The certificate is trusted without a prompt, through an organisation root certificate.
6. The person appears in the same funnel as Track A: Enrolled, Certificate trusted, Protected
   ([journey 8](08-device-late-or-tampered.md) for the later stages).

## What exists today

| Step | Today |
|---|---|
| Sign under your own team | Built, draft. `guard/mac/tools/sign-guard.py`, and **Devices**, **Distribute Guard** in the dashboard. Not yet run with a real Apple team. |
| Profile for extension, filter, notifications | Built, draft. `guard/mac/tools/mdm-profile.py` ([managed-macs.md](../../guide/managed-macs.md)). No profile has been installed on a managed Mac yet. |
| Organisation enrol secret | Not built. Every enrol link is for one person and works once. |
| Identity from MDM or SSO | Not built. Enrolment names the person on the server side, from the admin or from the person's own sign-in. |
| Silent certificate trust | Not built. Each Mac makes its own certificate in its Secure Enclave and the person trusts it with their login password. An organisation root needs a design first. |
| Proxy configuration approval | The profile does not cover it. macOS still asks the person once. |
| Same funnel | Yes, once a Mac enrols it moves through the same stages. |

## What an admin can do today with MDM

Pre-install a self-signed Guard and pre-approve its extension with the profile. Each person still opens the enrol
link (or makes one at `/guard/enrol`, [journey 4](04-off-path-recoveries.md)), trusts the certificate and allows the
proxy configuration. The download link in the invitation email shows "Your IT team sends Guard" when the server has
no `VIBTRA_GUARD_DOWNLOAD_URL`, which fits this case.

## Open questions

- **Organisation root certificate.** Per-Mac keys in the Secure Enclave are a security property today. An org root
  that MDM can trust changes the threat model. Who holds its key, and how is it rotated?
- **Org enrol secret.** If an MDM-delivered secret enrols any Mac, a leaked profile enrols any Mac. Does the server
  need a device serial allowlist from the MDM?
- **Identity.** Which source names the person: the MDM's assigned user, the macOS console user, or an SSO sign-in in
  the app? Sign-in inside the Mac app is out of scope in VIB-74.
- **Paid line.** Is Track B a paid feature ([decision 0002](../../decisions/0002-community-edition.md))?
