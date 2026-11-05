#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
set -u
setopt pipefail

here=${0:A:h}
cd "$here"

if [[ -z "${VIBTRA_GUARD_AGENT_BIN:-}" ]]; then
  zsh ../agent-go/build.sh || exit 1
fi

identity=${SIGN_IDENTITY:-"Apple Development"}
[[ -z ${GUARD_TEAM_ID:-} && -n ${DEVELOPMENT_TEAM:-} ]] && export GUARD_TEAM_ID=$DEVELOPMENT_TEAM
resolved=$(python3 tools/identity.py --format shell) || exit 2
if [[ -n ${GUARD_TEAM_ID:-}${GUARD_APP_ID:-}${GUARD_EXTENSION_ID:-} ]]; then
  local_config=$here/Config/Identity.local.xcconfig
  backup=$(mktemp "${TMPDIR:-/tmp}/guard-identity.XXXXXX") || exit 1
  if [[ -f $local_config ]]; then
    cp -p "$local_config" "$backup" || exit 1
    trap "mv -f ${(q)backup} ${(q)local_config}" EXIT
  else
    trap "rm -f ${(q)backup} ${(q)local_config}" EXIT
  fi
  python3 tools/identity.py --format xcconfig >"$local_config" || exit 2
fi
eval "$resolved"
team=$GUARD_TEAM_ID
want_signed=1
run_tests=0
for arg in "$@"; do
  case $arg in
    --unsigned) want_signed=0 ;;
    --test) run_tests=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v xcodegen >/dev/null; then
  echo "xcodegen is not installed: brew install xcodegen" >&2
  exit 1
fi
xcodegen generate --quiet || exit 1

app=build/Debug/VibtraGuard.app
ext=$app/Contents/Library/SystemExtensions/$GUARD_EXTENSION_ID.systemextension
logdir=build/logs
mkdir -p $logdir
rm -rf "$app"

common=(-project VibtraGuard.xcodeproj -scheme VibtraGuard -configuration Debug -destination 'platform=macOS'
  SYMROOT="$here/build" OBJROOT="$here/build/obj")
echo "==> identity: team $GUARD_TEAM_ID, app $GUARD_APP_ID, extension $GUARD_EXTENSION_ID"

verdict=""
reason=""

if (( want_signed )); then
  echo "==> signed build: identity \"$identity\", team $team, -allowProvisioningUpdates"
  if xcodebuild "${common[@]}" CODE_SIGN_IDENTITY="$identity" DEVELOPMENT_TEAM="$team" -allowProvisioningUpdates -allowProvisioningDeviceRegistration build >$logdir/signed.log 2>&1; then
    if codesign --verify --strict "$app" 2>/dev/null && codesign --verify --strict "$ext" 2>/dev/null \
       && [[ -f $app/Contents/embedded.provisionprofile && -f $ext/Contents/embedded.provisionprofile ]]; then
      verdict=SIGNED
      reason="with \"$identity\" (team $team) and Xcode-managed development provisioning profiles"
    else
      echo "the signed build finished but did not verify; treating it as unsigned"
    fi
  else
    echo "--- the signed build failed; the errors, verbatim:"
    grep -E "error:|Provisioning|provisioning|No Account|No profiles|requires a provisioning|entitlement" $logdir/signed.log \
      | sed -E 's/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/<apple-id>/g' | sort -u | head -20
    echo "--- (full log: guard/mac/$logdir/signed.log)"
  fi
  if [[ -z $verdict ]]; then
    reason=$(grep -E "error:" $logdir/signed.log | sed -E 's/^.*error: //; s/ \(in target.*$//; s/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/<apple-id>/g' | sort -u | head -3 | tr '\n' ' ')
    [[ -z $reason ]] && reason="the signed build did not verify (see $logdir/signed.log)"
  fi
fi

if [[ -z $verdict ]]; then
  echo "==> unsigned build (CODE_SIGNING_ALLOWED=NO)"
  if ! xcodebuild "${common[@]}" CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY="" build >$logdir/unsigned.log 2>&1; then
    grep -E "error:" $logdir/unsigned.log | sort -u | head -20
    echo "BUILD FAILED (see guard/mac/$logdir/unsigned.log)"
    exit 1
  fi
  verdict=UNSIGNED
  (( want_signed )) || reason="--unsigned was asked for"
  cat <<EOF

Founder steps to get a SIGNED build (README.md "Founder steps" has the detail):
  1. Xcode → Settings → Accounts: the Apple account of team $GUARD_TEAM_ID is signed in.
  2. developer.apple.com → Certificates, Identifiers & Profiles → Identifiers: App IDs $GUARD_APP_ID and
     $GUARD_EXTENSION_ID, each with Network Extensions + System Extension (app only) + App Groups
     ($GUARD_APP_GROUP). Register this Mac under Devices if Xcode asks.
  3. zsh guard/mac/build.sh   (re-runs with -allowProvisioningUpdates; Xcode mints the development profiles)
  4. For other Macs: a Developer ID Application certificate + notarytool (guard/mac/RELEASE.md).
EOF
fi

[[ -d $app ]] || { echo "no app at guard/mac/$app"; exit 1; }
[[ -d $ext ]] && echo "extension bundled: guard/mac/$ext" || echo "WARNING: the extension is not inside the app"
[[ -x $app/Contents/MacOS/vibtra-guard ]] && echo "agent bundled: guard/mac/$app/Contents/MacOS/vibtra-guard" \
  || echo "agent binary missing — run zsh guard/agent-go/build.sh; the app builds and says so"

if (( run_tests )); then
  echo "==> no unit tests remain; the integration tests run in zsh tests/mac/run.sh (CI job mac-integration)"
fi

echo "$verdict: guard/mac/$app — $reason"
