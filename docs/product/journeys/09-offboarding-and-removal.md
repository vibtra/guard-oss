# Journey 9: Remove Guard and offboard a person

- **Personas:** [IT admin](../personas.md#it-admin) (offboards people, revokes Macs),
  [Employee](../personas.md#employee) (removes Guard from their Mac).
- **Triggers:** a person leaves; a Mac is replaced, sold or wiped; the organisation stops using Guard; a person
  needs Guard off their Mac.
- **How-to:** [guide/removal.md](../../guide/removal.md) and the runbook [docs/removal.md](../../removal.md).

There are three separate actions. None of them does the others.

| Action | Where | What it changes |
|---|---|---|
| Remove from organisation | Dashboard, **People** | The person's membership and their tokens. |
| Revoke a Mac | Dashboard, **Devices** | That Mac's enrolment. |
| Remove Guard | The Mac, panel or script | The app, extension, certificate and files on that Mac. |

## Happy path: a person leaves

1. **Revoke their Macs.** **Devices**, filter by the person, row menu **Revoke…**. "Revoke laptop": "Its next
   check-in is refused and it gets no new rules…". Records `guard.device.revoked`.
2. **On the Mac, at the next check-in,** the agent drops its rules, stops checking traffic and never calls the server
   again. The panel shows "This device's access was revoked". Queued events are lost.
3. **Remove them from the organisation.** **People**, row menu, **Remove from organisation**. "They lose access at
   their next request. … What they did stays in the activity history." The system removes the membership and revokes
   the tokens they hold. The last owner cannot be removed.
4. **Remove Guard from the Mac** when IT gets it back (below), or wipe it.

## Happy path: remove Guard from one Mac

1. **Remove Guard…** in the panel, and confirm. Or, when the app will not open, run
   `uninstall-guard.sh` as the person ([removal.md](../../guide/removal.md#run-it)).
2. The app stops the agent, removes the network extension, deletes the certificate's Secure Enclave key and the
   pinned signing key, removes Guard's certificate and trust, deletes Guard's files and moves the app to the Trash.
   macOS asks for the password to remove the extension and to change certificate trust, and may ask to restart.
3. The app shows "Vibtra Guard was removed" (or "…was partly removed"), ending "Ask your administrator to revoke
   this Mac in the Guard web dashboard."
4. **Nothing is sent to the server.** The admin revokes the Mac on **Devices**. Until then it shows **Late**, then
   **Quiet**.

## Branches

- **Removed from the terminal only.** The Secure Enclave key stays. Reinstall and use **Remove Guard…** to delete it.
- **Shell profile lines.** The script lists files with the command-line trust lines; the person removes them.
- **Installed through MDM.** The profile and any MDM-delivered certificate are removed in the MDM tool. The script
  does not try.
- **The extension stays active.** The script says so and does not report Guard as removed. A restart, then System
  Settings, Network, Filters.
- **The organisation stops using Guard.** There is no "close organisation" in the dashboard
  ([journey 1](01-org-setup.md#gaps-and-open-questions)). A closed organisation's Macs are refused at check-in like
  revoked ones.
- **Re-enrol the same Mac** (new owner, repair). Revoke, then a new enrol link. The new enrolment is a new device row.

## Gaps and open questions

- **Removing a person does not revoke their Macs.** Device check-in checks the device and the organisation, not the
  person's membership (`apps/registry/src/guard/service.ts:287`). The Mac keeps syncing, enforcing, sending events
  and raising requests in the removed person's name. The confirmation "They lose access at their next request"
  (`apps/guard-console/src/pages/People.tsx:475`) is true for the dashboard, not for the Mac. Decide: revoke
  automatically, or warn and offer it in the same dialog.
- **Removal is silent.** The Mac does not tell the server it was removed, so the admin cannot tell a removed Mac
  from one that is switched off ([journey 8](08-device-late-or-tampered.md)). A best-effort "removed" call before
  the files go would help.
- **Removal does not need IT.** On an unmanaged Mac, any person with their Mac password can remove Guard. On a
  managed Mac, the MDM profile makes removing the extension need an administrator password, unless it was made with
  `--allow-removal`. The dashboard has no setting for this. Decide whether Enforce should make removal harder.
- **Revoked devices never leave the list.** There is no delete or archive for old device rows.
- **Developer path shown to people.** A missing uninstall script shows "See docs/removal.md", a repository path
  (`guard/mac/VibtraGuard/AppModel.swift`).
- **No offboarding view.** Nothing lists "people removed with Macs still active" or "Macs whose person left".
