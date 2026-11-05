# Guard backend runtime

This repository starts independently; no sibling checkout is used. Production uses Postgres and Better Auth sign-in through one configured provider: Google, or the operator's own OpenID Connect provider. No demo cookies or test-auth flag belong in production.

To self-host, follow [self-host.md](self-host.md). It covers the Compose recipe, sign-in setup, generated secrets, backup and restore.

Generate and persist your own secrets outside the repository. Required variables:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres database for this deployment |
| `REGISTRY_BASE_URL` | URL clients can reach; HTTPS for a remote deployment |
| `REGISTRY_SESSION_SECRET` | Random session secret, at least 32 characters. Generated on first boot by the container entrypoint when unset |
| `REGISTRY_GATE_SIGNING_SECRET` | Encrypts the server's other signing key at rest. Generated on first boot by the container entrypoint when unset |
| `VIBTRA_VAULT_KEY` | Persistent 32-byte key encoded as 64 hex characters; seals signing state. Generated on first boot by the container entrypoint when unset |
| `REGISTRY_OIDC_CLIENT_ID` / `REGISTRY_OIDC_CLIENT_SECRET` | Your OAuth client (Google or your OIDC provider) |
| `REGISTRY_OIDC_PROVIDER` | `google` (default) or `oidc` |
| `REGISTRY_OIDC_ISSUER` | With `oidc`: the provider's exact issuer URL; https when the base URL is https |
| `REGISTRY_OIDC_NAME` | With `oidc`: the button text on `/login` |
| `NODE_ENV` | `production` for operated deployments |
| `VIBTRA_REGISTRY_DATA_DIR` | Persistent local state directory, `/data` in container |

Register `<REGISTRY_BASE_URL>/api/auth/callback/google` (Google) or `<REGISTRY_BASE_URL>/api/auth/callback/oidc` (OIDC) in that OAuth application. Open `/login`, then `/<org>/guard`. `/start` resolves the signed-in organisation through the authenticated session API. Existing organisation claim/join rules are retained; customer onboarding policy is not changed by the split.

Build the dashboard before starting:

```sh
pnpm --filter @vibtra/guard-console build
pnpm start
```

The entrypoint selects `REGISTRY_MODE=hosted` and refuses an explicit `single` setting: the old unauthenticated ledger is not the Guard product.

Container:

```sh
docker build -f apps/registry/Dockerfile -t vibtra-guard:self-host .
```

The image builds the web dashboard, carries the Guard contract and leaves out `ee/`. Its entrypoint refuses a non-loopback `http://` base URL and generates the three secrets above into `/data/secrets.env` when they are unset. `apps/registry/docker-compose.yml` is the supported self-host recipe (docs/self-host.md); `python3 scripts/self-host-proof.py` validates it on clean volumes with a local OIDC provider. Never set `REGISTRY_TEST_AUTH` in production.

`python3 scripts/container-smoke.py` creates disposable Docker containers/network, runs the Guard Postgres tests and boots the production image with dummy OAuth configuration. It checks migrations, login page, web assets and route/auth boundaries, then removes its own containers. It does not prove an actual Google login or a production deployment. Set `GUARD_IMAGE` to test another image tag.

Do not configure the old builder/workspace/Slack/deploy environment variables. Those products are not exposed by this service. Secrets must not go into images, browser assets or version control. Retain both database backups and the sealing key together; the restore walkthrough is in docs/self-host.md.
