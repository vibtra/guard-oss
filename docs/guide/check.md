# Check it works

A synthetic check: one request allowed, the same request blocked by a test rule, then allowed again after the rule
is turned off. It sends no real prompt and needs no AI account.

> Status: these steps follow the agent's tested behaviour. `pnpm guard:go:e2e` runs enrolment, a block and recovery
> against a test server, and the self-host check runs the real agent on a test Mac through its proxy. The steps on
> this page have not been run on the signed release yet.

Before you start:

- The Mac is enrolled, the certificate is trusted and network protection is on ([mac.md](mac.md)).
- The panel shows a recent **Last sync**. Guard checks in with the server about once a minute; the panel calls
  this Last sync.
- **Settings**, **Protection** is **Enforce**. In Monitor, Guard records the block and lets the request through.

Set two shell variables on the Mac:

```sh
G=/Applications/VibtraGuard.app/Contents/MacOS/vibtra-guard
CA="$HOME/Library/Application Support/Vibtra Guard/ca.pem"
```

## 1. Allow

```sh
"$G" test --host chatgpt.com --text "guardcanary"
```

The JSON shows `"verdict": "allowed"`. This asks the agent's saved rules and sends nothing.

```sh
curl -sS --cacert "$CA" -o /dev/null -D - -X POST -H 'content-type: text/plain' --data 'guardcanary' https://chatgpt.com/ | grep -i x-vibtra-guard
```

The header reads `x-vibtra-guard: allowed`. The request went through Guard and on to the service. The service's own
status code does not matter here.

- No header: the request did not go through Guard. Check that the agent is running and network protection is on.
- `observed` instead of `allowed`: the organisation is in Monitor.
- A certificate error: the agent is not answering, so the request went straight to the service (fail open), or
  the certificate path is wrong.

## 2. Block

In the dashboard, open **Rules**, **Content**, **Add rule**:

- Name: `Guard check`
- Detects: Keywords, `guardcanary`
- Services: Every AI service
- Who: Everyone
- When it matches: Block

Save, then wait for the next check-in (about a minute; the panel's **Last sync** time changes). Run both commands
again:

- `"$G" test ...` shows `"verdict": "blocked"` and `"enforced": true`.
- `curl ...` shows `HTTP/1.1 403` and `x-vibtra-guard: blocked; event=<id>`. Drop the `| grep` to see the JSON body.
  It carries the code `GUARD_CONTENT_BLOCKED` and the next step. The request did not reach the service.

After the Mac uploads its events, the dashboard's **Activity** page shows the block with the rule, the service and
the app. It shows no request content.

## 3. Recover

On the **Content** tab, open the `Guard check` row menu and choose **Turn off**. Wait for the next check-in and run
the commands again. Both show `allowed`. Then delete the rule with **Delete…**.

## Optional: an app or website switch

With a real signed-in ChatGPT account in Google Chrome:

1. Turn on **Block the ChatGPT website** under **Rules**, **Apps and websites**. Wait for a check-in.
2. Send a short test message such as "reply with the single word PONG" on chatgpt.com. ChatGPT shows its own error,
   and Guard posts a notification that opens its block page.
3. Turn the switch off, wait for a check-in and send again. It works.

This sequence was accepted live on a test Mac on 22 October 2026 ([coverage.md](coverage.md)). It has not been run
on a signed release build yet.
