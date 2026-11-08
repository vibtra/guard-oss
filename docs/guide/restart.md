# Restart and recovery

## The Mac

- **The app does not start itself at login** in this release. After you restart the Mac, open Vibtra Guard from
  Applications. Until it runs, the agent is not checking anything.
- The network extension stays installed across restarts. When the agent is not answering, the extension lets AI
  traffic go straight to the service (it fails open). An AI site never hangs because of Guard, and it is not
  checked either.
- Enrolment, the certificate and the last verified rules are kept in `~/Library/Application Support/Vibtra Guard`.
  The agent starts with them even when the server cannot be reached, and keeps the last verified rules if a download
  fails.

## The agent

**Stop Guard…** and **Start Guard** in the panel restart it. The app also restarts the agent if it exits, waiting
1 second at first and up to 60 seconds between attempts. Quit keeps the app running, so this goes on. If the app
itself exits, for example after a crash, the agent keeps running but nothing restarts it, and new sites are not
checked, until the app opens again.
While it is down, traffic fails open as above.

The extension checks the agent every 2 seconds. Two missed answers mark it down. One answer marks it up again, and
new connections go through Guard again. Connections that were already open are not moved.

## The self-hosted server

```sh
dc restart                 # or: dc down, then dc up -d --wait
```

All state stays in the two named volumes: organisations, rules, devices, events and the signing keys. Enrolled Macs
keep their tokens and the signing key they pinned. `dc down -v` deletes the volumes and everything in them.

While the server is down, Macs keep enforcing their last verified rules and keep events to upload later.

Backup and restore: see `docs/self-host.md`. A database backup is useless without its matching
`secrets.env`.

## Vibtra Cloud

Vibtra runs and restarts the server. While it cannot be reached, Macs keep enforcing their last verified rules and
keep events to upload later, as above. Vibtra Cloud is early access and has no published uptime commitment.
