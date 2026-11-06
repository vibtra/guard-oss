# Sign Guard under your own Apple team

> Status: draft. The signing wizard and the CI template are tested against a fake App Store Connect server and
> stand-in Apple tools only. Nobody has run them with a real team yet, and no customer-signed build has been
> installed on a Mac.

Guard's Mac app and its network extension can be signed with your organisation's Developer ID instead of
Vibtra's. Your Macs then trust your team, and your device-management profile names your team
([managed-macs.md](managed-macs.md)). `guard/mac/tools/sign-guard.py` does the whole job for one release tag. The
model is Fleet's `fleetctl package --sign-identity --notarize`.

The dashboard walks you through it too: on **Devices**, choose **Distribute Guard**. It lists what you need, fills in
the commands below with your team ID, bundle ID prefix, release tag, organisation name and server address, and lists
how to recover from each common failure. Vibtra also publishes a signed download, so you only need this page if you want
your Macs to trust your own Apple team.

## What you need once

| Item | Where it comes from |
|---|---|
| A paid Apple Developer Program membership for your organisation | developer.apple.com. An organisation account, not an individual one. Apple charges a yearly fee. Your team ID is the 10 characters under Membership details. |
| Developer ID Application certificate, with its private key in the signing Mac's keychain | Only the Account Holder can create it: Certificates, Identifiers & Profiles, then Certificates. Export it with its key as a `.p12` file for CI. The wizard signs with `codesign` and a keychain identity, so it does not use Apple's cloud-managed certificates yet. |
| App Store Connect API key with the Admin role | App Store Connect, Users and Access, Integrations, App Store Connect API. Note the key ID and issuer ID. You can download the `AuthKey_<key ID>.p8` file once. |
| A bundle ID prefix you own | For example `com.acme.guard`. The extension is `com.acme.guard.extension`. |
| A Mac with Xcode, Go and xcodegen | The same tools as [guard/mac/RELEASE.md](../../guard/mac/RELEASE.md), or a macOS runner with the [CI template](#re-sign-every-release-in-ci). |
| A device-management tool | Jamf Pro, Kandji, Microsoft Intune or another tool that delivers configuration profiles. macOS pre-approves the network extension only from a profile your device-management server delivers ([managed-macs.md](managed-macs.md)). |
| One re-sign per Guard release | Each new release tag is signed again, by hand or in CI. See [what each release costs](#what-each-release-costs). |

The wizard only reads the `.p8` file. openssl reads it to sign each App Store Connect request, and notarytool reads
it to notarize. The wizard never copies, prints or logs it.

## Sign one release

```sh
git clone https://github.com/vibtra/guard-oss guard && cd guard
git checkout guard-v0.2.0
python3 guard/mac/tools/sign-guard.py --team AB12CD34EF --bundle-prefix com.acme.guard \
  --key-id 2X9R4HXF34 --issuer-id 57246542-96fe-1a63-e053-0824d011072a \
  --key-file ~/keys/AuthKey_2X9R4HXF34.p8 --tag guard-v0.2.0 --out ~/guard-release --organization "Acme"
```

Add `--dry-run` first to see every call it will make. A dry run calls nothing and writes nothing.

The wizard runs these steps in order:

1. It checks that the checkout is exactly the tag, with no local changes.
2. It finds your Developer ID Application identity in the keychain. Pass `--identity <SHA-1>` if you have more than
   one.
3. It finds that certificate in the API key's account. A key from another team stops here, before anything is
   created.
4. It registers both bundle IDs for macOS and turns on Network Extensions, System Extension (app only) and App
   Groups.
5. It creates one Developer ID profile per bundle ID and installs both in
   `~/Library/Developer/Xcode/UserData/Provisioning Profiles`. On later runs it reuses them while they are active.
   It replaces a profile only after Apple marks it invalid, or when you pass `--new-profiles`.
6. It runs `release.py preflight` to check the profiles, then `release.py build` to build and sign.
7. It notarizes with notarytool, using the same API key, then staples the app and checks it with Gatekeeper.
8. It writes the files in the table below to `--out`.

| File | What it is |
|---|---|
| `Guard-<tag>-<team>-arm64.zip` | The notarized, stapled app to give to your Macs |
| `Guard-<tag>-<team>-arm64.zip.sha256` | Its checksum. Check it with `shasum -a 256 -c <file>`. |
| `<bundle prefix>.mobileconfig` | The device-management profile for this build ([managed-macs.md](managed-macs.md#3-upload-it)) |
| `signing-report.json`, `notarization.json`, `notary-log.json`, `logs/` | What was signed, Apple's notarization result and the tool output |

Each failure prints `fix:` and the next thing to do. The wizard writes `guard/mac/Config/Identity.local.xcconfig`
for the build and puts it back afterwards. `release.py` reads only that file, not the `GUARD_*` environment
variables `build.sh` accepts.

### If the API cannot make usable profiles

Apple's API can create Developer ID profiles (`MAC_APP_DIRECT`) and turn on the Network Extensions and System
Extension capabilities. It cannot choose which Network Extension values a profile carries. If a profile lacks
`content-filter-provider-systemextension` or `app-proxy-provider-systemextension`, the wizard stops before building
and prints the manual steps from developer.apple.com. Make the two profiles there, move them into the profile
folder above and run again with `--app-profile` and `--extension-profile`. With those options the wizard does not
call the API.

### The keychain group for the CA key

The app keeps Guard's CA key in the Mac's Secure Enclave, on the keychain shelf `<team>.<bundle prefix>.ca`. macOS
lets the app use that shelf only if the app's profile allows it. Check the app profile:

```sh
security cms -D -i <app profile> | plutil -p - | grep -A3 keychain-access-groups
```

It must list `<team>.*` or `<team>.<bundle prefix>.ca`. Developer ID profiles normally list `<team>.*`. If yours
lists neither, edit the profile on developer.apple.com, save it, download it again and run the wizard with
`--app-profile` and `--extension-profile`. `release.py preflight` refuses an app profile without it, so the wizard stops
before it builds anything. The extension profile does not need it.

The wizard also refuses a build whose agent was built with the Go build tag `guard_test`. That tag makes a test
build, which never ships. It can only come from your Go environment: check `go env GOFLAGS`.

### Developer builds

`zsh guard/mac/build.sh` signed with your own team (an Apple Development certificate is fine) signs the app and the
bundled agent with the same identity. The bundled agent keeps the identifier `<bundle prefix>.agent` and has no
entitlements. Guard then intercepts TLS only on a Mac with a Secure Enclave, and only when the development profile
Xcode makes lists `<team>.*` or `<team>.<bundle prefix>.ca` under `keychain-access-groups` ([the keychain
group](#the-keychain-group-for-the-ca-key)). An unsigned build (`--unsigned`, a signed build that failed, or the
ad-hoc agent from `zsh guard/agent-go/build.sh` run on its own, or by the app through `VIBTRA_GUARD_AGENT_BIN`)
cannot use the Secure Enclave: `vibtra-guard status` shows `interception off: unsigned build`, and every other part
of Guard still runs. Contributors outside Vibtra get interception the same way, with their own Apple team.

## Deliver it to your Macs

Do these in order. The profile has to be on a Mac before the app turns its extension on, or macOS asks the person to
approve the extension instead.

1. **Upload the profile.** Upload `<bundle prefix>.mobileconfig` unsigned and scope it to the Macs that will run Guard.
   Your device-management server signs it when it delivers it. Upload it once: it stays the same for every release
   under the same team and bundle IDs.
   - **Jamf Pro:** Computers, Configuration Profiles, Upload. Scope it to a computer group.
   - **Kandji:** Library, Add new, Custom Profile. Upload the file and assign it to a Blueprint.
   - **Microsoft Intune:** Devices, macOS, Configuration, Create, New policy, Templates, Custom. Upload the file, set
     the deployment channel to Device channel and assign it to a device group.
2. **Deliver the app.** `VibtraGuard.app` goes in `/Applications`.
   - **Kandji:** Library, Add new, Custom App. Choose the ZIP install type, upload the ZIP and set the unzip location to
     `/Applications`. Not tested yet.
   - **Jamf Pro and Intune** install packages, not ZIPs. Wrap the stapled app in a package first:

     ```sh
     ditto -x -k Guard-<tag>-<team>-arm64.zip app
     pkgbuild --component app/VibtraGuard.app --install-location /Applications \
       --identifier <bundle prefix>.pkg --version <tag without guard-v> VibtraGuard-<tag>.pkg
     ```

     In Jamf Pro, upload it under Settings, Computer management, Packages, then install it with a policy. In Intune,
     add it under Apps, macOS, Add, macOS app (PKG). Whether your tool also needs the package signed with a Developer
     ID Installer certificate depends on the tool and app type. The wizard does not make or sign packages, and nobody
     has tested these package steps yet.
   - **By hand:** check the checksum with `shasum -a 256 -c Guard-<tag>-<team>-arm64.zip.sha256`, unzip it and move
     the app to `/Applications`.
3. **Enrol each Mac.** On **Devices**, choose **Enrol laptop** and make a one-time link for the person who uses that
   Mac. Open the link on the Mac ([mac.md](mac.md#2-enrol)). The link names your server, so a customer-signed build
   enrols to it the same way as any other build.

## Update to a new release

Sign the new tag with the same team and bundle prefix, by hand or in CI, then deliver the new ZIP or package the way
you delivered the first. Keep the profile you already uploaded. When the new app bundles a newer network extension,
the menu-bar panel offers **Update network extension** ([mac.md](mac.md#4-turn-on-the-network-extension)). If macOS
then asks the person to allow the extension in System Settings, the profile is not on that Mac: check its scope.

## Re-sign every release in CI

[`guard/mac/templates/re-sign-guard.yml`](../../guard/mac/templates/re-sign-guard.yml) is a GitHub Actions workflow
for a private repository of your own. Copy it to `.github/workflows/re-sign-guard.yml` and add these settings:

| Kind | Name | Value |
|---|---|---|
| Variable | `APPLE_TEAM_ID` | Your team ID |
| Variable | `GUARD_BUNDLE_PREFIX` | For example `com.acme.guard` |
| Variable | `GUARD_ORGANIZATION` | Shown in the `.mobileconfig` (optional) |
| Secret | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER_ID` | From App Store Connect |
| Secret | `APPLE_API_KEY_P8` | The full text of the `.p8` file |
| Secret | `DEVELOPER_ID_P12` | The `.p12` export, base64-encoded: `base64 -i developer-id.p12 \| pbcopy` |
| Secret | `DEVELOPER_ID_P12_PASSWORD` | The password you gave the `.p12` export |

Run it from the Actions tab with a Guard release tag. The workflow imports the certificate into a temporary keychain,
writes the key to the runner's temporary folder, runs the wizard and uploads the ZIP, its checksum, the
`.mobileconfig` and the reports as one artifact. It always deletes the keychain and the key at the end, even when a
step fails. It follows GitHub's guide to installing an Apple certificate on macOS runners. Every action is pinned to
a commit.

## What each release costs

| Cost | When | Size |
|---|---|---|
| macOS runner time | Every release | One run is the build plus notarization, about 20 to 40 minutes. GitHub bills macOS minutes at a higher rate than Linux minutes. Check your plan's current rate. A Mac you own costs nothing per run. |
| Notarization | Every release | Free. It is usually done in a few minutes, but Apple sometimes takes an hour or more. The template allows two hours. |
| Provisioning profiles | First run, then only when Apple marks them invalid | Free. Later runs reuse them. |
| People's time | Every release | None, unless a run fails. Someone picks the tag and runs the workflow. |
| Apple Developer Program | Every year | Apple's annual membership fee |
| Developer ID certificate | About every 5 years | Free, but the Account Holder must renew it, then update `DEVELOPER_ID_P12`. The next run makes new profiles for the new certificate. |
| Device-management profile | Only when the team or bundle IDs change | The `.mobileconfig` stays the same for every release under the same identifiers, so upload it once. |

Give your Macs each new ZIP the same way you gave them the first one: through your device-management tool, or by
hand.

## Remove Guard from a Mac

The removal script ships inside each build and reads that build's own team and bundle IDs from its `Info.plist`, so
it removes a customer-signed build's files, extension and app group (`<team>.<bundle prefix>`), not Vibtra's:

```sh
zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh --dry-run
zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh
```

If the app is already gone, run the script from a checkout of the same tag with
`GUARD_TEAM_ID=<team> GUARD_APP_ID=<bundle prefix> GUARD_EXTENSION_ID=<bundle prefix>.extension`. It refuses to run
when it cannot tell which build it is removing. Unless the profile was made with `--allow-removal`, macOS asks for an
administrator password to remove the extension. Then take the Mac out of the profile's scope in your device-management
tool, and revoke the Mac on **Devices**. See [removal.md](removal.md) for every step.

## If a step fails

Every refusal from the wizard prints `sign-guard:` with the problem, then `fix:` with the next step. The common ones:

| What you see | What to do |
|---|---|
| No Developer ID Application identity for team `<team>` | Ask the Account Holder to create the certificate. Import it with its private key into the signing Mac's keychain, then run again. Pass `--identity <SHA-1>` if there are several. |
| The API key belongs to team `<other>`, or the certificate is not in its account | Make an API key with the Admin role in the App Store Connect account of the team you passed. The wizard stopped before creating anything. |
| The provisioning profiles failed the release checks | Make the two Developer ID profiles by hand as the wizard prints ([above](#if-the-api-cannot-make-usable-profiles)), then run again with `--app-profile` and `--extension-profile`. |
| Provisioning profile does not allow keychain-access-groups `<team>.<bundle prefix>.ca` | The app profile lacks the keychain group for the CA key. Get a profile that lists `<team>.*` ([above](#the-keychain-group-for-the-ca-key)), then run again with `--app-profile` and `--extension-profile`. |
| release.py build refused: The agent was built with -tags guard_test | Your Go environment adds the test tag. Remove it from `go env GOFLAGS` (`go env -u GOFLAGS`), then run again with a new `--out`. |
| Apple did not accept the submission | Read `notary-log.json` in the output folder. Nothing was shipped. If it names your certificate or signature, fix that and run again with a new `--out`. If it names Guard's own code, send the log to Vibtra. |
| This checkout is not at `<tag>`, or has local changes | `git fetch --tags && git checkout <tag>`, or clone the tag again, then run again. |
| `--out` already exists, or is inside the checkout | Pass a new folder outside the checkout. Nothing is overwritten. |
| Macs still ask people to allow the extension | The profile has not reached that Mac. Check its scope, and that it was installed before the app. A profile installed by hand does not approve the extension. |
| An enrol link says it is used or expired | Make a new link with **Enrol laptop**. Each link enrols one Mac, once. |

For everything after install, see [troubleshooting.md](troubleshooting.md).
