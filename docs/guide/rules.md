# Set rules

Rules live in the web dashboard at `<server>/<organisation>/guard`. Only administrators can open it. Each save
signs the rules for each Mac. Macs pick them up at their next check-in, about a minute later.

## 1. Choose Monitor or Enforce

A new organisation starts in **Monitor**, unless the server sets `GUARD_QUICK_START=1` for a trial
([self-host.md](self-host.md)). Guard records what the rules would block without enforcing those rules. Connections Guard cannot inspect are still blocked unless you allow them under **Uninspectable TLS** in **Settings**. Enforce mode always blocks uninspectable connections.

Open **Settings** (the gear in the top bar), then **Protection**, and choose **Enforce** when you are ready to block.
The dashboard asks you to give staff the notice first. The shipped notice template is under **Settings**,
**Staff notice**.

## 2. Service rules

Open **Rules**, then the **Services** tab.

- **Any other AI service** sets the default for every AI service that no rule names: **Allow** (let it through and
  record it), **Ask IT** (hold it until IT says yes) or **Block** (people can ask for access if requests are on).
  The default is Allow.
- **Add rule** sets a status for one service: Block, Ask IT, Allow or Off. Add exceptions for groups or named people.
- **Why (shown on the block page)** is optional text people see when they are blocked.

## 3. App and website switches

Under the service rules, **Apps and websites** has four switches. Each blocks one chat client for everyone:

- **Block the Claude website**: claude.ai in Google Chrome.
- **Block the Claude macOS app**: chat in the Claude app for Mac.
- **Block the ChatGPT website**: chatgpt.com in Google Chrome.
- **Block the ChatGPT macOS app (ChatGPT and Codex)**: both modes share one connection, so they are blocked together.

A switch stops only the send action Guard has tested for that client. Other browsers, uploads, voice and connectors
are not covered. A person cannot ask for an exception to a switch. See [coverage.md](coverage.md) for the exact
versions and actions.

## 4. Content rules

Open the **Content** tab. Choose **Add rule**, or **Starters** to add the shipped starter rules.

- **Detects**: what to look for. **Keywords** (one per line, optionally whole words only, optionally only near a
  context word), **File types** (by extension), or a built-in detector: **Payment card number**, **API key or
  secret**, **Tax file number**, **ABN**, **ACN**, **Medicare number**, **Personal identifiers**, **Bulk email addresses** or **Bulk
  phone numbers**.
- **Services**: every AI service, or the ones you pick.
- Who it applies to: everyone, groups, or named people.
- **When it matches**: **Block**, **Ask IT** or **Record only**.
- **Why (shown on the block page)**: optional.

**Personal identifiers** covers about 275 national ID, tax, passport, licence, bank and health number types. It works from the number's shape, its check digits and a nearby label. A number with no label and no check digit usually can't be told apart from an order or ticket number, so it may not be caught. On our synthetic benchmark it caught 93.90% of labelled identifiers and 36.25% of unlabelled ones. It wrongly flagged 3.15% of messages without one, and 20.86% of messages that name an ID type beside an ordinary number. Test it on your own traffic in Monitor before you enforce it.

Content is checked on the Mac, in memory. Request bodies are not stored and not sent to the server. Detectors are
regular expressions, checksums and lists. No model decides. Whether content rules have been checked live on each
chat client's send action is listed in [coverage.md](coverage.md).

## 5. Try a rule before it reaches anyone

Each rule sheet ends with a "would this be blocked?" box. Pick a service or type a host, optionally a person, and
type what they would send or the file names they would attach. It runs the saved rules and answers **Allowed**,
**Blocked**, **Asked** or **Not an AI service**.

## Requests

If **Settings**, **Request access** is on, the block page offers a request form for service and content blocks. The
request appears under **Requests**, where an administrator approves or declines it. App and website switches and
inspection failures never offer a request.

Next: [check it works](check.md).
