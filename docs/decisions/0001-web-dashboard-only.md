# 0001 — Management lives in the web dashboard; the native macOS dashboard is deprecated

- **Status:** Accepted, 24 October 2026
- **Decided by:** Sam Rahmani (founder), in the Claude Code session for VIB-20
- **Tickets:** [VIB-20](https://linear.app/vibtra/issue/VIB-20), parent [VIB-18](https://linear.app/vibtra/issue/VIB-18)

## Decision

Guard's management UI is the web dashboard (`apps/guard-console`, served at `/<org>/guard`) and nothing else. The native macOS dashboard in `guard/mac` (the Overview, Activity and Rules windows in `GuardDesktop.swift`, `DesktopWindow.swift` and their window plumbing) is **deprecated**:

- It is not shown at launch, on reopen, or from the menu bar from the first public release.
- No new features go into it, and it is not part of the release's acceptance or documentation.
- Its code stays in the tree for now; removing it is a later cleanup, not part of the release.

The Mac app keeps only what must run on the Mac:

- the background agent and the Network Extension;
- minimal setup: enrol, trust the certificate, approve the extension;
- protection status;
- an **Open web dashboard** action;
- removal (uninstall).

When someone is blocked, they see the existing browser-readable block page, or a short notification that links to it.

## Why

The founder's words: "the web dashboard does everything we need".

Two dashboards meant two implementations of the same views and two sets of acceptance tests. The native one also needed its own design pass, while the web console already has the full rebuild (VIB-15). Admins manage a fleet from a browser anyway, while the people on the protected Macs need only status and a way to understand a block.

## If a desktop app is needed later

Wrap the web dashboard instead of rebuilding it natively. Two options: an Electron shell, or a native window around a `WKWebView` that loads the same dashboard URL. Either reuses the web console as is, so the deprecation costs nothing if a desktop surface comes back.

## Consequences

- VIB-20's acceptance includes "no native management dashboard opens at launch or reopen; web management reachable; minimal local setup remains accessible".
- The VIB-23 docs describe the minimal Mac controls and the web dashboard only.
- Tests that drove the native dashboard windows are kept or retired with the code they cover. Tests for the agent, the extension and setup stay.
