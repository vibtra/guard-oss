# Removing Vibtra Guard from a Mac

This is the supported way to remove Guard from one Mac. It removes only what Guard put there. Other
certificates, keychains, network settings, VPNs, filters and apps are left alone.

There are two ways to run it. Both use the same script.

- **From the app:** open the Vibtra Guard menu-bar panel and choose **Remove Guard…**.
- **From Terminal**, for example when the app will not open:

  ```sh
  zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh --dry-run   # see every step first
  zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh             # asks once, then removes
  ```

  The script is also in the source tree at `guard/mac/uninstall-guard.sh`. Use `--app PATH` if the app is not in
  `/Applications`. Run it as the person who uses Guard. It refuses to run with `sudo`.

`--dry-run` prints every command it would run, each on a line starting with `+`, and changes nothing. It only reads:
the Guard certificate files, the login keychain's list of certificates whose names start with "Vibtra Guard", the
device ID in Guard's `device.json` and the app's bundle ID in its `Info.plist` (both with `plutil`), and
`systemextensionsctl list`.

## What happens, in order

1. **Guard stops.** The app quits and the agent process (`vibtra-guard`) stops. From the app, the app stops its own
   agent and quits at the end.
2. **Launch agents.** Any `~/Library/LaunchAgents/app.vibtra.guard*.plist` is booted out and deleted. This release
   does not install one, so normally there is nothing to do.
3. **The Guard certificate.** Guard trusts one certificate it made on this Mac, named
   `Vibtra Guard local CA (<host name>)` with organisation `Vibtra Guard`, in the login keychain. A Mac enrolled by
   the earlier Rust agent holds it as `Vibtra Guard CA (<host name>)`, and the script removes that name too. It finds it
   in Guard's data folder (`ca.pem`, and `ca-stale-*.pem` for earlier certificates whose key is gone) and in the login
   keychain, and checks both name and organisation. For each match it removes the trust setting
   (`security remove-trusted-cert`) and deletes that exact certificate by its SHA-1
   (`security delete-certificate -Z <sha1>`). No other certificate is touched.
4. **The certificate's key.** The key is in the Mac's Secure Enclave, in the keychain group
   `P2UU927A6W.app.vibtra.guard.ca`. **Remove Guard…** in the app deletes it before it runs the script. The script
   cannot delete it, so after a Terminal-only removal the key stays. Only a Guard app signed by the same team can use
   it; reinstalling Guard and choosing **Remove Guard…** deletes it.
5. **Routing and the network extension.**
   - From the app: the app stops the transparent proxy, removes Guard's two network configurations (the content filter
     and the transparent proxy, only when they name `app.vibtra.guard.extension`), and asks macOS to remove the
     extension. Then it moves itself to the Trash.
   - From Terminal: the script runs the app with `--remove-extension`, which does the same as above without opening a
     window, then moves the app to the Trash with Finder. Deleting the app alone does not remove its extension: on
     macOS 26.6 the extension stayed active after the app was trashed, the Trash emptied and the Mac restarted.
   - Either way, the script then reads `systemextensionsctl list`. If the extension is still active and not waiting
     for a restart, it says so, exits 1 and does not report Guard as removed.
6. **Local files.** These are deleted: `~/Library/Application Support/Vibtra Guard` (or `$VIBTRA_GUARD_DIR`),
   `~/Library/Logs/Vibtra Guard`, `~/Library/Group Containers/P2UU927A6W.app.vibtra.guard`,
   `~/Library/Caches/app.vibtra.guard`, `~/Library/HTTPStorages/app.vibtra.guard`,
   `~/Library/Saved Application State/app.vibtra.guard.savedState` and the `app.vibtra.guard` preferences.
   The data folder holds the enrolment, the downloaded policy, events not yet uploaded, the Guard certificate (no
   private key), earlier certificates (`ca-stale-*.pem`) and the command-line trust files `guard-ca.pem` and
   `guard-ca-bundle.pem`. On a Mac upgraded from a Guard release before the Secure Enclave, it can also hold that
   release's key file `ca.key`, until `vibtra-guard ca trust` (the app's trust action) or this script deletes it.
7. **Shell profiles are not edited.** If you added the "Trust for command-line tools" lines to `~/.zshrc`,
   `~/.zprofile`, `~/.bashrc`, `~/.bash_profile` or `~/.profile`, the script lists those files. Remove the lines that
   mention `guard-ca.pem` or `guard-ca-bundle.pem` yourself, then open a new terminal.
8. **Your organisation.** Removing Guard does not revoke this Mac. It stays listed in your organisation until an
   administrator revokes it in the Guard web dashboard. The script prints the device ID to give them.

## What macOS asks

- **Remove the extension.** macOS asks you to approve removing the network extension, and may ask for an administrator
  password.
- **Certificate trust.** macOS asks for your login password to change certificate trust settings. If you cancel, the
  certificate is still deleted, and the script says the trust setting was not removed.
- **Finder (Terminal only).** macOS may ask to let Terminal control Finder, so it can move the app to the Trash. If
  you decline, drag `VibtraGuard.app` to the Trash yourself.
- **Restart.** If macOS says the extension will finish uninstalling after a restart, the app or script tells you to
  restart. `systemextensionsctl list` then shows `[terminated waiting to uninstall on reboot]` for
  `app.vibtra.guard.extension` until you do.

If a Guard entry still shows under System Settings, Network, Filters (called VPN & Filters on some macOS versions)
after the restart, select it and remove it there.

## Check it worked

After the restart:

```sh
systemextensionsctl list | grep app.vibtra.guard              # no output
security find-certificate -a -c "Vibtra Guard" ~/Library/Keychains/login.keychain-db   # error: not found
ls ~/Library/Application\ Support/Vibtra\ Guard                # No such file or directory
ls ~/Library/Preferences/app.vibtra.guard.plist              # No such file or directory
pgrep -x vibtra-guard                                         # no output
```

Then open an AI service in the browser. It loads without Guard's certificate or block page.

After **Remove Guard…** in the app, macOS may write `app.vibtra.guard.plist` again as the app quits (for example
the menu-bar icon position). It holds no enrolment or policy. If the check above lists it, delete it with
`defaults delete app.vibtra.guard`. Whether this happens has not been checked on a Mac yet.

## A Mac managed by your organisation

If your administrator installed Guard or its certificate with device management (MDM), remove it there. A
configuration profile from MDM cannot be removed by this script, and the script does not try.

## Status

The script and its dry run are covered by `tests/mac/test_uninstall.py` (CI job `mac-integration`). Those tests run it against a
temporary home folder with stand-ins for `security`, `pkill`, `launchctl`, `osascript`, `defaults` and
`systemextensionsctl`, and check that only Guard-owned items are removed: the script calls no networking, proxy or
configuration-profile tool, and its only keychain actions are `find-certificate`, `remove-trusted-cert` and
`delete-certificate -Z` on the Guard certificate. The app's `--remove-extension` step is a stand-in too.

Both paths were run on a macOS 26.6.2 guest Mac with an Apple Development build. From Terminal and from **Remove
Guard…**, macOS asked for a password to remove the extension, the extension showed
`[terminated waiting to uninstall on reboot]`, and after the restart every check under **Check it worked** passed and
AI services loaded without Guard. Still to be accepted: both paths with the Developer ID release (VIB-20).
