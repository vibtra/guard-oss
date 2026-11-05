# Guard arm64 Developer ID preparation

`release.py` is separate from the development `build.sh`. It prepares a **non-notarized** arm64 app and submission ZIP. It never submits to Apple, installs/replaces an app, changes trust/policy, registers a device, downloads profiles, or falls back to development/ad-hoc signing.

The current Mac has one valid Apple Development identity and **zero Developer ID Application identities** (metadata-only check, 20 October 2026; preflight re-run 24 October 2026 with the same result). No customer-signed artifact has been produced. The implementation and refusal tests do not substitute for a real Developer ID build and clean-Mac acceptance.

## Prerequisites

- A valid Developer ID Application identity with its private key available to `codesign`, for the chosen team. No private-key export is required. The current release entitlements use team `P2UU927A6W`.
- Already-installed Developer ID/all-device provisioning profiles for `app.vibtra.guard` and `app.vibtra.guard.extension`, containing that signing certificate and matching their release entitlements. Use Xcode's standard `~/Library/Developer/Xcode/UserData/Provisioning Profiles` or `~/Library/MobileDevice/Provisioning Profiles` directory. Device-bound development profiles are refused.
- Release Network Extension values `content-filter-provider-systemextension` and `app-proxy-provider-systemextension`; the app also needs system-extension installation. The actual source App Group is `P2UU927A6W.app.vibtra.guard`.
- Xcode, `xcodegen`, Go and the checked-in dependencies. Building uses explicit `GOOS=darwin`, `GOARCH=arm64`, `CGO_ENABLED=0` and read-only Go modules. Intel/universal distribution is not claimed.
- Later, a privately configured `notarytool` Keychain profile and a separate clean test Mac. The preparation script does not read or validate notarization credentials.

## Preflight and build

Supply the paths to your already-installed profiles; the example names are placeholders, not existing profiles:

```sh
APP_PROFILE="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/APP-UUID.provisionprofile"
EXT_PROFILE="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles/EXTENSION-UUID.provisionprofile"
python3 guard/mac/release.py preflight \
  --app-profile "$APP_PROFILE" --extension-profile "$EXT_PROFILE"
```

Preflight runs every check, even after one fails, and prints a JSON report: each check's status, `blockedOnFounder` (the Apple-issued items: identity and the two profiles), `blockedOnCode` (anything else, normally empty), `minimumMacOS`, and `founderActions`, the exact certificate, profiles (with the entitlement values each must authorize) and notarytool credentials to provision. It exits 1 until nothing is blocked. With no arguments on this Mac today, only the three founder checks fail.

Preflight refuses missing/ambiguous Developer ID identities, expired/wrong-team/device-bound profiles, wrong application IDs, missing signing certificates, or incompatible release capabilities. Select an identity explicitly with `--identity SHA1` if several valid Developer ID identities exist. The SHA1 is a public certificate identifier, not a credential. Profile decoding/validation is preparation; Xcode and the final signature checks must also succeed.

Only after preflight succeeds:

```sh
python3 guard/mac/release.py build \
  --app-profile "$APP_PROFILE" --extension-profile "$EXT_PROFILE" \
  --out /private/tmp/guard-release-arm64-candidate
```

The output must be a new directory. The script creates it mode0700 and stores private build logs. Build subprocesses receive an allowlisted environment, excluding inherited API keys and notarization passwords. `xcodegen` regenerates the checked-in project from `project.yml`; no profile UUID or credential is written into project source. UUIDs are supplied separately to each target through build settings.

The Release configuration uses manual Developer ID signing, hardened runtime, secure timestamps, and arm64. Nested agent signing requests `--timestamp` for Release; Debug retains `--timestamp=none`. An unsigned/ad-hoc Release agent is refused. Secure timestamping during an authorized build requires the Apple timestamp service; no timestamp-free retry exists.

After the build, each nested agent/extension/app must pass strict signature verification against the Apple anchor, **exact selected signing certificate** and team. The script also checks Developer ID authority, secure timestamps, hardened runtime, arm64 architecture, embedded profile identity/capabilities, and the declared release entitlements. A failed check stops packaging. There is no unsigned fallback or success report on failure.

Success creates `VibtraGuard-arm64.zip`, `VibtraGuard-arm64.zip.sha256` (checked with `shasum -a 256 -c VibtraGuard-arm64.zip.sha256`) and `release-report.json` with status `developer-id-prepared-not-notarized`, `architecture: arm64`, `minimumMacOS` (from `project.yml`, currently 14.0), archive SHA256, `notarized: false`, and `installed: false`. The app is under `products/Release/VibtraGuard.app`. Intermediate output from a failed build is not a release candidate.

## Future operator-run notarization and final package

These steps were **not executed**. Use an existing privately configured Keychain profile name; never paste an app-specific password, API private key, or credential contents into a command transcript. No credentials are accepted by `release.py`.

```sh
# Set CANDIDATE to the successful new output directory and NOTARY_PROFILE
# to an existing Keychain profile name (an alias, not a password).
xcrun notarytool submit "$CANDIDATE/VibtraGuard-arm64.zip" \
  --keychain-profile "$NOTARY_PROFILE" --wait
```

Require the submission's **Accepted** result. A timeout or upload success does not establish acceptance. Investigate a rejected submission before making another artifact; do not use `--force` to waive checks.

```sh
APP="$CANDIDATE/products/Release/VibtraGuard.app"
xcrun stapler staple "$APP"
xcrun stapler validate "$APP"
codesign --verify --strict "$APP"
spctl --assess --type execute --verbose=2 "$APP"
# Create a new distribution ZIP containing the stapled app, rather than reusing
# the earlier pre-stapling submission ZIP. Choose a new final filename.
ditto -c -k --keepParent "$APP" "$CANDIDATE/VibtraGuard-arm64-notarized.zip"
```

Retain the submission ID, Accepted result, final archive digest and verification outputs. The preparation report remains a record of the earlier non-notarized archive; do not relabel it as notarization evidence.

On a separate clean Mac, test a real quarantined download, Gatekeeper, copying the app into Applications, first-launch onboarding, system-extension/filter/proxy approval, CA onboarding, upgrade/restart, enforcement, and uninstall/cleanup ([docs/removal.md](../../docs/removal.md); `tests/mac/test_uninstall.py` covers the script offline only). Existing trust/profiles/extensions on this development Mac cannot prove those steps. A Developer ID Installer certificate is only an additional requirement if a PKG distribution is chosen; this path produces a ZIP/app.

## Local validation

```sh
python3 -m unittest discover -s tests/mac -p test_release.py -v
python3 guard/mac/release.py preflight
```

The offline tests in `tests/mac/test_release.py` (CI job `mac-integration`, macos-latest) cover the all-checks preflight report and its founder list, the checksum file and minimum macOS in the build report, identity/profile refusal, command-plan arm64/manual-signing guarantees, a signing failure with no fallback, credential environment stripping, signature/timestamp/architecture checks, and the actual project build phase under a stub signer (Debug, signed Release, unsigned Release, ad-hoc Release, and failing signers in both configurations). Current real preflight exits 1 and lists the founder items, because Developer ID is absent; it never generates, builds or packages anything. Real Developer ID signing, timestamp service access and notarization remain unverified until the prerequisites exist.
