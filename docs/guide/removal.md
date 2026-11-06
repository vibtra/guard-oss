# Remove Guard

This removes Guard from one Mac. It removes only what Guard put there. Other certificates, keychains, network
settings, VPNs, filters and apps are left alone. The full runbook is `docs/removal.md`.

> Status: both ways to remove Guard, including the macOS prompts and the restart, have been run on a test Mac with a
> development build. Removal of the signed release has not been run yet.

## Run it

- **From the app:** open the menu-bar panel and choose **Remove Guard…**.
- **From Terminal**, for example when the app will not open. Run it as the person who uses Guard, not with `sudo`:

  ```sh
  zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh --dry-run   # shows every step, changes nothing
  zsh /Applications/VibtraGuard.app/Contents/Resources/uninstall-guard.sh             # asks once, then removes
  ```

  Add `--app PATH` if the app is not in `/Applications`, and `--yes` to skip the question.

## What it removes

The names below are those of Vibtra's build. A build your organisation signed under its own team uses its own team
and bundle IDs instead, and the script reads them from the app it ships in ([self-signing.md](self-signing.md#remove-guard-from-a-mac)).

1. Stops the app and the agent.
2. Removes any `~/Library/LaunchAgents/app.vibtra.guard*.plist`. This release installs none.
3. Removes the trust setting and the certificate Guard made on this Mac, named `Vibtra Guard local CA (<host name>)`
   (or `Vibtra Guard CA (<host name>)` on Macs enrolled by an earlier agent), organisation `Vibtra Guard`, from the
   login keychain. It also does this for earlier certificates kept in Guard's folder as `ca-stale-*.pem`. No other
   certificate is touched.
4. **Remove Guard…** in the app also deletes the certificate's key from the Secure Enclave. The script cannot, so after
   removing from Terminal only, the key stays. Only a Guard app signed by the same team can use it. To delete it,
   reinstall Guard and choose **Remove Guard…**.
5. Removes Guard's network configurations and asks macOS to remove the extension, then moves the app to the Trash.
   If the extension is still active afterwards, it says so and does not report Guard as removed.
6. Deletes Guard's files: `~/Library/Application Support/Vibtra Guard`, `~/Library/Logs/Vibtra Guard`,
   `~/Library/Group Containers/P2UU927A6W.app.vibtra.guard`, and the `app.vibtra.guard` caches, HTTP storage, saved
   window state and preferences. The folder holds no private key, except `ca.key` on a Mac upgraded from a Guard release
   before the Secure Enclave, and that is deleted with it.
7. Does not edit shell profiles. If you added the command-line trust lines, it lists the files. Remove the lines that
   mention `guard-ca.pem` or `guard-ca-bundle.pem` yourself.
8. Prints the device ID. Removing Guard does not revoke the Mac. An administrator revokes it on the dashboard's
   **Devices** page (**Revoke…**).

## What macOS asks

- To approve removing the network extension, with your password.
- For your login password, to change certificate trust. If you cancel, the certificate is still deleted.
- From Terminal only: to let Terminal control Finder, so it can move the app to the Trash. If you decline, drag
  `VibtraGuard.app` to the Trash yourself.
- To restart. The app or script prints "Restart this Mac to finish removing the network extension." when macOS needs
  one.

If a Guard entry still shows in System Settings, Network, Filters after the restart, remove it there.

## Check it worked

After the restart:

```sh
systemextensionsctl list | grep app.vibtra.guard              # no output
security find-certificate -a -c "Vibtra Guard" ~/Library/Keychains/login.keychain-db   # not found
ls ~/Library/Application\ Support/Vibtra\ Guard                # No such file or directory
ls ~/Library/Preferences/app.vibtra.guard.plist              # No such file or directory
pgrep -x vibtra-guard                                         # no output
```

If `app.vibtra.guard.plist` is still there after removing from the app, run `defaults delete app.vibtra.guard`. It
holds no enrolment or policy. Then open an AI service in the browser. It loads without Guard.

## Managed Macs

If your organisation installed Guard or its certificate with device management (MDM), remove it there. The script
cannot remove an MDM configuration profile and does not try.
