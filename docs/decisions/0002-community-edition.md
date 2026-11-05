# 0002 — Guard Community Edition: the open self-hosted edition and where the paid line sits

- **Status:** Accepted, 28 October 2026. Sam recorded it after the founders discussed it; Tyler confirms on VIB-12.
- **Decided by:** Sam Rahmani and Tyler Stewart (founders)
- **Tickets:** [VIB-12](https://linear.app/vibtra/issue/VIB-12), launch parent [VIB-18](https://linear.app/vibtra/issue/VIB-18)

## Decision

Guard launches as an open **Community Edition** that anyone can self-host. The free edition and the paid offering run the same code. They differ in two places: **which AI surfaces they cover**, and the **enterprise features**.

### Community Edition (free, self-hosted)

- The complete engine:
  - the Go agent and the Mac client with its Network Extension;
  - the web dashboard and the backend;
  - signed policy sync;
  - the block page and removal.
- Coverage of the surfaces Guard covers at launch: **Claude on the web, Claude for macOS, ChatGPT on the web and ChatGPT for macOS**, as listed in `guard/agent-go/surface-coverage.json`.
- **These surfaces are kept fully up to date.** Fixes for vendor changes and new features for these surfaces ship to the Community Edition the same day they ship to paid customers. There is no delay and no reduced feature set.
- One organisation with organisation-wide rules, and email or OIDC sign-in.
- **No caps on devices, seats or usage.** The code is open, so anyone could remove a cap. The edition is shaped by what it covers, not by limits. Sam reconfirmed this on 5 November 2026, and the self-hosted server now enforces no people limit.
- Community support only.

### Paid (Vibtra Cloud, or licensed self-host)

- Everything in the Community Edition.
- **Every new surface**, meaning any AI app, site or client Guard covers beyond the four above. **The Community Edition's surface list does not grow.**
- Covering new surfaces on request.
- The enterprise features in `ee/`. Today that is SCIM provisioning; SAML SSO, group policies and audit export to a SIEM come later. Only features that are built and verified are advertised; anything named in `apps/registry/src/enterprise.ts` but not built is listed as "coming".
- Hosting by Vibtra (Cloud), and support with a response-time commitment.
- Pilots shape the enterprise features. This record does not fix them.

Pricing is not part of this record. Until pricing is set, paid is "contact us".

## Licences

`REUSE.toml` is the source of truth for which path carries which licence. In short:

| Zone | Licence | Change |
|---|---|---|
| Backend, web dashboard and everything not listed below | AGPL-3.0-only | none |
| The Guard client and the shared contract (`guard/**`, `packages/guard-contract/**` and the other Apache-2.0 paths in `REUSE.toml`) | Apache-2.0 | none |
| `ee/**` | Vibtra Enterprise Licence (commercial) | none; stays private at launch, see below |

- **Copyright holders:** until the company is incorporated, the copyright holders are **Sam Rahmani and Tyler Stewart**. The current placeholder "Vibtra" in `REUSE.toml`, `LICENSE` and `ee/LICENSE` is replaced with their names. The rights are assigned to the company when it is incorporated, as part of the founders' IP assignment.
- **Contributions:** made under a contributor licence agreement that grants the copyright holders the right to relicense, so that `ee/` and Vibtra Cloud can stay commercial. The agreement names the founders until the company exists, then the company.
- **SSO:** OIDC sign-in, including per-organisation OIDC SSO, is free. SAML SSO and SCIM are paid. The old comment in `apps/registry/src/auth/sso.ts` that called OIDC SSO paid was removed by the CI stack's comment strip, so the code and this record agree.

## What the first public release contains

The v0 public export leaves out the `pending-vib12` rows in `scripts/public-export.mjs`:
- `ee/` and its tests;
- the Vibtra Enterprise Licence text;
- the billing files.

The root `LICENSE` is the exception: it is rewritten to point to the per-path licences above and becomes public. The public repository is the Community Edition. Enterprise code stays private from launch, can be tailored with pilots, and may be published later under its commercial licence. The core never imports `ee/`, so leaving it out changes no behaviour.

## Why

- **The free edition has to work well enough to show the value.** A small team that wants to block ChatGPT and Claude, apart from approved use, gets the whole product. Surfaces that are not kept current stop working within weeks as vendors change their routes, and a broken free edition hurts the product. So the four surfaces stay current.
- **Coverage is the product.** As with intrusion detection, the engine is free and the detection content is what a business pays for. Precedents:
  - Snort's free community rules, sold alongside Cisco Talos subscriber rules;
  - Suricata's free ET Open ruleset, sold alongside the paid ET Pro, which adds coverage.

  Guard draws the line by breadth: which surfaces are covered. It does not draw it by freshness: how quickly coverage updates.
- **Open core with commercial enterprise features**, as GitLab and Cal.com do. SSO, SCIM and audit export are what a larger organisation buys, and an individual or small team does not need them.

## Options considered

1. **Open core with a coverage line (chosen).** Free: the engine plus four surfaces kept current. Paid: new surfaces, enterprise features and hosting.
2. **Open core with delayed coverage,** the Snort model where registered users get rules 30 days late. Rejected: free users would sit exposed to a vendor change for a month, and that reflects on the product.
3. **Only hosting is paid; all code is open.** Rejected for now: revenue would rest on a hosting margin nobody has measured, and buyers who must self-host would leave no revenue.
4. **Source-available licence for the backend** (BSL or FSL). Rejected: it loses the open-source label with some buyers, and AGPL already requires a competing host to publish its changes.
5. **Device or seat caps on the free edition.** Rejected: open code makes a cap easy to remove.

## Consequences

- Public copy (README, guide, landing) states the Community Edition's surfaces, and says new surfaces are paid.
- New surfaces must be delivered to paying customers without being added to the public coverage list. That needs coverage that does not live only inside the agent binary: a Vibtra-signed coverage manifest delivered with policy sync, with the bundled list as the floor. Under self-signing (VIB-28) this also means coverage updates no longer require every customer to re-sign the Mac client. Follow-up ticket.
- Follow-up tickets carry out the code and licence changes:
  - copyright holders in `REUSE.toml`, `LICENSE` and `ee/LICENSE`;
  - a root `LICENSE` that points to the per-path licences;
  - the contributor licence agreement;
  - README "Licence" and edition copy;
  - the v0 export without `ee/` and billing.
