# Build under your own Apple team and pre-approve it on managed Macs

> Status: draft. Building under another team's identifiers and generating the profile work from a checkout today.
> To sign and notarize under your team, see [self-signing.md](self-signing.md). Nobody has run it with a real team
> yet. No profile made here has been installed on a managed Mac yet.

Guard's Mac app and its network extension are identified by an Apple team ID and two bundle IDs. Vibtra's builds use
team `P2UU927A6W`, app `app.vibtra.guard` and extension `app.vibtra.guard.extension`. Your organisation can build
Guard under its own team and IDs instead, for example `com.acme.guard` and `com.acme.guard.extension`.

## 1. Choose the identifiers

Write them to `guard/mac/Config/Identity.local.xcconfig` in your checkout. Git ignores this file.

```
GUARD_TEAM_ID = AB12CD34EF
GUARD_APP_ID = com.acme.guard
GUARD_EXTENSION_ID = com.acme.guard.extension
GUARD_REGISTRY_URL = https:/$()/guard.acme.example
```

Or set them for one build only:

```sh
GUARD_TEAM_ID=AB12CD34EF GUARD_APP_ID=com.acme.guard GUARD_EXTENSION_ID=com.acme.guard.extension \
  GUARD_REGISTRY_URL=https://guard.acme.example zsh guard/mac/build.sh --unsigned
```

`GUARD_REGISTRY_URL` is the origin of the Guard server your Macs enrol with. It defaults to Vibtra Cloud,
`https://vibtra.app`. The build compiles it into the agent, and a copy signed by your team talks to no other server
([mac.md](mac.md#which-server-guard-talks-to)). In an `.xcconfig` file, write `//` as `/$()/`, because `//` starts a
comment there.

When you install a copy of Guard built for one server on Macs that were enrolled with another, those Macs stop
syncing. They keep their last verified rules, never receive a revocation and queue their events, and `vibtra-guard
status` shows `registry-origin-mismatch`. Enrol them again with a copy built for their server.

The team ID is the 10 characters in your Apple Developer account's Membership details. Everything else is derived
from the first three values: the app group `<team>.<app ID>`, the extension's service name `<team>.<extension ID>.xpc`
and the bundled agent's signing identifier `<app ID>.agent`. The app reads them from its own `Info.plist` at run
time. Check what a checkout resolves to with `python3 guard/mac/tools/identity.py`.

## 2. Make the device-management profile

```sh
python3 guard/mac/tools/mdm-profile.py --organization "Acme" --out acme-guard.mobileconfig
```

It uses the identifiers from step 1, or `--team`, `--app-id` and `--extension-id`. It refuses to replace an
existing file. The profile has three payloads:

| Payload | What it does |
|---|---|
| System extensions (`com.apple.system-extension-policy`) | Allows the extension from your team, so people are not asked to approve it in System Settings. |
| Content filter (`com.apple.webcontent-filter`) | Pre-approves the content filter the app turns on, matched to your team's signature. |
| Notifications (`com.apple.notificationsettings`) | Allows Guard's block notices as banners. |

Add `--allow-removal` to let people remove the extension without an administrator password.

macOS only honours the system extension payload from a device-management server the Mac is enrolled in. Installing
the file by hand does not approve the extension. If your Macs already get a system extensions payload from another
profile, check how your device-management tool combines them, or add your team and extension ID to that payload.

The profile does not cover the transparent proxy configuration or certificate trust. macOS still asks the person to
allow the proxy configuration once, and the Guard certificate is made on each Mac ([mac.md](mac.md#3-trust-the-guard-certificate)).

## 3. Upload it

Upload the `.mobileconfig` file unsigned. Your device-management server signs it when it delivers it.

- **Jamf Pro**: Computers, Configuration Profiles, Upload. Scope it to the Macs that run Guard.
- **Kandji**: Library, Add new, Custom Profile. Upload the file and assign it to a Blueprint.
- **Microsoft Intune**: Devices, macOS, Configuration, Create, New policy, Templates, Custom. Upload the file and set
  the deployment channel to Device channel.

Install the profile before people install the app, so the extension is approved when the app first turns it on.
