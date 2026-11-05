# Guard console renders

Real screenshots of the Guard admin console (`apps/guard-console`, the console from VIB-15), re-captured
25 Oct 2026 (13:28 AEDT) from `main` at b08fbaa, from a live `guard:demo`. These are the console itself, not drawings. The data is synthetic: the
`pnpm guard:demo` seed for the fictional org Fernwood (`fernwood.example`), signed in as Ada (owner). The theme
is light.

## How they were made

1. Seed and serve a demo registry on a spare port (it builds the console first):
   `GUARD_DEMO_PORT_BASE=4970 corepack pnpm@10.11.0 guard:demo --keep` (Node 22). The seed has 6 people,
   3 laptops (1 quiet), a week of events across ChatGPT, Claude, Cursor, Gemini, the Anthropic API and
   DeepSeek, plus 1 open request.
2. Use Playwright with system Chrome (`channel: "chrome"`): `deviceScaleFactor: 2`, `colorScheme: "light"`,
   localStorage `vibtra.console.theme=light`, the session cookie from `/tmp/vibtra-guard-cookie-4970-ada`.
   Pages are captured at `http://127.0.0.1:4970/fernwood/guard/*`. The default viewport is 1440x900; the
   nav and bento renders use a 440 px wide viewport so the console's own narrow layout fits the small frames
   and its text stays legible (a 900 px crop in the 296 px nav pane shrank 14 px text to about 5 px).
3. Encode: `cwebp -q 90 -m 6`. The square crops below were cut with a Playwright `clip` (CSS px, at 2x).

## Files

Only files the site uses are kept (everything in `public/` is copied to `dist` and served at
`/landing/renders/*`). The full frames the crops were cut from are not kept; re-capture them with the steps
above. `console-overview.webp` is 2880x1800 (1440x900 at 2x, from 25 Oct 2026 at 7b296a6, used only by the
OG card script).

| File | Size | Shows | Made from | Used by |
|---|---|---|---|---|
| nav-activity.webp | 880x880 | Activity at narrow width: the All / Blocked / Asked / Allowed filter, search, then Decision (Requested, Observed) and Person | `/activity` at 440x440 | nav preview, See AI use |
| nav-rules-content.webp | 880x880 | Rules, Content tab: Add rule, search, then Tax file numbers and Medicare numbers set to Block, ABNs and ACNs Record only | `/rules?tab=content` at 440x440 | nav preview, Content rules |
| nav-switches.webp | 880x880 | Rules scrolled to Apps and websites: the coverage note, then the Claude website and Claude macOS app switches (off in the demo) | `/rules` at 440x440, scrolled to the heading less 20 px | nav preview, App and website switches |
| nav-block-detail.webp | 880x880 | The block detail sheet: ChatGPT, Blocked, Tax file numbers; Decision tab with Blocked by a content rule, Rule and Matched | `/activity` at 440x440, click the row with "Tax file numbers" | nav preview, Blocks that explain |
| console-activity-narrow.webp | 880x1280 | The same Activity page as nav-activity, taller (eight rows) | `/activity` at 440x640 | bento centre, See AI use |
| console-activity-square.webp | 1800x1800 | Sidebar with Activity selected, and the Decision, Person and App columns | `/activity` at 1440x900, clip 0 0 900 900 | feature card #see |
| console-block-detail-square.webp | 1800x1800 | The detail sheet open on a block ("ChatGPT, Blocked, Tax file numbers"; blocked by a content rule, matched once, redacted example 123***782) with the edge of the list behind it | `/activity` at 1440x900, click the row with "Tax file numbers", clip 540 0 900 900 | feature card #explain |
| console-rules-square.webp | 1800x1800 | Rules scrolled to Apps and websites: the four switches (Claude website, Claude macOS app, ChatGPT website, ChatGPT macOS app with ChatGPT and Codex), all off in the demo | `/rules` at 900x900, scrolled to the heading | feature card #switches |
| console-rules-content-square.webp | 1800x1800 | The Content tab without the sidebar: Status, Rule, Services and Who | `/rules?tab=content` at 1150x900, clip 240 0 900 900 | feature card #rules |

The demo cannot turn an app or website switch on (its laptops do not report switch support), so the switches
renders show them off. The timestamps in the images ("6 min ago", "25 Oct 2026, 13:22") come from the demo's
clock. The nav previews and the bento centre used 1800x1800 crops of the desktop console until 25 Oct 2026
(console-activity-list.webp was removed then); the older console's renders (22 to 23 Oct 2026, including
console-overview-services) were replaced or removed before that.
