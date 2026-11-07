# @vibtra/registry

The Guard server: sign-in (Better Auth), organisations and their people, groups, SSO, sign-up
registration, Guard's laptop sync API (`/api/guard/v1`), the request desk, the web dashboard's
`/api/console` doors, and the landing pages. It runs in hosted mode only. To self-host it, follow
[docs/self-host.md](../../docs/self-host.md).

`src/guard/product-boundary.ts` is the route boundary: every route outside Guard's surface answers
404 `Not part of Guard`.

```sh
corepack pnpm@10.11.0 --filter @vibtra/registry start      # serve (the default command)
corepack pnpm@10.11.0 --filter @vibtra/registry reseal     # re-seal every sealed row under the current vault key
corepack pnpm@10.11.0 --filter @vibtra/registry plan -- …  # change one organisation's plan (operator)
corepack pnpm@10.11.0 --filter @vibtra/registry plan-requests -- list
corepack pnpm@10.11.0 --filter @vibtra/registry rotate-issuer-key
```

## Configuration reference

Every variable the service reads. The server runs in hosted mode only: `src/main.ts` sets `REGISTRY_MODE=hosted` and refuses any other value.

| Variable | Required | Meaning |
|---|---|---|
| `PORT` | both | Listen port. Default `4700`. |
| `HOST` | both | Bind address. Default `127.0.0.1`; docker sets `0.0.0.0`. |
| `DATABASE_URL` | both | Postgres DSN. Present → the Postgres store; plain-SQL migrations from `migrations/` apply on boot (tracked in `registry_migrations`, under an advisory lock; a row naming a file that no longer exists **refuses the boot** — see "Migrations, and the one way they go wrong" below). Absent → file store. Hosted mode without Postgres is a dev/test posture: tenancy lives in `tenancy.json`. |
| `REGISTRY_BASE_URL` | hosted, required | Public URL of this registry. **On Vibtra's own hosted stack that value is `https://vibtra.app` — the APEX — and there is only one of it** (DECISIONS.md host-14): the landing at `/`, sign-in at `/login`, every organisation's console at `/<handle>/…`, the API, the token issuer and the MCP resource all share that origin, because this URL is the `iss` of every tool-gate token and the `resource` an MCP client audiences, so a second spelling of the host would be a second issuer. The defensive alias recorded in `docs/deploy-registry-aws.md` serves a 301 here and is never a legal `iss`, never this variable. **The Google redirect URI is `${REGISTRY_BASE_URL}/api/auth/callback/google`** — allow-list it on the OAuth client (it CHANGED from `/auth/callback` when Better Auth took over sign-in). Also Better Auth's `baseURL` and the one origin allowed to write. An `http://` base marks a dev deployment: it drops the cookie `Secure` flag and additionally trusts the console dev servers **and the other spelling of its own loopback address** (`http://localhost:N` ⇄ `http://127.0.0.1:N`, same port — the same machine, but a different origin to a browser, so without this a registry opened at the other spelling refuses its own console's every POST). |
| `REGISTRY_EXTRA_TRUSTED_ORIGINS` | hosted, optional | **Comma-separated extra origins that may POST**, beside `REGISTRY_BASE_URL`. Each entry is a BARE origin — `scheme://host[:port]`, no path, no query — because Better Auth compares an `Origin` header against it exactly; anything else **refuses to boot** rather than silently matching nothing. Absent is the production posture: a hosted registry trusts exactly one origin. It exists for the demo and dev registries that listen at an address their base URL does not spell — `pnpm e2e:proof`'s keep-alive serves the console on `http://127.0.0.1:<port>` — and it is never a way to trust a whole domain: wildcards (`*`) are refused at boot, even though Better Auth itself would accept them. Note what an entry buys: Better Auth reads its trusted origins **twice** — for the `Origin` header on a state-changing call, and to validate a post-sign-in `callbackURL` — so an entry is also a legal place to land after signing in. List other addresses of **this** registry, never somebody else's host. |
| `REGISTRY_REGISTRATION` | hosted, optional | **Are new sign-ups open?** `open` (the default, and every registry that has not set it) or `allowlist`. Anything else **refuses to boot**, naming both values. Under `allowlist` a first sign-in that would **create an organisation** goes through only for the operator's own domain, for a listed address, or for a listed domain. Everything else is refused before a single row is written, with one sentence naming the contact address when one is set. **What does NOT change under `allowlist`:** everybody already here signs in exactly as before; anybody holding a pending invitation signs in and accepts it; anybody whose domain is already claimed by an organisation joins it under that organisation's own joining rule; and the operator's own people are always let in, so the organisation that runs the registry can still be created after the switch is thrown. The list itself is managed from the operator organisation's **Settings** page, under Sign-ups. The mode is not, deliberately: a browser must never be able to reopen a registry. |
| `REGISTRY_OPERATOR_DOMAIN` | hosted, optional | **Which organisation operates this registry**: a bare mail domain (`vibtra.app`), lower-cased on the way in. A scheme, a path, a port, an `@`, whitespace or a name with no dot **refuses to boot**. The organisation that has claimed this domain is the only one that sees the Sign-ups section: its **admins read** the list and its **owners change** it, and every other organisation is refused at those doors. It is read whether sign-ups are open or closed, so the list can be filled in before the switch is thrown. Unset (the normal self-host posture) and no organisation manages sign-ups from the console at all. |
| `REGISTRY_CONTACT_EMAIL` | hosted, optional | **Where to write when sign-ups are closed**: exactly one address, lower-cased; anything else refuses to boot. It is shown to **anybody**, signed in or not, on the sign-in screen while `REGISTRY_REGISTRATION=allowlist`, and it is repeated in the refusal a person meets if they try to sign up anyway. It is therefore **public, not a credential**: use a mailbox you are happy to publish. Unset, and the refusal simply names no address rather than inventing one. |
| `REGISTRY_OWNER_EMAIL` | hosted, optional | **One owner on a personal mailbox**: exactly one address, lower-cased; anything else refuses to boot. That address may create an organisation on its first sign-in even from a public mail domain (gmail.com and similar), which is otherwise always refused, and it passes `REGISTRY_REGISTRATION=allowlist`. The organisation is named after the part before the `@`, claims **no** mail domain and so admits nobody else automatically; colleagues come in by invitation. Every other personal mailbox is still refused. It exists for a self-hosted server whose operator signs in with a personal Google account (docs/self-host.md). Unset, and nothing changes. |
| `GUARD_MULTI_ORG` | hosted, optional | **One organisation or many.** `1` or empty (the default, and Vibtra Cloud) lets a first sign-in from a domain no organisation claims create one. `0` (the self-hosted Compose default, where an empty value also becomes `0`) allows only the first: once any organisation exists, a sign-in that would create another is refused and nothing is kept. A closed organisation still counts. Joins by domain, SSO and pending invitations are unchanged, and `REGISTRY_REGISTRATION=allowlist` still gates the first one. Anything else refuses to boot. |
| `REGISTRY_SESSION_SECRET` | hosted, required | Better Auth's `secret` (≥32 chars) — it signs the session cookie, and since DECISIONS.md `host-9` **that is all it does**. Rotating it invalidates every live session and leaves the tool gate signing. Sessions are also ROWS now, so a single one can be revoked without touching this. |
| `REGISTRY_GATE_SIGNING_SECRET` | hosted, optional | **The tool gate's signing key at rest** (≥32 chars). It encrypts the private half of every `jwks` row — the ES256 key that signs every deployed tool's ID token — through this registry's own envelope (`src/issuer/jwks-secret.ts`), because better-auth's `jwt` plugin can only encrypt with the auth instance's `secret` and has no per-plugin key. **Unset is a valid posture and not a silent one:** the session secret is used for both jobs, exactly as before the split, and the registry logs ONE line at startup saying so. Rotating it is `docs/deploy-registry-aws.md` §1.5 runbook B, which ends at `rotate-issuer-key`. On AWS it is its own generated Secrets Manager entry; it never belongs in a committed `.env`. |
| `REGISTRY_OIDC_ISSUER` | hosted, optional | **No longer drives sign-in and is never fetched.** Better Auth's Google provider needs no issuer URL. The value survives as the identity-provider LABEL: what the console's session view shows, the `idp` on a `tool.accessed` ledger record, and half of the pair the tool gate's opaque `sub` is derived from. Defaults to `https://accounts.google.com`. A generic OIDC provider (Okta, Entra) is Better Auth's `genericOAuth` plugin, not this variable — see `docs/self-host-registry.md`. |
| `REGISTRY_OIDC_CLIENT_ID` | hosted, required | Google OAuth client id. |
| `REGISTRY_OIDC_CLIENT_SECRET` | hosted, required | Google OAuth client secret. |
| `REGISTRY_TEST_AUTH` | never in production | `1` enables Better Auth's **email+password** door, for this package's test suites and `pnpm e2e:proof`. It is **refused outright under `NODE_ENV=production`**, at boot and again inside `createRegistryAuth`. There is no sign-up form, no password reset and no verification mail anywhere in the product. |
| `NODE_ENV` | hosted | `production` makes two things refusals rather than footguns: hosted mode without `DATABASE_URL`, and `REGISTRY_TEST_AUTH=1`. |
| `REGISTRY_STRIPE_WEBHOOK_SECRET` | hosted | The `whsec_…` Stripe issues for the webhook endpoint `https://<host>/billing/stripe/webhook` — the ONLY thing that makes `POST /billing/stripe/webhook` believe a body (DECISIONS.md `pay-7`, Round 23). Verified with the SDK's own `stripe.webhooks.constructEvent` over the raw bytes. The endpoint subscribes to exactly six events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. **Unset is the normal posture today** and is what every deployment in this repository is in: with none, that route answers 503 naming this variable and no organisation can be moved. It is a credential — never logged, never echoed in a refusal, never sent to a browser. Empty is read as unset. |
| `REGISTRY_MAIL_FROM` | hosted | The VERIFIED sender, e.g. `Vibtra <no-reply@vibtra.app>`. Required whenever `RESEND_API_KEY` is set and never defaulted: Resend refuses a sender it has not verified, so a plausible-looking default would read as configured in a dump and fail at the vendor. Not a credential; it is printed in every message. Empty is read as unset. |
| `REGISTRY_STRIPE_SECRET_KEY` | hosted | The `sk_…` — the ONLY thing that turns self-serve billing on (DECISIONS.md `pay-2`, Round 23). **Unset is the shipped posture** and is where every deployment in this repository stands today: the Billing page says self-serve billing is off, `POST /api/console/billing/checkout` and `POST /api/console/billing/portal` refuse with a sentence, and the invoicing path (the in-console plan-change request, `pay-12`) is all there is. Set, with `REGISTRY_STRIPE_PRICES`, and the registry talks to Stripe through the **official `stripe` Node SDK** (Round 23 superseded the 14 Sep plain-`fetch` choice): an admin's *Start subscription* creates a Checkout Session in subscription mode carrying `metadata[orgId]` on the session and the subscription, and *Manage billing* creates a Customer Portal session for the org's Stripe customer. Both answer a `url` minted per press; neither is stored. **It never reaches a door**: `server.ts` builds closures over it and hands the console only those, the way `vaultKeyConfigured` passes a boolean rather than the vault key. **Test keys only unless `REGISTRY_STRIPE_LIVE=1`**: an `sk_live_…` key without that flag is refused at boot. Requires the price map; half of the pair is refused at boot. It is a credential — never logged, never echoed in a refusal, never sent to a browser. Empty is read as unset. |
| `REGISTRY_STRIPE_PRICES` | hosted | `planId=priceId,planId=priceId` — a bucket in `REGISTRY_PLANS` to a Stripe Price object, e.g. `team=price_1P…,business=price_1Q…`. **M3 (`m3-4`): three more keys carry the metered overage prices** — `session_overage` ($0.50 per started hour of overage minutes), `appbox_awake_overage` ($0.10 per awake hour), `appbox_extra_box` ($10 per box per month) — which `scripts/stripe-setup.mjs` prints; `free` is refused (it has no price). A bucket with no entry is **not** self-serve and the checkout door refuses it, which is how the unmetered bucket stays on invoicing with no special case. The same map is read **backwards** by the webhook: a subscription's price id names the bucket the org's plan follows. Refused at boot if it names a bucket this registry does not have, or the unmetered one (the founder's `pay-2` answer keeps enterprise on invoicing). **No amount is ever read from it**: the Price object carries the amount, Stripe renders it on its own checkout page, and nothing in this repository fetches, stores or prints one — `pay-15` has not landed. Empty is read as unset. |
| `REGISTRY_STRIPE_LIVE` | hosted | `1` allows an `sk_live_…` key in `REGISTRY_STRIPE_SECRET_KEY`. Unset (the normal posture) → only `sk_test_…` keys are accepted and a live key is refused at boot, so test mode cannot become live mode by pasting the wrong key. Not a credential. |
| `VIBTRA_VAULT_KEY_PREVIOUS` | hosted | **Old vault keys, comma-separated** — the read-only half of the key ring. They **open** rows sealed before a rotation and they **seal nothing, ever**. Same forms as `VIBTRA_VAULT_KEY`, one per entry. Empty is the steady state; a non-empty list means a rotation is in progress, and the line the registry prints at boot says how much of it is left. Listing the **current** key here refuses to boot, and so does setting this without `VIBTRA_VAULT_KEY`. See "Rotating the vault key" below. |
| `REGISTRY_ISSUER_KEY` | — | **Gone, and inert if you still carry it.** There is no PEM and no `<dataDir>/issuer-key.json`: the tool-gate signing key is minted by Better Auth's `jwt` plugin into the **`jwks` table** on first use (migration 0008) and its private half is **encrypted at rest under `REGISTRY_GATE_SIGNING_SECRET`** (above), so the database keeps the key across restarts and across tasks and nothing reads this variable. It used to be encrypted under `REGISTRY_SESSION_SECRET`, which made rotating console sessions a tool-gate outage; **FOUNDER_TODO §E is answered** — DECISIONS.md `host-9`, 14 September 2026 — and the two are separate secrets with separate runbooks (`docs/deploy-registry-aws.md` §1.5). Rotating the **signing key itself** is a command — `pnpm --filter @vibtra/registry rotate-issuer-key`, see "Rotating the tool-gate signing key" below. |
| `VIBTRA_REGISTRY_DATA_DIR` | optional | Root for the file store (`tenancy.json`, `guard.json`, `vault.json` and the other store files). Default `apps/registry/data`. Ignored when `DATABASE_URL` is set. The file store is for development and tests. |
| `VIBTRA_VAULT_KEY` | optional | **The vault key**: 64 hex characters (`openssl rand -hex 32`) or base64 of exactly 32 bytes. It seals Guard's rule-signing key and each organisation's SSO client secret. Absent (and no OpenBao) → Guard answers `GUARD_OFF` and registering an SSO provider is refused. Malformed → refuses to boot. Never logged, never echoed in an error. Back it up: losing it makes every sealed row unreadable. |
| `VIBTRA_GUARD_SERVER_URL` | optional | The server URL written into enrolment links, when laptops reach this server at an address other than `REGISTRY_BASE_URL`. |
| `VIBTRA_GUARD_CONSOLE_DIST` | optional | Where the built web dashboard (`apps/guard-console/dist`) is. Default: that directory in this checkout. |
| `VIBTRA_LANDING_DIST` | optional | Where the built landing (`apps/landing/dist`) is. Without a build, `/` serves a plain fallback page and `/privacy` and `/terms` answer 404. |
| `REGISTRY_FREE_CONNECTIONS` | optional | Replaces the default plan's connection number in the session's usage block. Unset → the plan's number (`REGISTRY_PLANS` in `src/config.ts`). |
| `REGISTRY_FREE_BUDGET_HOURS` | optional | The metering service's global free budget (default `2000`). At 90% a new Free organisation is created `waitlisted`. Read by the metering service that billing uses. |
| `RESEND_API_KEY` | optional | The `re_…` Resend issues. It turns mail on: invitations and the Guard request arrival mail. Unset → nothing is sent and the console keeps its copy-the-link path. Requires `REGISTRY_MAIL_FROM`; half of the pair is refused at boot. A credential: never logged or echoed. |
| `VIBTRA_TEST_CLOCK` | never in production | `1` runs the server on a test clock. Refused under `NODE_ENV=production`. |

Hosted mode **fails closed**: missing required variables refuse boot with a
message naming exactly what is absent.

## Migrations, and the one way they go wrong

Plain `.sql` files in [`migrations/`](./migrations), applied **in filename
order on boot** by `migrate()` (`src/store/postgres.ts`) when `DATABASE_URL` is
set, each in its own transaction, all of it under one `pg_advisory_lock` so two
booting replicas cannot race. What has already run is one row per filename in
**`registry_migrations`**. No ORM and no migration framework — minimal-deps law
— which means the bookkeeping is a **filename**, and that is the seam this
section is about.

**Renaming or renumbering a migration that has already run is a production
incident.** It happened here on **13 September 2026**: the index migration was
renumbered from `0020_registry_records_type_index.sql` to
`0024_registry_records_type_index.sql` (today's `0020` is
`0020_connection_last_probe.sql`), the dev registry's `registry_migrations`
still named the file by its old number, so the boot read `0024_…` as *pending*,
ran it a second time, and died on `relation
"registry_records_org_type_seq" already exists`. The dev registry was down
until the 14th, and nothing in that error mentioned the row that was actually
wrong.

**So the migrator now refuses to start instead.** Before a single migration
statement executes, it reads the directory listing and `SELECT name FROM
registry_migrations`, and if the table names a file the directory no longer
has it throws and boots nothing:

```
The migration directory is corrupt, the following files are missing: 0020_registry_records_type_index.sql. Each name is recorded in registry_migrations but is no longer a file in apps/registry/migrations, so this registry will not start and NOTHING has been applied — re-running a renamed migration under its new number is what took the dev registry down on 13 September 2026. Fix the bookkeeping, then boot again:
  0020_registry_records_type_index.sql — looks renumbered to 0024_registry_records_type_index.sql: UPDATE registry_migrations SET name='0024_registry_records_type_index.sql' WHERE name='0020_registry_records_type_index.sql';
The alternative to every edit above is to restore the missing file itself, which leaves the table alone.
```

(That is the message verbatim, for the exact 13 September state: the row
renamed, `0024_…` left looking pending.)

**Every** orphan is named, not just the first — a renumbering moves a run of
files. The remedy is derived from the filename's stem (the part a renumber
leaves alone), so the rename case gets the exact one-line `UPDATE`; an orphan
no on-disk file matches is told to restore the file from git history, or to
drop the row if the file was deleted on purpose.

