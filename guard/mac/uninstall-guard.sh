#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Vibtra
set -u
setopt pipefail

dry=0
yes=0
from_app=0
app=/Applications/VibtraGuard.app
usage() {
  print -r -- "usage: zsh uninstall-guard.sh [--dry-run] [--yes] [--from-app] [--app PATH]"
}
while (( $# )); do
  case $1 in
    --dry-run) dry=1 ;;
    --yes) yes=1 ;;
    --from-app) from_app=1 ;;
    --app) shift; app=${1:-} ;;
    -h|--help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if (( EUID == 0 )); then
  print -r -- "Run this as the person who uses Guard, not with sudo. macOS asks for a password when it needs one." >&2
  exit 2
fi
if [[ -z ${HOME:-} || $HOME != /* || ! -d $HOME ]]; then
  print -r -- "HOME is not a directory; nothing was changed." >&2
  exit 2
fi

tools=${GUARD_UNINSTALL_TOOLS:-}
tool() { if [[ -n $tools ]]; then print -r -- "$tools/${1:t}"; else print -r -- "$1"; fi }
SECURITY=$(tool /usr/bin/security)
OPENSSL=$(tool /usr/bin/openssl)
PKILL=$(tool /usr/bin/pkill)
LAUNCHCTL=$(tool /bin/launchctl)
OSASCRIPT=$(tool /usr/bin/osascript)
SYSEXT=$(tool /usr/bin/systemextensionsctl)
DEFAULTS=$(tool /usr/bin/defaults)
PLUTIL=$(tool /usr/bin/plutil)

team_id=""
app_id=""
ext_id=""
here=${0:A:h}
if [[ ${here:t} == Resources && -f ${here:h}/Info.plist ]]; then
  team_id=$("$PLUTIL" -extract GuardTeamID raw -o - "${here:h}/Info.plist" 2>/dev/null || true)
  app_id=$("$PLUTIL" -extract GuardAppBundleID raw -o - "${here:h}/Info.plist" 2>/dev/null || true)
  ext_id=$("$PLUTIL" -extract GuardExtensionBundleID raw -o - "${here:h}/Info.plist" 2>/dev/null || true)
else
  for config in "$here/Config/Identity.xcconfig" "$here/Config/Identity.local.xcconfig"; do
    [[ -f $config ]] || continue
    while IFS= read -r line; do
      [[ $line =~ '^[[:space:]]*(GUARD_TEAM_ID|GUARD_APP_ID|GUARD_EXTENSION_ID)[[:space:]]*=[[:space:]]*([^[:space:]]+)[[:space:]]*$' ]] || continue
      case $match[1] in
        GUARD_TEAM_ID) team_id=$match[2] ;;
        GUARD_APP_ID) app_id=$match[2] ;;
        GUARD_EXTENSION_ID) ext_id=$match[2] ;;
      esac
    done <"$config"
  done
fi
team_id=${GUARD_TEAM_ID:-$team_id}
app_id=${GUARD_APP_ID:-$app_id}
ext_id=${GUARD_EXTENSION_ID:-$ext_id}
bundle_id='^[A-Za-z0-9-]+([.][A-Za-z0-9-]+)+$'
if [[ ! $team_id =~ '^[A-Z0-9]{10}$' || ! $app_id =~ $bundle_id || ! $ext_id =~ $bundle_id ]]; then
  print -r -- "Could not tell which Guard build this is: set GUARD_TEAM_ID, GUARD_APP_ID and GUARD_EXTENSION_ID. Nothing was changed." >&2
  exit 2
fi
group=$team_id.$app_id
lib=$HOME/Library
login=$lib/Keychains/login.keychain-db
data=${VIBTRA_GUARD_DIR:-$lib/Application Support/Vibtra Guard}
if [[ $data != /* || $data == / || $data == $HOME || $data == $HOME/ ]]; then
  print -r -- "VIBTRA_GUARD_DIR must be Guard's own directory; nothing was changed." >&2
  exit 2
fi
failures=0
reboot=0
leftover=0

step() { print -r -- ""; print -r -- "==> $*" }
note() { print -r -- "    $*" }
act() {
  print -r -- "    + ${(j: :)${(q-)@}}"
  (( dry )) && return 0
  "$@" || { note "(that step did not complete: exit $?)"; (( ++failures )); return 0 }
}
stop_process() {
  print -r -- "    + ${(q-)PKILL} -x $1"
  (( dry )) && return 0
  "$PKILL" -x "$1"
  case $? in
    0) note "Stopped $1." ;;
    1) note "$1 was not running." ;;
    *) note "(could not stop $1)"; (( ++failures )) ;;
  esac
}

(( dry )) && print -r -- "Dry run: nothing will be changed. Every action is printed with a leading +."
if (( ! dry && ! yes )); then
  print -r -- "This removes Vibtra Guard from this Mac: the app, its agent and network extension, the Guard"
  print -r -- "certificate and Guard's local files. macOS may ask for your password. Run with --dry-run to see each step."
  read -q "?Remove Vibtra Guard? [y/N] " || { print; print -r -- "Nothing was changed."; exit 1 }
  print
fi

device=""
if [[ -f $data/device.json ]]; then
  device=$("$PLUTIL" -extract deviceId raw -o - "$data/device.json" 2>/dev/null || true)
fi

step "Stop Vibtra Guard"
if (( from_app )); then
  note "The app stopped its agent and quits when this finishes."
else
  stop_process VibtraGuard
fi
stop_process vibtra-guard

step "Launch agents"
plists=("$lib"/LaunchAgents/${app_id}*.plist(N))
if (( ${#plists} == 0 )); then
  note "None. This release does not install a launch agent."
fi
for plist in $plists; do
  act "$LAUNCHCTL" bootout "gui/$UID" "$plist"
  act /bin/rm -f "$plist"
done

step "Guard certificate in the login keychain"
work=$(mktemp -d "${TMPDIR:-/tmp}/guard-uninstall.XXXXXX") || exit 1
trap '/bin/rm -rf "$work"' EXIT
typeset -A certs keychain
consider() {
  local pem=$1 subject sha1
  subject=$("$OPENSSL" x509 -in "$pem" -noout -subject -nameopt RFC2253 2>/dev/null) || return 0
  subject=${subject//, /,}
  [[ ( $subject == *"CN=Vibtra Guard local CA ("* || $subject == *"CN=Vibtra Guard CA ("* ) &&
     ( $subject == *"O=Vibtra Guard,"* || $subject == *"O=Vibtra Guard" ) ]] || return 0
  sha1=$("$OPENSSL" x509 -in "$pem" -noout -fingerprint -sha1 2>/dev/null) || return 0
  sha1=${${sha1#*=}//:/}
  [[ $sha1 =~ '^[0-9A-Fa-f]{40}$' ]] || return 0
  certs[${(U)sha1}]=$pem
  [[ ${2:-} == keychain ]] && keychain[${(U)sha1}]=1
  return 0
}
[[ -f $data/ca.pem ]] && consider "$data/ca.pem"
if [[ -f $login ]]; then
  note "Reading certificates whose names start with \"Vibtra Guard\" from $login (read only)."
  if "$SECURITY" find-certificate -a -c "Vibtra Guard" -p "$login" >"$work/found.pem" 2>/dev/null; then
    awk -v dir="$work" '/-----BEGIN CERTIFICATE-----/{n++; f=dir "/keychain-" n ".pem"} f{print > f} /-----END CERTIFICATE-----/{close(f); f=""}' "$work/found.pem"
    for pem in "$work"/keychain-*.pem(N); do consider "$pem" keychain; done
  fi
fi
if (( ${#certs} == 0 )); then
  note "No Guard certificate found."
fi
for sha1 in ${(ok)certs}; do
  note "Guard certificate $sha1"
  print -r -- "    + ${(q-)SECURITY} remove-trusted-cert ${(q-)certs[$sha1]}"
  if (( ! dry )) && ! "$SECURITY" remove-trusted-cert "${certs[$sha1]}"; then
    note "(no trust setting was removed: it was never trusted, or the password prompt was cancelled)"
  fi
  if (( ${+keychain[$sha1]} )); then
    act "$SECURITY" delete-certificate -Z "$sha1" "$login"
  fi
done

step "Network extension and routing"
if (( from_app )); then
  note "The app removed both network configurations and asked macOS to remove the extension."
elif [[ $app == /*.app && -d $app && $("$PLUTIL" -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist" 2>/dev/null) == $app_id ]]; then
  exe=$("$PLUTIL" -extract CFBundleExecutable raw -o - "$app/Contents/Info.plist" 2>/dev/null || true)
  if [[ -n $exe && $exe != */* && -x $app/Contents/MacOS/$exe ]]; then
    note "The app asks macOS to remove the Network Extension, which stops routing. macOS may ask you to approve it."
    print -r -- "    + ${(q-)app}/Contents/MacOS/${(q-)exe} --remove-extension"
    if (( ! dry )); then
      "$app/Contents/MacOS/$exe" --remove-extension
      case $? in
        0) note "macOS removed the extension." ;;
        3) note "macOS removes the extension at the next restart."; reboot=1 ;;
        *) note "(the app could not remove the extension)"; (( ++failures )) ;;
      esac
    fi
  else
    note "(the app has no executable to remove the extension with)"
    (( ++failures ))
  fi
  note "Moving the app to the Trash. macOS may ask to let this terminal control Finder."
  act "$OSASCRIPT" -e 'on run argv' -e 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)' -e 'end run' "$app"
