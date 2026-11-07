# Run your own server

You run the Guard server and web dashboard with Postgres in Docker Compose, and people sign in with your own
identity provider. Nothing calls a Vibtra service. The commercial `ee/` directory is not in the image.

This page is the short path. The full operator reference, with backup, restore and upgrade, is
`docs/self-host.md`.

> Status: the recipe has been run end to end with a local test identity provider (dex), including restart, backup
> and restore, and with the real Guard agent on a test Mac. A real Google sign-in, and the signed release of the Mac
> app enrolled against a self-hosted server, have not been run yet. The server is AGPL-3.0-only
> ([licence](README.md#licence)).

## What you need

- A Linux or macOS host with Docker Engine and Docker Compose v2. Tested with Docker 28.4.0.
- At least 3 GB of free disk. The final image is about 1.2 GB.
- A DNS name, for example `guard.example.com`, and a TLS reverse proxy that forwards HTTPS to `127.0.0.1:4700`.
- An identity provider: your own OpenID Connect provider (Okta, Entra ID, Keycloak, Authentik, dex and similar) or a
  Google OAuth client.
- A checkout of this repository, for the Compose file. The server image is published at `ghcr.io/vibtra/guard-oss:0.1.0`.

Every Mac you enrol must be able to reach the server's `https://` address.

## 1. Register a sign-in client

**OpenID Connect.** Create a confidential web client:

| Setting | Value |
|---|---|
| Redirect URI | `<REGISTRY_BASE_URL>/api/auth/callback/oidc` |
| Grant | Authorization code with PKCE (S256) |
| Scopes | `openid email profile` |
| Claims | `email`, and `email_verified: true` |

**Google.** In Google Cloud, create an OAuth client of type "Web application" and add
`<REGISTRY_BASE_URL>/api/auth/callback/google` as an authorised redirect URI. A client in Testing mode works: add
each person who will sign in as a test user. Any Google account can finish a Google sign-in, so also set
`REGISTRY_REGISTRATION=allowlist`, and either your own `REGISTRY_OPERATOR_DOMAIN` or, if you sign in with a personal
Google account, `REGISTRY_OWNER_EMAIL` (step 4).

## 2. Fill in the settings

```sh
git clone https://github.com/vibtra/guard-oss guard && cd guard
mkdir -m 700 ~/guard-config
install -m 600 apps/registry/self-host.env.example ~/guard-config/guard.env
$EDITOR ~/guard-config/guard.env
```

Keep the filled-in file outside the checkout and never commit it. Set at least:

| Setting | Value |
|---|---|
| `REGISTRY_BASE_URL` | Your `https://` address. `http://` works only for `localhost` or `127.0.0.1` trials. |
| `GUARD_DB_PASSWORD` | `openssl rand -hex 24` |
| `REGISTRY_OIDC_PROVIDER` | `oidc` or `google` |
| `REGISTRY_OIDC_ISSUER` | For `oidc`: exactly the `issuer` from `<issuer>/.well-known/openid-configuration`. Empty for Google. |
| `REGISTRY_OIDC_NAME` | Button text on the sign-in page |
| `REGISTRY_OIDC_CLIENT_ID`, `REGISTRY_OIDC_CLIENT_SECRET` | From step 1 |
| `REGISTRY_REGISTRATION`, `REGISTRY_OPERATOR_DOMAIN` | `allowlist` and your own domain |
| `REGISTRY_OWNER_EMAIL` | Optional. Your own address, when you sign in with a personal mailbox such as gmail.com. |
| `GUARD_MULTI_ORG` | `0`: the server holds one organisation. `1` lets each new domain create its own. |
| `GUARD_QUICK_START` | `1` for a trial server only: an organisation that has not saved its Guard settings opens in Enforce, and one that has not saved rules gets the starter rules, so a pasted test card number is blocked. Leave empty on a server your company uses: a new organisation then opens in Monitor. Setting or clearing it changes every organisation that has not saved, at the next sync. |

## 3. Start it

```sh
dc() { docker compose -f apps/registry/docker-compose.yml --env-file ~/guard-config/guard.env "$@"; }
dc up -d --wait   # add --build to build the image from this checkout instead
dc logs guard | tail
```

Guard listens on `127.0.0.1` only, and Postgres is not published. Point your TLS proxy at `127.0.0.1:4700`.

On first boot the server generates three secrets into `/data/secrets.env` (mode 600) in the `guard-data` volume:
`VIBTRA_VAULT_KEY`, `REGISTRY_SESSION_SECRET` and `REGISTRY_GATE_SIGNING_SECRET`. To manage them yourself, set all
three in the env file. Back up Postgres and `secrets.env` together. A database backup without its `secrets.env` cannot
be used, and every Mac would have to enrol again.

## 4. Sign in

Open `<REGISTRY_BASE_URL>/login` and sign in. You land on `<REGISTRY_BASE_URL>/<your-org>/guard`.

- The server holds one organisation. The first person with a verified address creates it and becomes its owner.
  After that, a sign-in that would create another organisation is refused, unless `GUARD_MULTI_ORG=1`
  ([One organisation or many](../self-host.md#one-organisation-or-many)).
- Later people from the same domain join as members.
- Public mail domains (gmail.com and similar) cannot create an organisation. They are refused at sign-in unless
  invited. The one exception is the address in `REGISTRY_OWNER_EMAIL`: if it signs in first, it creates the
  organisation, named after the part before the `@`, and becomes its owner. That organisation claims no domain, so invite each colleague from
  **People**.
- With `REGISTRY_REGISTRATION=allowlist`, only your operator domain and the addresses or domains you list can create
  an organisation.
- A person whose provider does not mark the email as verified is refused.

A self-hosted server sets no limit on people, devices or usage.

## 5. Check the mode

With `GUARD_QUICK_START=1` a new organisation opens in **Enforce** with the starter rules: a request that matches
a block rule is blocked, a request that matches an ask rule asks first, and a connection Guard cannot inspect is
blocked. Without it, a new organisation opens in **Monitor**: Guard records what the rules would block and lets the
request through. Once you save settings or rules, the saved ones stay, whatever `GUARD_QUICK_START` says later. To change the mode, open **Settings**, **Protection**. Give people notice before you
choose Enforce on a company server ([rules.md](rules.md)).

## 6. Enrol the first Mac

In the dashboard, open **Devices** and choose **Enrol device**. Pick the person, how the link reaches the laptop and
how long it works (24 hours by default). The link works once. Then follow [mac.md](mac.md).

## If it does not start

| Message | Fix |
|---|---|
| `required variable REGISTRY_OIDC_CLIENT_ID is missing a value` (or another variable) | Fill in the env file and pass it with `--env-file`. |
| `[guard] REGISTRY_BASE_URL must start with https://` | Use your proxy's `https://` address. |
| `REGISTRY_OIDC_PROVIDER=oidc requires REGISTRY_OIDC_ISSUER` | Set the issuer. |
| `REGISTRY_OIDC_ISSUER must use https` | Use the provider's `https://` issuer. |
| `REGISTRY_OIDC_ISSUER does not match the provider's issuer` | Copy `issuer` from the discovery document exactly, including any trailing slash. |
| `The identity provider is unreachable` | Check the issuer address, DNS and firewall from the Docker host. |
| `[guard] The database already holds Guard data, but /data/secrets.env is missing.` | Restore `secrets.env` from the backup taken with this database, or put your own three secrets back in the env file. |
| `[guard] Could not check the database before generating secrets.` | Check that Postgres is running and `GUARD_DB_PASSWORD` matches. |
| `/data is not a writable directory` | Mount the `guard-data` volume at `/data`. |
| `Sign-in is unavailable. Contact your administrator.` on `/login` | Check `dc logs guard` and the redirect URI registered with your provider. |