Two things the guard deliberately does **not** do:

- **A file the table does not know is not an error.** That is a *pending*
  migration — the ordinary state of a boot after a deploy — and it still
  applies, exactly as before.
- **A virgin database is not an error.** On a first boot `migrate()` creates
  the empty `registry_migrations` ledger — the one statement that is safe
  against a possibly-corrupt history, and the thing that pins the check and the
  apply loop to the SAME table when a DSN carries a multi-schema `search_path`
  — then reads an empty list and no-ops. A database with no history cannot
  contradict the directory.

The precedent, deliberately rather than invented: **Knex's
`validateMigrationList`**, whose sentence is borrowed word for word. What is
added on top of it is the remedy — Knex names the missing files, this names the
SQL, because the rename is the case that actually happens and its fix is a
bookkeeping edit rather than a re-run.

The proof is `test/postgres.test.ts` → *"the migrator refuses to start on a
corrupt migration directory"*, which builds its own schema, applies
`0001…0034` as `migrate()` does, reproduces both the extra-row and the exact
13 September states, and asserts that the refusal arrives **instead of** the
re-run (it skips without `VIBTRA_TEST_DATABASE_URL`; see Tests below). **The
file store has no migrations** and none of this applies to it.

## Operator commands

### The plan-change queue

An org's admins can **ask** for a different bucket from the console's Billing
page (`POST /api/console/billing/plan-request`, DECISIONS.md `pay-12`). That
door writes one row and changes no plan — which is what makes it safe to have.
Deciding is an **operator act**, like `plan` and `reseal`,
because the decider is us and the queue spans every organisation:

