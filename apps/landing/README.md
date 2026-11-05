# `@vibtra/landing` — the page at `vibtra.app`: Guard by Vibtra

The public page for **Guard by Vibtra** (Linear VIB-10, 22 October 2026): a Mac
agent and a slim admin console that show which AI tools people use, block what
must not be sent, and tell people why. Three plain HTML documents (`index.html`,
`privacy.html`, `terms.html`), a few stylesheets and ES modules, no framework. Built by Vite with `base: "/landing/"` and served by
**`apps/registry`** at the apex: `GET /` hands back `dist/index.html`, and
`GET /landing/*` serves everything beside it.

**Layout.** Measured at 1920, 1440, 1280, 768 and 390 with Playwright and system
Chrome in every state (the nav at rest and scrolled, the Product dropdown, the
phone menu, bento clicks, the sticky tab bar, FAQ open). Earlier layouts are in
git history.

**Copy and claims are ours.** Every product claim rests on a file in this
repository: `docs/guide/coverage.md` and `guard/agent-go/surface-coverage.json`
(what is covered and verified), `packages/guard-contract` (rules, events, the
80-character snippet limit, monitor by default), the console's own pages, and
`docs/landing-evidence/` (the two speed figures). The section "What the page may
say" lists the closed-pilot rules (25 October 2026).

---

## Files

