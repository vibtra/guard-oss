# 0005 — The network extension is the only way into Guard on a Mac

- **Status:** Accepted, 22 November 2026.
- **Decided by:** Tyler Stewart

## Decision

On a Mac, AI traffic reaches Guard only through the network extension. Guard never asks anyone to set `HTTPS_PROXY`, `HTTP_PROXY` or any other proxy setting, and no Claude Code, Codex or other process on a Vibtra user's Mac is pointed at Guard by an environment variable.

The Mac app's **Copy proxy exports** button and its "Manual browser or terminal setup" section are removed. The user guide, `SECURITY.md` and the READMEs no longer describe a proxy path.

The agent's explicit proxy listener (`--proxy`, default `127.0.0.1:9470`) stays, for tests and development only. It is not a supported way in for users.

## Why

- **A proxy setting is a point of failure.** A terminal with `HTTPS_PROXY` set sends its traffic to Guard's proxy itself. If Guard is stopped, restarting or off, that terminal's AI tools fail with "connection refused", or wait up to about 90 seconds for a new certificate to be trusted. The extension sends a connection the agent does not answer within 3 seconds straight to the service.
- **It asks a non-technical person to decide something.** They had to find a button, understand shell profiles and paste lines. Guard should protect the Mac without the employee configuring anything.
- **Two paths meant two behaviours.** The coverage guide described different blocking, certificate-wait and failure behaviour for proxy users and for the extension. One path means one behaviour to explain and test.
- **It keeps "Off" safe.** A planned per-person mode (Off, Monitor or Enforce, decision 0006) defines Off as "the extension steers nothing and the agent does not start interception". That is only safe if no process is hard-wired to Guard's proxy. Decision 0006 depends on this one.

## Why the explicit listener stays

The extension does not use it. The agent handles steered connections on its transparent listener, in process. But tests and development do use it:

- `tests/support/agent.ts` opens CONNECT tunnels through it, and the `tests/integration/agent-go/` suites use that.
- `tests/e2e/agent-go/capture-matrix.test.ts` sends each client through it.
- The Mac integration tests (`guard/mac/VibtraGuardIntegrationTests/`) start the agent with `--proxy` and drive `curl` through it.
- On Linux and in CI there is no network extension, so the listener is the only way to exercise the agent.

Removing it would remove those tests. We keep it and stop telling users about it.

## Consequences

- An unsigned build, or a Mac where the extension is not on, intercepts nothing. Its traffic goes through unchecked.
- `tests/integration/scripts/extension-only-copy.test.ts` fails if the Mac app or the user docs mention a proxy environment variable or `127.0.0.1:9470` again.
- There are no customers yet, so nobody needs to be migrated.

## Problems that remain

- **Command-line certificate trust.** Tools that ignore the Keychain (Node, Python, curl, git) still need `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE` and similar lines in the shell profile, from **Trust for command-line tools…**. It is the same kind of manual step this decision removes for routing, and the next one to solve.
- **The listener is still bound on users' Macs.** The app starts the agent with the default `127.0.0.1:9470` listener, so a person could still point a tool at it by hand. Guard does not offer or support this. Decision 0006 should decide whether the Mac app stops opening it.
- **Per-person modes** (Off, Monitor, Enforce) are decision 0006.
- **Start at login.** The app does not start itself at login, so traffic is unchecked after a restart until Vibtra Guard is opened.