```
pnpm --filter @vibtra/registry plan-requests -- list
pnpm --filter @vibtra/registry plan-requests -- approve <requestId> --actor=<your address> [--note=…]
pnpm --filter @vibtra/registry plan-requests -- decline <requestId> --actor=<your address> [--note=…]
```

`--actor=` is **required and never defaulted**, exactly as it is on `plan`: an
approval moves a customer between buckets and writes a line that has to name
somebody, and `$USER` would be a field that looks like an answer and is not.

Approving **flips the row `pending → approved` atomically** — the UPDATE carries
`AND status = 'pending'`, so two operators running it at once produce one
approval and one refusal — and then calls the audited `changeOrgPlan`, which
runs `TenancyStore.setPlan` and writes the `evidence-10` `vault_audit`
`plan.changed` line with the actor, the previous bucket and the request id.
**That line is the ledger record here**: `src/records/ledger.ts` has no record
type for a plan change.

Declining touches nothing but the row, and the org may ask again — a decline is
an answer for now and not forever, which is why the partial unique index
excludes decided rows.

### Rotating the tool-gate signing key

The key behind `/oauth2/jwks` — the one every deployed tool verifies its
sign-in against. It is a **row in the `jwks` table**, minted by Better Auth's
`jwt` plugin, private half encrypted under `REGISTRY_GATE_SIGNING_SECRET`
(DECISIONS.md `host-9` — it was `REGISTRY_SESSION_SECRET` until 14 September
2026, which meant a console rotation took the tool gate with it). This is a
*different* key from the org vault's (`VIBTRA_VAULT_KEY`, further down) and a
different command; the three rotations share nothing but their shape.