elif [[ -e $app ]]; then
  note "$app is not the Vibtra Guard app ($app_id); it was left alone."
else
  note "No app at ${app:-(none)}. If Vibtra Guard is elsewhere, run again with --app PATH."
fi
listing=$("$SYSEXT" list 2>/dev/null | grep -F "$ext_id" || true)
if [[ -n $listing ]]; then
  note "macOS lists the extension:"
  print -r -- "$listing" | sed 's/^/      /'
  if [[ $listing == *"waiting to uninstall on reboot"* ]]; then
    reboot=1
  elif [[ $listing == *"[activated "* ]] && (( ! dry )); then
    leftover=1
  fi
fi

step "Guard's local files"
for dir in "$data" "$lib/Logs/Vibtra Guard" "$lib/Group Containers/$group" "$lib/Caches/$app_id" \
           "$lib/HTTPStorages/$app_id" "$lib/Saved Application State/$app_id.savedState"; do
  if [[ -e $dir ]]; then
    act /bin/rm -rf "$dir"
  fi
done
if [[ -f $lib/Preferences/$app_id.plist ]]; then
  act "$DEFAULTS" delete "$app_id"
  act /bin/rm -f "$lib/Preferences/$app_id.plist"
fi
note "Removed with the data directory: enrolment, policy, the queued events, the Guard certificate's private key and"
note "the command-line trust files (guard-ca.pem, guard-ca-bundle.pem)."