| File | What it holds |
|---|---|
| `index.html` | The home page: sections 3–15 of the spec, each with a comment naming the section. |
| `privacy.html`, `terms.html` | The two short notices at `/privacy` and `/terms`, marked as interim, with the contact address. `/pricing` was removed on 25 October 2026 (closed pilots): the registry answers it with a 302 to `/#faq-pilot` (the How does a pilot work? row). |
| `scripts/chrome.mjs` | Owns the shared header (skip link, nav, Product dropdown with its previews, phone panel) and footer, and writes them between `<!-- chrome:header -->` / `<!-- chrome:footer -->` markers in all three documents. `--check` exits 1 when a file is stale. |
| `src/styles/globals.css` | Tokens: the console's (`packages/ui/src/theme.css`, restated under the same names, light and dark), the page neutrals (`--n-*`), the fixed dark-section inks (`--night`, `--day`, `--deep`, `--line-on-night*`, `--accent-on-night`), the console's status tones, motion curves, faces. |
| `src/styles/guard.css` | The fluid root, the shared chrome and every home section, plus the drawn console views. |
| `src/styles/legal.css` | The notices' reading type. |
| `src/app.js` | Behaviour (see below). Every block is guarded on its markup, so the other two documents load the same bundle. |
| `src/hero-demo/` | The hero: a demo-video player in the hero frame (`demo.js`, `demo.css`) cycling four clips of Guard blocking the covered surfaces; the trust row's surfaces select the clip. `media/` holds three cuts per clip (wide 1140x493 @2x from 992 px, 16:10 1280x800 @2x for tablets, square 720x720 @2x for phones); `_build/render.mjs` re-renders them from `_build/compose.js` + `_build/apps/` (`PORT=<vite port>`, `WIDE=1` / `MOBILE=1`), with no capture input. |
| `src/mac-ui/` | Guard's own macOS windows (Blocked, the Guard window's Overview, the menu-bar panel), ported from `guard/mac/VibtraGuard/*.swift`; scoped under `.mui`. `preview.html` is a dev-only preview. No browser or chat-app windows, on purpose. |
| `src/marks/`, `src/mark-ui.js` | Vendor marks (byte-for-byte files, licences in `SOURCES.md` and `licenses/`) and the helper that drops them beside product names (nominative use only). |
| `public/renders/` | 6 WebP screenshots of the current Guard console, demo seed Fernwood; `RENDERS.md` says how they were made. |
| `scripts/og-card.mjs` | Renders the link-preview cards at 2x from `scripts/og/` (the console's Overview and the Guard block window): `public/og.png` 1200x630 for `og:image` (LinkedIn, Slack, iMessage) and `public/og-x.png` 1200x600 for X's 2:1 `summary_large_image`. |
| `scripts/verify-landing.mjs` | `verify:landing`, the page's contract against `dist` (including: every trust chip inside its slot at ≥ 768, no em dash in copy or title). |
| `scripts/preview.sh` | A Vercel preview of `dist` for review (production is the registry). |

## Design system

- **Units.** Everything is in rem on a fluid root
  (spec 1.2: 15 px from 1440 up, 14 px at 1280, the sawtooth below: 16 → 12 at
  480, → 10.67 at 768 and at 992). The container is `min(100% − 12vw, 80rem)`;
  full-bleed panels keep a 1.5rem inset; sections are separated by spacer blocks
  (7.5 / 5 / 3.75 / 4 / 1 rem).
  12 PX FLOOR (founder, 25 Oct 2026: "floor it at 12px"): the root never drops below 12 px, and every
  text size under 1rem is `max(12px, …rem)`, so no visible text is under 12 px at any width (including the
  footer legal line on desktop). `verify-landing.mjs` R checks it at every width.
- **Phones (≤ 479).** Overrides at 390: spacers 85 / 57 / 43 px (6.2 / 4.15 / 3.1 rem), the stats band,
  statement card and final CTA full-bleed and square with the statement abutting
  the CTA, a 324 × 182 bento diagram with 18.9 px titles, and six type roles
  stepped down (numerals, card h3, eyebrows, chips, card bodies).
- **Faces.** **Inter Variable** 400/500/600; the hero h1 and stat
  numerals ship **Merriweather Variable** at 300 (`@fontsource-variable/merriweather`,
  self-hosted); test values and CLI lines are **Geist Mono**. No font CDN.
  Satoshi and Gambetta (the previous faces) are the founder's alternatives.
- **Colours.** Only the role → token map in spec 1.9, with one founder change
  (22 October 2026): **the accent is Vibtra's black** (`--primary`), not green.
  Buttons, links, focus rings, chips, glows and the selected bento tile are ink
  or neutral; the only hues left are the vendor marks' own and the status tones
  inside Guard's own windows and console renders. `verify:landing` fails on any
  retired green. The stats band, final CTA, FAQ and footer
  are dark in both themes (`--night` / `--day`); the statement card is `--deep`.
- **Wordmark.** The Vibtra mark plus "Guard" / "by Vibtra" set in Inter, in a
  112.5 × 37.4 lockup box.

## States and motion (spec sections 3–15)

- **Nav**: sticky, white, a hairline, **one state** at every scroll position (no
  scroll handler). Links hover to the accent ink on a `--muted` pill
  (0.3s `cubic-bezier(.165,.84,.44,1)`). Product opens on hover (click and Enter
  for touch and keyboard), rises 1.3rem and fades in 0.3s; a hovered row swaps
  its preview; Escape and an outside click close it. Below 992 the burger
  morphs to a cross, the panel slides down in 400 ms over a 60% scrim (250 ms in,
  100 ms out), the body locks, Product is an accordion.
- **Hero demo** (`src/hero-demo/`, promoted from hero lab direction A on 23 Oct 2026): four clips (Claude website, ChatGPT website, Claude for Mac, ChatGPT for Mac + Codex), each app a 1:1 HTML/CSS recreation (`_build/apps/claude-web.*`, `chatgpt-web.*`, `claude-mac.*`, and Codex in `compose.js`) fitted against real recordings from the test VM and real Mac screenshots; no recorded frame ships, so the clips are crisp at any zoom, editable, and carry no account data. Guard's window, the pointer and the camera are drawn on top. Every app shows a dummy user (Alex Morgan, AM; Team on Claude, Business on ChatGPT) and dummy work-topic history; the two decision ids are fixed fakes. The stand-in fonts are open (OFL, in `_build/apps/fonts/` with their licences) or the system's own (chatgpt.com and macOS chrome). Each shows a prompt, Guard's Blocked window, the app's own error and a retry that is blocked again. Auto-advances, paused off screen, posters plus a Play button under reduced motion; the trust row's covered surfaces are the selector.
- **Bento**: native radios (keyboard works without script); the checked card turns
  white over 0.3s, its icon tile fills with the accent, and the centre swaps to
  that card's Guard window (`src/mac-ui`). At 390 the cards become accordion
  rows under the window.
- **Feature tabs**: sticky at 5rem (7rem at 768–991), scroll-spy `aria-current`:
  the first item lights once the section top reaches the viewport top (before
  the bar sticks), none current once the stack is passed,
  hidden below 480.
- **FAQ**: native `<details>`, the question turns the accent, the plus rotates into
  a cross, the height animates where `::details-content` is supported.
- **Trust row**: below 768 the chips wrap and centre (the marquee was removed on
  25 October 2026: it moved for ever with no pause control, WCAG 2.2.2).
- **Hero demo pause**: with motion allowed, a Pause button sits on the player;
  under reduced motion the posters and the Play button stand in.
- **Reveals**: headings, the stats, the bento tray, feature cards and the CTA fade
  up 12px with a 4px blur over 300 ms (stagger 100 ms) the first time they enter
  the viewport; only with `prefers-reduced-motion: no-preference`, and never
  hiding content when script does not run.

## Renders

The feature cards and the nav previews hold real screenshots of the Guard
console (`public/renders/`, demo seed "Fernwood", light theme, see `RENDERS.md`).
Guard's Mac windows are HTML ports of the Swift views (`src/mac-ui/`); the
test-VM screenshots they were checked against are not published. The section
"On the Mac" is parked in a `<template>` in `index.html` (not rendered); it still
draws an HTML Setup window and terminal to swap for `src/mac-ui` before it returns.

## What the page may say

**Closed pilots (GTM week, 25 October to 1 November 2026).** Everything is
"enquire": the calls to action are **Request a pilot** and **Book a demo**, both
emails to sam@vibtra.app. The offer line matches the VIB-27 one-pager: 30 days
free, then continue on an agreed order form, no automatic billing, otherwise
Guard is removed. The site carries **no price or plan, no self-serve sign-up
promise, no open-source, self-host or licence claim (the licence is VIB-12's), no
Windows or unverified surface, no customer, testimonial or certification**.

**Editions (decision 0002, VIB-38).** One FAQ row, `#faq-editions`, says Guard
launches with a free Community Edition covering the four verified surfaces, kept
current with same-day fixes and no limit on Macs, people or usage, and that new
apps and sites, enterprise features (SCIM today), hosting and support are paid.
It names no price and makes no licence, open-source or self-host claim; the G
check in `scripts/verify-landing.mjs` still applies, and check E fails when the row loses one of those
points.

Every figure is Guard's own and has its evidence in the repository: the two
speed figures in `docs/landing-evidence/2026-10-23-guard-speed/`, and the four
verified switches in `docs/guide/coverage.md`. The "100% of 43,000 synthetic
samples" figure was removed on 25 October 2026: its eval harness and results are
not in this repository. Coverage is worded as `docs/guide/coverage.md` words it
(switches verified live; content rules checked separately and confirmed on a
pilot's own workflows). No browser or chat-app interface is recreated anywhere.
The footer pills are "Platform: macOS" and "Policy: signed ES256", with "Nothing
on this page is a security certification".

The footer's notices line carries the trademark position: vendor names identify
the apps and sites Guard recognises, remain their owners' trademarks and imply no
endorsement or affiliation. Marks appear only beside the name of the product
they identify (`src/marks/SOURCES.md`).

No analytics, on purpose (land-1): `src/main.js` carries the note.

**Launch links (VIB-23, for 4 November 2026).** The page still follows the
closed-pilot rules above, and check G still enforces them. On launch day, once
the public repository exists and the copy is approved, the page gets these
entry points, and check G is changed in the same pull request:

| Where | Text | Target |
|---|---|---|
| Nav and hero, beside **Request a pilot** | Self-host Guard | the public repository's `docs/guide/README.md` (its URL is the guide's source-code placeholder) |
| `#faq-editions` | Install guide | the same page |
| `#faq-pilot` | Vibtra Cloud is early access and assisted; email to start | sam@vibtra.app (exists) |
| Footer | Sign in | `/login` (exists) |

Until then the page links only to things that exist today: `/login`,
`/privacy`, `/terms` and sam@vibtra.app. The install guide's download table
(`docs/guide/README.md#download`) holds the one placeholder for each missing
link.

---

## Run it

```bash
pnpm --filter @vibtra/landing dev              # http://localhost:3460
pnpm --filter @vibtra/landing build            # → dist/*.html + dist/assets/*
pnpm --filter @vibtra/landing preview
node apps/landing/scripts/chrome.mjs           # rewrite the shared header and footer
pnpm --filter @vibtra/landing verify:landing   # the contract, against dist
pnpm --filter @vibtra/landing og               # re-render public/og.png and public/og-x.png
```

`verify:landing` serves `dist` the way the registry does and checks, at 1920,
1440, 1280, 768 and 390: the chrome is current; title, description, og and
twitter tags name Guard by Vibtra; the section order; the fluid root and
the nav heights; the h1 on two lines (four at 390); no horizontal scroll and
no console error; the nav's single state; the dropdown (hover, preview swap,
Escape) or the phone panel (body lock, accordion, Escape); a bento click; the
sticky scroll-spy tabs (hidden below 480); a FAQ row; no walkthrough, pip or
lightbox; the hero (the bar, the via label, the coverage list with marks, the
reduced-motion still frame, and with motion an allowed send, a switch block and
every detection and window up >= 1.2 s); no browser or chat-app window; the black
accent with no retired green, marks on the trust chips and three linked stat
sources; no price, plan, licence or open-source claim and no em dash in the
copy; no link to `/pricing`; every call to action an email to sam@vibtra.app; and
that `/privacy` and `/terms` render inside the shared chrome. It replaced `verify:hero`, which
asserted the retired page's terminal hero.

Playwright comes from `apps/console`'s dependency; Chrome is the system's.

---

## Where it came from (land-1)

The live `vibtra.app` was a separate Vite site.
`DECISIONS.md` → **land-1** (founder, 14 September 2026) brought it here so that
the marketing page and the product share one host, which path-based tenancy
requires: `vibtra.app/<handle>` is an organisation's console and `vibtra.app/` is
this. `vite.config.js` explains why `base` is `/landing/` and why `assets/` is
load-bearing for the registry's per-file caching (`apps/registry/src/landing.ts`:
the document five minutes, hashed assets a year, `public/` files a day).

## A Vercel preview for review (production is the registry on AWS)

Production is the registry behind CloudFront (`host-31`). `scripts/preview.sh`
builds here and uploads only `dist` as a prebuilt static deployment for the
founder to review; `--prod` is refused before anything is built. `vercel.json`
carries the `/landing/*` → `/*` rewrite Vite's `base` needs, so the
`og:image` (`https://vibtra.app/landing/og.png`) and `twitter:image` (`https://vibtra.app/landing/og-x.png`) are absolute URLs on both.

## `/privacy` and `/terms`

The two short-form notices Google's OAuth consent screen requires on the
authorised domain (20 September 2026). They are Vite multi-page inputs beside
`index.html`, share its entry module (one hashed JS and CSS chunk for the site)
and are served by the registry at `/privacy` and `/terms`. Their text is the
founder's and is unchanged by VIB-10.