Rotating the **secret** rather than the key is
`docs/deploy-registry-aws.md` §1.5 runbook B, and it ends by running the soft
command below.

```bash
# SOFT (the default). Mints a fresh ES256 key and makes it the signing key; the
# old key can no longer SIGN, but its public half is still served, so every ID
# token already in a browser verifies until its own `exp` — at most twelve
# hours. NOBODY IS SIGNED OUT. Reach for this one.
pnpm --filter @vibtra/registry rotate-issuer-key

# BLUNT. Same mint, but every old key is DELETED — the one in use and any an
# earlier soft rotation retired but left served — so the key set holds nothing
# but the fresh one, every live artifact's session fails verification at its
# next request, and everyone signs in again. This is the instrument docs/gate.md §6 names for
# "revoke every session now"; there is no `jti` deny-list and deliberately so.
pnpm --filter @vibtra/registry rotate-issuer-key -- --revoke
```

**No redeploy, either way.** Every gate verifies through `jose`'s
`createRemoteJWKSet`, which refetches the key set the first time it meets a
`kid` it does not hold, so artifacts already in the field pick the new key up
on their own. The command prints the old `kid`, the new one, and whether the
old public key is still being served.

It is an operator subcommand of `main.ts` with the same discipline as `reseal`
(`sops updatekeys`): it builds the whole server **without listening**, so it
resolves the key set exactly as a boot would; it **mints before it retires or
deletes**, so the table is never left with zero keys even if the process dies
mid-run; and it re-reads the rows afterwards and exits non-zero unless they say
what it is about to claim. It **refuses rather than half-running** when there
is **no `DATABASE_URL`**, where the `jwks` table is the serving
process's own memory and this second process could only ever rotate its own
copy. On a dev box without Postgres the equivalent of `--revoke` is simply
restarting the registry.

