# Troubleshooting

## What a block looks like

Guard refuses a blocked request before it reaches the AI service. What you see depends on the client. Guard does not
redirect every client to its block page, and it does not put an explanation inside a vendor's chat.

| Where the request came from | What you see |
|---|---|
| A page you opened in the browser (a top-level navigation) | Guard's block page in that tab. |
| A chat send on a website (a background request from the page) | The website's own error. Guard posts one notification that opens its block page. |
| A Mac chat app (Claude for Mac, ChatGPT for Mac) | The app's own generic error, for example "This isn't working right now". Guard posts one notification. |
| An API client, SDK or command-line tool | HTTP 403 with a JSON body (`vibtra.policy/v1`) and the header `x-vibtra-guard: blocked; event=<id>`. |
| A WebSocket that was already open | The connection closes with code 1008 and "Vibtra Guard blocked this message". |

Some clients treat every HTTP 403 as a sign-in problem and say so. If an AI app asks you to sign in again or shows a
generic error right after you sent something, check for a Guard notification, or choose **Open block page** in the
panel.

Retries do not cause a storm. Guard posts one notification per burst of retries of the same block, with a 10 second
quiet gap. Every attempt is still recorded.

### The block page

It shows your organisation, the service, the rule (or "Service policy"), how many matches a content rule found, your
administrator's note, and what to do next:

- a content rule: remove or replace the matched data, then send again;
- a service rule with requests turned on: **Request access**;
- an app or website switch, or an inspection failure: ask your administrator. These cannot be overridden per request.

The page never shows the request's address, body or matched text. Its address carries only an event ID.

### Codes in the JSON body

| Code | Meaning |
|---|---|
| `GUARD_CONTENT_BLOCKED` | A content rule matched. Remove the matched data and retry. |
| `GUARD_SERVICE_BLOCKED` | A service rule refused the request. |
| `GUARD_SURFACE_BLOCKED` | An app or website switch is on. Ask your administrator. |
| `GUARD_APPROVAL_REQUIRED` | The rule says Ask IT. Open the block page and request access, if offered. |
| `GUARD_INSPECTION_UNAVAILABLE` | Guard could not check the request safely, so it refused it. Ask your administrator. |

## Common problems

| Problem | Fix |
|---|---|
| A certificate warning on an AI site in the browser | Choose **Trust the Guard certificate** in the panel. |
| Certificate errors from Node, Python, curl or git | Choose **Trust for command-line tools…** and add the lines it shows to your shell profile. Open a new terminal. |
| Nothing is blocked | Check **Settings**, **Protection** is **Enforce**. Check the panel's last check-in, and that the agent is running and network protection is on. Rules apply from the next check-in, about a minute after saving. |
| A switch does not block | Check the client and version against [coverage.md](coverage.md). Switches cover Google Chrome and the listed Mac app versions only, and only the send action. |
| A request that was already streaming kept going | Blocks apply to new requests. A reply already streaming is not cut off. |
| The panel says approval is waiting | Choose **Open Network Extensions settings** and allow Vibtra Guard. |
| No notification appears | Allow notifications for Vibtra Guard in System Settings, Notifications. |
| The enrol link does not work | Each link works once and expires. Ask for a new one. |
| **Open web dashboard** is greyed out | The Mac is not enrolled yet, or the agent is not running. |
| The dashboard says **Admins only** | Only an organisation owner or admin can manage Guard. Ask one of them to make you an admin. |
| The server does not start | See the failure table in [self-host.md](self-host.md#if-it-does-not-start). |

## Logs

- Mac agent: **Open agent log** in the panel, or `~/Library/Logs/Vibtra Guard/agent.log`.
- Agent state: `/Applications/VibtraGuard.app/Contents/MacOS/vibtra-guard status` prints the enrolment, mode and
  last sync as JSON.
- Self-hosted server: `docker compose -f apps/registry/docker-compose.yml --env-file <file> logs guard`.