profiles=()
for f in "$HOME"/.zshrc "$HOME"/.zprofile "$HOME"/.bashrc "$HOME"/.bash_profile "$HOME"/.profile; do
  [[ -f $f ]] && grep -qE 'guard-ca(-bundle)?\.pem' "$f" && profiles+=("$f")
done
if (( ${#profiles} )); then
  step "Shell profiles (not changed)"
  note "These files still point command-line tools at Guard's certificate. Remove the lines that mention"
  note "guard-ca.pem or guard-ca-bundle.pem yourself:"
  for f in $profiles; do note "  $f"; done
fi

step "Your organisation"
note "This Mac stays listed in your organisation until an administrator revokes it in the Guard web dashboard."
[[ -n $device ]] && note "Device: $device"

print -r -- ""
if (( dry )); then
  print -r -- "Dry run finished. Nothing was changed."
  exit 0
fi
if (( leftover )); then
  print -r -- "The network extension is still active, so Vibtra Guard was not fully removed. Reinstall the app and choose"
  print -r -- "Remove Guard… from its menu-bar panel, or run this script again from the reinstalled app."
  exit 1
fi
if (( reboot )); then
  print -r -- "Restart this Mac to finish removing the network extension."
fi
if (( failures )); then
  print -r -- "Vibtra Guard was removed, except $failures step(s) above that did not complete."
  exit 1
fi
print -r -- "Vibtra Guard was removed."