Scheduled rotation (`jwks.rotationInterval`) stays **off** — see docs/gate.md
§6. An unattended rotation that signed everybody out on a timer is not a thing
to enable without someone asking for it.

## SSO per organisation

An organisation **owner** registers their own OpenID Connect provider from the
console's **Settings → Sign-in**, and their people sign in through it instead
of through Google. **Google is untouched and stays the default for everybody**:
adding a provider does not take it away, and removing one does not sign anybody
out. The runbook — Okta as the worked example, Entra's one extra step, and what
to do when it does not work — is [`docs/sso.md`](../../docs/sso.md).

```
GET    /api/console/sso                  this org's providers, REDACTED
POST   /api/console/sso                  register one (owner only). Carries a
                                         client secret INBOUND, once
DELETE /api/console/sso/:providerId      remove one (owner only)
POST   /api/console/sso/:providerId/test fetch the discovery document and report
                                         the endpoints found — no sign-in
```

**The redirect URI the customer must put in their IdP** is
`${REGISTRY_BASE_URL}/api/auth/sso/callback/<providerId>`, and the provider id
is **derived from the organisation's domain** (`acme.example` →
`sso-acme-example`) rather than generated — so the console can show the exact
string on an empty form, before the customer has created anything in Okta. Okta
will not hand out a client id until an application with a redirect URI exists;
a generated id would make that a three-trip runbook.

