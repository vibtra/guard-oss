# Guard install guide

Guard checks AI requests on a Mac against your organisation's rules. It blocks a supported request before it
leaves the Mac, or lets it through. You manage rules, devices and requests in a web dashboard.

Start here. Pick one of the two ways to run Guard, then follow the pages in order.

## Choose how to run it

| | Download and self-host | Vibtra Cloud |
|---|---|---|
| Who runs the server | You, with Docker Compose | Vibtra, at https://vibtra.app |
| Sign-in | Your own OpenID Connect provider, or your own Google OAuth client | Google, on an address Vibtra has added for you |
| Status | Community Edition. Free, with no caps on devices, seats or usage | **Early access, assisted.** No self-service sign-up. |
| How to start | [Run your own server](self-host.md) | Email sam@vibtra.app. We add your address and set up your organisation with you. |
| Terms | [Licence](#licence) | Interim terms and privacy notice at https://vibtra.app/terms and https://vibtra.app/privacy |

Both run the same server and the same web dashboard. The Mac app is the same in both cases. It talks to whichever
server its enrol link names.

### Download

| Item | Where |
|---|---|
| Source code | https://github.com/vibtra/guard-oss |
| Release | [`guard-v0.1.0`](https://github.com/vibtra/guard-oss/releases/tag/guard-v0.1.0) |
| Signed and notarized Mac app | [`VibtraGuard-arm64.zip`](https://github.com/vibtra/guard-oss/releases/download/guard-v0.1.0/VibtraGuard-arm64.zip) |
| SHA-256 of the zip | [`VibtraGuard-arm64.zip.sha256`](https://github.com/vibtra/guard-oss/releases/download/guard-v0.1.0/VibtraGuard-arm64.zip.sha256) |
| Server | `ghcr.io/vibtra/guard-oss:0.1.0`, run with Docker Compose ([self-host.md](self-host.md)). |

Your organisation can also sign each release under its own Apple team and deliver it to its Macs with device
management ([self-signing.md](self-signing.md)). The dashboard's **Devices** page walks you through it
(**Distribute Guard**).

### Vibtra Cloud

Vibtra Cloud is the same server, run by Vibtra at https://vibtra.app. It is in early access and assisted: sign-ups
are closed, and we add each organisation by hand.

1. Email sam@vibtra.app with your work address and how many Macs you want to protect.
2. We add your address. Then open https://vibtra.app/login and sign in with Google. Your organisation is created on
   first sign-in and you become its owner.
3. Continue at [Install the Mac app](mac.md). Skip [Run your own server](self-host.md).

An address that has not been added is refused at sign-in with a message naming the contact address. Cloud pricing is
not set yet; paid features are by agreement (see [Editions](coverage.md#editions)).

## Supported Macs

- macOS 14 or later.
- Apple silicon (arm64) only. Intel Macs are not supported, and there is no universal build.

The live coverage tests ran on macOS 26.6.2. See [coverage.md](coverage.md#what-was-tested).

## The pages

1. [Run your own server](self-host.md): server setup and real sign-in. Self-host only.
2. [Install the Mac app](mac.md): install, permissions, certificate trust and enrolment.
3. [Set rules](rules.md): create a policy in the web dashboard.
4. [Check it works](check.md): a synthetic allow, block and recovery check.
5. [Troubleshooting](troubleshooting.md): what blocked apps and pages look like, and common fixes.
6. [Restart and recovery](restart.md): what survives a restart of the Mac, the app or the server.
7. [Remove Guard](removal.md): clean removal from one Mac.
8. [What Guard covers](coverage.md): the exact clients, actions and versions tested, and the limits.
9. [Managed Macs](managed-macs.md): build under your own Apple team and pre-approve it with a device-management profile.
10. [Sign under your own team](self-signing.md): sign, notarize and package each release with your Developer ID, by hand or in CI.

## Where you manage Guard

All management is in the web dashboard, at `<your server>/<your organisation>/guard`. The Mac app is a menu-bar app
with setup, status and removal only. It has no dashboard of its own. See [mac.md](mac.md#the-menu-bar-panel).

## Limits today

- **Not yet checked on a release build.** The signed and notarized release has not been through the install, check
  and removal steps on these pages yet. Where a page says so, the steps follow tests and development builds.
- **Coverage is per client and version.** Guard blocks the tested actions in [coverage.md](coverage.md), not every AI
  app, site or request.

## Licence

The server and web dashboard are AGPL-3.0-only. The Mac client (`guard/`) and the shared contract are Apache-2.0.
The repository's top-level `README.md` has the full table, and `docs/decisions/0002-community-edition.md` records
what the free edition includes.