**Identity: `@better-auth/sso` 1.7.2 (MIT)**, used as designed —
`src/auth/sso.ts` argues every option. Four things about it are this registry's
own and are worth knowing before operating it:

* **The domain fence.** An asserted address must be inside the domain the
  provider is bound to, checked inside the plugin's own transaction before any
  account or session is written. Without it, an organisation could point its
  IdP here and assert somebody else's company address, and the claims-or-joins
  rule would hand them that organisation.
* **The domain is never a request field.** The door writes the organisation's
  own claimed domain — a `UNIQUE` slug claimed by somebody with a verified
  mailbox on it — and there is nowhere in the request to ask for another.
* **The plugin's own write paths are CLOSED over HTTP** (404 on
  `/api/auth/sso/register` and friends). That is the safeguard that makes
  `trustEmailVerified: true` honest: providers are created only through the
  owner-only console door, which calls the plugin in-process.
* **Membership is still the claims-or-joins rule.** The plugin's
  organisation-provisioning is switched off, so an SSO sign-in can never write
  a second `member` row behind the rule's back.

**An identity provider that will not assert `email_verified` signs nobody in.**
This registry has always refused an unverified address, and SSO is held to the
same rule. Okta releases the claim with the `email` scope; **Microsoft Entra ID
does not emit it at all** in a v2.0 ID token, so an Entra provider needs a
claims mapping that does. `docs/sso.md` §5 is the whole argument, and the
refusal names the claim rather than blaming the person.

The table is `migrations/0009_sso.sql`. It holds the customer's OIDC **client
secret** inside the plugin's `oidcConfig` JSON — that file says so plainly,
including that it is NOT in the org vault and why.

## An organisation's own sign-in provider

An org owner registers their OIDC identity provider from Settings → Sign-in
(`docs/sso.md` is the runbook). What is worth knowing from here is where the
**client secret** they paste ends up: sealed, with the same envelope as every
other sealed row (migration 0033, decision `host-10`,
14 September 2026), bound to *(the organisation, `sso-provider:<providerId>`)*
so a row moved between organisations does not decrypt. It is the same key ring
as everything else this registry seals, so `pnpm --filter @vibtra/registry
reseal` covers it and the vault-key rotation runbook gained no step.

Two consequences an operator meets:

- **A registry with no `VIBTRA_VAULT_KEY` refuses to register a provider at
  all**, with a sentence naming the variable — the same fail-closed posture as
  every other sealed write. There is no code path here that writes an SSO
  client secret in the clear.
- **A provider registered before that migration is sealed in place on its first
  read**, because SQL cannot mint an envelope and the migration therefore
  backfills nothing. `reseal` finishes whatever the read path has not reached;
  it reports the table on its own line.

## Sealed rows and the vault key

Guard's rule-signing key, each organisation's SSO client secret, and the connection and tool rows that
earlier versions stored are sealed with **AES-256-GCM** under `VIBTRA_VAULT_KEY`, or through OpenBao's
`transit` engine when `OPENBAO_ADDR` is set (`src/vault/sealer-ring.ts`). Each envelope is bound by its
AAD to its organisation and row, so a row moved between organisations does not decrypt. An `onSend`
tripwire (`src/vault/tripwire.ts`) refuses to send any response that contains a sealed envelope.

With `OPENBAO_ADDR` unset nothing involves OpenBao. With it set, an unreachable OpenBao is a refusal,
never a fall back to a local key. `/healthz` reports `openbao: reachable | unreachable | not-configured`.
The setup is in [`docs/openbao.md`](../../docs/openbao.md).

### Rotating the vault key

The key is a **ring**, and that does not change when the key moves into
OpenBao. Exactly one key is ever sealed *with*; the rest may still *open* a
row; every envelope names the key that sealed it, so the registry selects
rather than guesses. This is Rails' `ActiveRecord::Encryption previous:` and
Django's `SECRET_KEY_FALLBACKS` — encrypt with one, decrypt with many, rotate
by re-encrypting, then drop the old — with OpenBao's rule that the
ciphertext's own key id decides.

**What changes is where the key lives, and therefore what step 1 is.** With
`OPENBAO_ADDR` set, minting a key is `rotate` on a transit key and the registry
never sees the material. With it unset, it is `openssl rand -hex 32` and an
environment file. Both procedures are below; they are the same shape and the
second is unchanged from before OpenBao existed.

#### With OpenBao (transit)

Rotating is **four steps and no downtime**, and no step involves a key value.

```bash
# 1. Mint a NEW VERSION of the transit key. Old versions stay and keep
#    decrypting; new encryptions use the new one. Nothing on the registry
#    changes, nothing restarts, and no key material is printed or handled.
#
#    WHICH KEY: OPENBAO_PLAN D4 gives each org its own namespace with its own
#    transit mount, so this is per namespace. The boot census names what the
#    registry is actually using; `bao namespace list -namespace=orgs` and
#    `bao list <ns>/transit/keys` enumerate them.
bao write -f -namespace=orgs/<orgId> transit/keys/org/rotate
#    …or, in D4's single-root-mount fallback, once:
bao write -f transit/keys/<name>/rotate

# 2. Re-seal every row under the new version. Same command as always: the walk
#    is an operator action (`sops updatekeys`, not a background job), and under
#    transit each row is opened and re-sealed through OpenBao's own rewrap.
pnpm --filter @vibtra/registry reseal      # or: node/tsx src/main.ts reseal
#    Hosted, this is the reseal ECS task — docs/deploy-registry-aws.md §8.5.

# 3. Verify. The command finishes with its own census and exits NON-ZERO
#    unless every row is under the current key.

# 4. Retire the old version, so a leaked older ciphertext cannot be opened
#    even by someone who reaches OpenBao. Only after step 3 reports zero rows
#    left behind — this is the one irreversible step in the sequence.
bao write -namespace=orgs/<orgId> transit/keys/org/config min_decryption_version=<the new version>
```

Things this procedure gives you that the environment-file one cannot: the key
material never exists outside OpenBao, so there is nothing to paste, nothing to
shred and nothing in a shell history; every use of every version is a line in
OpenBao's audit device; and step 4 is enforced by OpenBao rather than by
remembering to delete a variable.

**Rotating the KMS key is a different thing and needs nothing.** AWS rotates the
`awskms` auto-unseal key on its own annual schedule and keeps the old backing
keys to decrypt older data, so there is no procedure and no downtime. That key
wraps OpenBao's barrier; the transit keys above are what your credentials are
sealed under. Do not confuse the two, and do not delete either.

#### Without OpenBao

`OPENBAO_ADDR` unset — a self-host, the default. Here
`VIBTRA_VAULT_KEY` is the only key anything is sealed with and
`VIBTRA_VAULT_KEY_PREVIOUS` (comma-separated) is the set that may still open a
row. Rotating is **six steps and no downtime**.

```bash
# 1. Mint the new key and make it CURRENT; the old one becomes previous.
openssl rand -hex 32                       # → <new key>

# 2. On the registry's environment:
VIBTRA_VAULT_KEY=<new key>
VIBTRA_VAULT_KEY_PREVIOUS=<old key>        # comma-separated if there are several

# 3. Restart. Everything keeps working: new writes seal under the new key,
#    old rows still open under the old one. Boot prints ONE line, e.g.
#      vault key ring: current 9f2a…, previous 41cd… — 7 of 7 connection
#      credentials and 2 of 2 tool secrets are still sealed under a previous key

# 4. Re-seal every row under the current key.
pnpm --filter @vibtra/registry reseal      # or: node/tsx src/main.ts reseal

# 5. Verify. The command finishes with its own census and exits NON-ZERO
#    unless every row is under the current key:
#      verification: vault key ring: current 9f2a…, previous 41cd… — all 7
#      connection credentials and 2 tool secrets are sealed under the current key

# 6. Drop the old key from VIBTRA_VAULT_KEY_PREVIOUS and restart. The boot
#    line now reads "(no previous keys configured)".
```

#### Moving from the environment key to OpenBao

The migration is the rotation, with a different step 1. Set `OPENBAO_ADDR`,
leave `VIBTRA_VAULT_KEY` exactly where it is — it becomes a *previous* key that
only opens — restart, and run `reseal`. The walk opens each row under the env
key and re-seals it under transit; when its census reports zero rows left
behind, `VIBTRA_VAULT_KEY` can be dropped. Hosted, that is
`docs/deploy-registry-aws.md` §8.4 and §8.5. **Nothing falls back**: once
`OPENBAO_ADDR` is set, an unreachable OpenBao is a refusal, never a quiet
return to the local key.

Things worth knowing before you start — **all of these hold in both
procedures**, because the walk and the ring are the same code either way:

- **`reseal` walks three kinds of row**: the connection credentials and tool
  client secrets earlier versions stored, and each organisation's SSO client
  secret. It does not walk Guard's rule-signing key in `guard_signing_keys`,
  so keep the old key in `VIBTRA_VAULT_KEY_PREVIOUS` (or the old transit
  version decryptable) until that key has been replaced.
- **The command is idempotent.** A second run re-seals nothing and writes
  nothing; an interrupted first run is finished by a second.
- **A row sealed under a key you no longer hold is left exactly as it is**, and
  counted, and its key fingerprint printed. Put that key back — in
  `VIBTRA_VAULT_KEY_PREVIOUS`, or by lowering `min_decryption_version` on the
  transit key if you retired a version too early — and run again, or have the
  admin re-enter the credential. The command never deletes a row it cannot
  read.
- **Do not put the current key in the previous list** — the registry refuses to
  boot, because an unfinished rotation would be indistinguishable from a
  finished one.
- **Nothing prints a key.** Every line and every error carries 12-hex
  fingerprints and counts only.
- On Postgres the walk runs in **one transaction** with `SELECT … FOR UPDATE`,
  so a concurrent write cannot replace a row underneath it.
- **On the file store, stop the registry first.** The command opens the same
  `vault.json` / `tools.json` as a running instance would, and the file store
  persists by rewriting the whole file — so a write made *while the walk is
  running* can be overwritten by it. Postgres has the transaction above and needs no such
  care; the file store is the dev/zero-config posture, and there the honest
  procedure is stop → `reseal` → start.

## Tests

The tests live in `tests/integration/**` and `tests/e2e/**` (see CONTRIBUTING.md). Point
`VIBTRA_TEST_DATABASE_URL` at a scratch Postgres database to run the Postgres stores too:

```sh
VIBTRA_TEST_DATABASE_URL=postgres://guard:guard-ci-only@127.0.0.1:5533/<db> corepack pnpm@10.11.0 test:integration
```

## Third-party notices

**They are generated, and they are in [`NOTICES.md`](./NOTICES.md)** beside this file: one entry for
every package in this app's transitive production closure as installed, with each one's own licence
text. Regenerate with `pnpm licence:manifest`; `pnpm licence:manifest --check` fails when it is stale.
