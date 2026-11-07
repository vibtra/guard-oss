# Self-hosting Guard

This is the one supported way to run your own Guard server today: the server and the web dashboard, built from this
repository, with Postgres, in Docker Compose. You sign in with your own identity provider. Nothing calls a Vibtra
service. The commercial `ee/` directory is not in the image; everything below is the free core.

The Compose file pulls the published image, `ghcr.io/vibtra/guard-oss:0.1.0`. To build from your checkout instead, add `--build`.

## What you need

- A Linux or macOS host with Docker Engine and Docker Compose v2 (`docker compose version`). Validated with Docker
  28.4.0.
- A DNS name for the server, for example `guard.example.com`, and a TLS reverse proxy (Caddy, nginx, Traefik, a cloud
  load balancer) that forwards HTTPS to `127.0.0.1:4700` on the host.
- An identity provider that can sign people in:
  - your own OpenID Connect provider (Okta, Entra ID, Keycloak, Authentik, dex and similar), or
  - a Google OAuth client.
- At least 3 GB of free disk for the image build. The final image is about 1.2 GB; the build stage and base images
  need the rest.

## Server URL and TLS

`REGISTRY_BASE_URL` is the address people and Macs use. It must be `https://`. The server refuses to start with any
other `http://` address. The only exception is `http://localhost` or `http://127.0.0.1`, for a trial on one machine.

The Compose file publishes Guard on `127.0.0.1` only and does not publish Postgres. Your proxy terminates TLS and
forwards to it. If the proxy runs on another machine, set `GUARD_BIND_ADDRESS` to a private address, never `0.0.0.0`
on a host with a public interface.

Every Mac you enrol must be able to reach `REGISTRY_BASE_URL`. Enrolment links and the agent's sync use that address.

## Sign-in

Choose one provider. Only that provider is offered on `/login`.

### Your own OpenID Connect provider

Create a confidential web client in your provider:

| Setting | Value |
| --- | --- |
| Redirect URI | `<REGISTRY_BASE_URL>/api/auth/callback/oidc` |
| Grant | Authorization code, with PKCE (S256) |
| Scopes | `openid email profile` |
| Claims | `email` and `email_verified: true` in the ID token or userinfo |

Then set:

```sh
REGISTRY_OIDC_PROVIDER=oidc
REGISTRY_OIDC_ISSUER=https://login.example.com   # exactly the "issuer" in its discovery document
REGISTRY_OIDC_NAME=Example SSO                   # button text on /login
REGISTRY_OIDC_CLIENT_ID=...
REGISTRY_OIDC_CLIENT_SECRET=...
```

The server reads `<issuer>/.well-known/openid-configuration` on boot and waits up to a minute for it. ID tokens are
verified against the provider's published keys, with a nonce. A person with an unverified email is refused.

This path is proved end to end against a local dex provider by `scripts/self-host-proof.py` (see Validation).

### Google

Create an OAuth client in Google Cloud (application type "Web application") and register
`<REGISTRY_BASE_URL>/api/auth/callback/google` as its authorised redirect URI, for a local trial
`http://localhost:4700/api/auth/callback/google`. A client in Testing mode works; add each person who will sign in as
a test user. Then set:

```sh
REGISTRY_OIDC_PROVIDER=google
REGISTRY_OIDC_ISSUER=                            # empty for Google
REGISTRY_OIDC_CLIENT_ID=....apps.googleusercontent.com
REGISTRY_OIDC_CLIENT_SECRET=...
```

Any Google account can complete a Google sign-in, so also set `REGISTRY_REGISTRATION=allowlist`, and either
`REGISTRY_OPERATOR_DOMAIN` to your own domain or `REGISTRY_OWNER_EMAIL` to your own address (next section).

A real Google sign-in has not been exercised against this recipe yet. The Google provider code is unchanged from the
hosted service, and `scripts/container-smoke.py` boots the image with Google configured.

### Who becomes the owner

The first person to sign in with a verified address on a domain creates that domain's organisation and becomes its
owner. Later people from the same domain join it as members, subject to the organisation's join settings. Addresses
on public mail domains (gmail.com and similar) cannot create an organisation. They are refused at sign-in unless a
colleague has invited them.

With `REGISTRY_REGISTRATION=allowlist`, only `REGISTRY_OPERATOR_DOMAIN`, or addresses and domains the operator lists,
can create an organisation. Use this unless your provider only signs in your own staff.

If you sign in with a personal mailbox, for example a Google account on gmail.com, set `REGISTRY_OWNER_EMAIL` to that
one address. On first sign-in it creates an organisation named after the part before the `@` (`jo.smith@gmail.com`
gets `jo-smith`) and becomes its owner. If an organisation already has that name, for example after you change the
address, the new address still gets an organisation of its own, named with a number after it (`jo-smith-2`). That
organisation claims no mail domain, so nobody else joins it automatically: invite each colleague from People. Every
other personal mailbox is still refused. Leave it empty when everyone signs in on your own domain.

### One organisation or many

A self-hosted server holds one organisation. The first sign-in creates it, as above. After that, a sign-in that would
create a second organisation is refused, and nothing is created. People still join the organisation by its domain,
under its join settings, or by invitation. `REGISTRY_REGISTRATION=allowlist` still decides who may create the first
one. To let each new domain create its own organisation, set `GUARD_MULTI_ORG=1`.

A self-hosted server sets no limit on people, devices or usage. The Compose file turns the limit off with `GUARD_NO_PEOPLE_LIMIT`.

## Settings

Every input is in `apps/registry/self-host.env.example`. Copy it outside the checkout, fill it in and keep it mode
600.

| Variable | Required | Meaning |
| --- | --- | --- |
| `REGISTRY_BASE_URL` | yes | The `https://` address people and Macs use (`http://localhost:<port>` for a trial). |
| `GUARD_DB_PASSWORD` | yes | Password for the bundled Postgres. Generate it with `openssl rand -hex 24`. |
| `REGISTRY_OIDC_PROVIDER` | no | `oidc` or `google` (default `google`). |
| `REGISTRY_OIDC_ISSUER` | for `oidc` | Your provider's issuer. Empty for Google. |
| `REGISTRY_OIDC_NAME` | no | Button text on `/login` for `oidc`. |
| `REGISTRY_OIDC_CLIENT_ID` | yes | The OAuth client id. |
| `REGISTRY_OIDC_CLIENT_SECRET` | yes | The OAuth client secret. |
| `REGISTRY_REGISTRATION` | no | `allowlist` (recommended) or `open`. |
| `REGISTRY_OPERATOR_DOMAIN` | no | Your mail domain. Its first person becomes the owner. |
| `REGISTRY_CONTACT_EMAIL` | no | Shown to people who are refused at sign-in. |
| `REGISTRY_OWNER_EMAIL` | no | One personal-mailbox address that may create the organisation. |
| `GUARD_QUICK_START` | no | `1` on a trial server only: an organisation that has not saved its Guard settings opens in Enforce, and one that has not saved rules gets the starter rules. Leave empty on a company server: a new organisation opens in Monitor. Setting or clearing it changes every organisation that has not saved. Any other value stops the server at start. |
| `GUARD_MULTI_ORG` | no | `0` (the Compose default): one organisation per server. `1`: each new domain may create its own. Any other value stops the server at start. |
| `GUARD_IMAGE` | no | Image to run (default `ghcr.io/vibtra/guard-oss:0.1.0`). |
| `GUARD_BIND_ADDRESS` | no | Host address Guard listens on (default `127.0.0.1`). |
| `GUARD_PORT` | no | Host port Guard listens on (default `4700`). |
| `REGISTRY_SESSION_SECRET`, `REGISTRY_GATE_SIGNING_SECRET`, `VIBTRA_VAULT_KEY` | no | Leave empty; see below. |

Compose reads one or more env files; later files override earlier ones. You can keep the OAuth client id and secret
in a file of their own and pass it last.

## Install

```sh
git clone https://github.com/vibtra/guard-oss guard && cd guard
mkdir -m 700 ~/guard-config                                                     # outside the checkout
install -m 600 apps/registry/self-host.env.example ~/guard-config/guard.env
$EDITOR ~/guard-config/guard.env                                                 # fill in every value
dc() { docker compose -f apps/registry/docker-compose.yml --env-file ~/guard-config/guard.env "$@"; }
dc up -d --wait   # add --build to build the image from this checkout instead
dc logs guard | tail
```

On first boot the server generates three secrets into the `guard-data` volume, in `/data/secrets.env` (mode 600):

| Secret | Protects |
| --- | --- |
| `VIBTRA_VAULT_KEY` | Seals Guard's signing keys in Postgres. Losing it means every Mac must re-enrol. |
| `REGISTRY_SESSION_SECRET` | Dashboard sessions. Changing it signs everyone out. |
| `REGISTRY_GATE_SIGNING_SECRET` | The server's other signing key at rest. |

They are never written into the image or the repository. To manage them yourself, set all three in the env file;
the volume file is then neither created nor read.

Migrations run on every boot. Then open `<REGISTRY_BASE_URL>/login`, sign in, and you land on
`<REGISTRY_BASE_URL>/<your-org>/guard`.

## First steps in the dashboard

1. **Settings**: choose Enforce once people have had notice (already Enforce if you set `GUARD_QUICK_START=1`). In
   Monitor mode a matching request is reported and still sent.
2. **Rules**: add a content rule or a service rule and save. Rules are signed per device and sent at the next sync.
3. **Devices**: create an enrol link for a person. The link is single use and expires.
4. Install the Guard app on that person's Mac and enrol it with the link. The signed Mac client, its install and its
   removal are covered in [guide/mac.md](guide/mac.md) and [guide/removal.md](guide/removal.md).
5. **Activity** shows what each Mac reports.

## Checking a new server end to end

`scripts/self-host-walk.mjs` checks a running server with the real Guard agent on a test Mac, without changing that
Mac's proxy settings, certificate trust, keychain or Network Extension. It builds the Go agent from this checkout
(Go is required), copies it to the test Mac over SSH into `~/guard-selfhost-walk`, enrols it in an isolated profile,
and sends three prompts through it to a stand-in origin on your machine: a normal one, one with your rule's keyword,
and a normal one. When the server URL is `http://localhost`, it reaches the server through an SSH tunnel. The test
Mac must be an Apple silicon Mac you can reach with an SSH key.

| Step | Who | What |
| --- | --- | --- |
| 1 | you | Start the stack (Install) and open `<REGISTRY_BASE_URL>/login`. Sign in. You land on your organisation. |
| 2 | you | **Settings**: choose Enforce (already Enforce if you set `GUARD_QUICK_START=1`). |
| 3 | you | **Rules** → Content rules: add a rule named `Project Nightjar`, detector Keywords, keyword `PROJECT-NIGHTJAR`, all services, everyone, action Block. Save. |
| 4 | you | **Devices**: create an enrol link for yourself. Copy the link into a file with mode 600, for example `pbpaste > ~/guard-enrol-link && chmod 600 ~/guard-enrol-link`. |
| 5 | script | `node scripts/self-host-walk.mjs --guest <user>@<test-mac> --link-file ~/guard-enrol-link --compose-env ~/guard-config/guard.env` |
| 6 | you | **Devices** lists the test Mac with its last sync. **Activity** shows the blocked prompt under `Project Nightjar`, and allowed traffic before and after it. |

Step 5 passes only if the agent enrols, takes a signed policy, lets the first and third prompts through, blocks the
second without contacting the origin, and uploads the block. With `--compose-env` it also reads Postgres, without
changing it: the block is stored as metadata, allowed traffic from the test Mac is stored before and after it, the
device has synced, and a full dump holds none of the prompt text.
The link is read from the file and never printed. Repeat `--compose-env` if you start the stack with several env
files, in the same order. Pass `--project` if you changed the Compose project name, and
`--keep-agent` to leave the agent running. A link works once; make a new one for each run.

What a Mac can see and block is decided by the Mac agent, not by this server. This recipe does not change that
coverage. The server stores event metadata only: service, host, app, rule, match type and count, size, and an
optional redacted snippet when the org's snippet setting allows it. It does not accept or store prompt or file
contents. An uploaded event with any extra field is rejected.

## Backup

Back up three things together, and keep them as secret as the database:

```sh
dc exec -T postgres pg_dump -U guard -d guard --format=custom > guard-db.dump
dc exec -T guard cat /data/secrets.env > guard-secrets.env && chmod 600 guard-secrets.env
cp ~/guard-config/guard.env guard.env.backup
```

A database backup without the matching `secrets.env` cannot be used: the signing keys inside it stay sealed.

## Restore

Restore into empty volumes. Do not start the `guard` service before the database is restored.

```sh
dc up -d --wait postgres
dc exec -T postgres pg_restore -U guard -d guard --no-owner --exit-on-error < guard-db.dump
dc run --rm --no-deps -T --entrypoint sh guard -c 'umask 077 && cat > /data/secrets.env' < guard-secrets.env
dc up -d --wait
```

Enrolled Macs keep syncing with their existing tokens, and they keep trusting the signing key they pinned at
enrolment. Dashboard sessions stay valid. If you start the server against a restored database without
`secrets.env`, it refuses to boot rather than generate new keys.

## Restart and upgrade

`dc restart`, `dc down` followed by `dc up -d --wait`, and host reboots keep all state in the two named volumes.
`dc down -v` deletes the volumes and everything in them.

To upgrade, take a backup, update the checkout, then `dc pull` and `dc up -d --wait` (or `dc up -d --build --wait` if you build from source). Upgrades between versions have not
been exercised yet; restart and restore have.

## Operator commands

```sh
dc logs -f guard
```

Run server commands through `guard-entrypoint`, as below. It loads the three secrets from `/data/secrets.env` before
the command starts. Without it, a command fails with `REGISTRY_MODE=hosted requires: REGISTRY_SESSION_SECRET`.


## Failure messages

| Message | Fix |
| --- | --- |
| `required variable REGISTRY_OIDC_CLIENT_ID is missing a value: ...` (or another variable) | Fill in the env file and pass it with `--env-file`. |
| `[guard] REGISTRY_BASE_URL must start with https:// ...` | Use your proxy's `https://` address. |
| `REGISTRY_OIDC_PROVIDER=oidc requires REGISTRY_OIDC_ISSUER` | Set the issuer URL. |
| `REGISTRY_OIDC_ISSUER must use https` | Use the provider's `https://` issuer. |
| `REGISTRY_OIDC_ISSUER does not match the provider's issuer` | Copy `issuer` from the discovery document exactly, including any trailing slash. |
| `The identity provider is unreachable` | Check the issuer URL, DNS and firewall from the Docker host. |
| `[guard] The database already holds Guard data, but /data/secrets.env is missing.` | Restore `secrets.env` from the backup made with this database. If you set `REGISTRY_SESSION_SECRET`, `REGISTRY_GATE_SIGNING_SECRET` and `VIBTRA_VAULT_KEY` yourself, put them back in the env file. |
| `[guard] Could not check the database before generating secrets.` | Check that Postgres is running and `GUARD_DB_PASSWORD` matches the database. |
| `/data is not a writable directory` | Mount the `guard-data` volume at `/data`. |
| `Sign-in is unavailable. Contact your administrator.` on `/login` | Check `dc logs guard` and the provider's redirect URI. |
| `REGISTRY_MODE=hosted requires: REGISTRY_SESSION_SECRET` from an operator command | Run it through `guard-entrypoint` ([Operator commands](#operator-commands)). |

## Validation

`python3 scripts/self-host-proof.py` runs this recipe on clean volumes with a local dex provider added as a test
overlay. It signs in through dex's own login form, saves a content rule, creates an enrol link, enrols a simulated Mac
through the agent's sync endpoints, checks the signed rules and an allowed, blocked, allowed sequence on Activity, and
checks Postgres for prompt text. A second dex user on a gmail.com address, named in `REGISTRY_OWNER_EMAIL`, gets its
own organisation, and a third gmail.com user is refused. It then restarts the stack, takes the backup above, deletes
the original volumes, restores into fresh ones and checks again that nothing needs re-enrolment. It uses Compose
projects `vib21` and `vib21r` on `127.0.0.1:5940` (`GUARD_PROOF_PORT` changes the port) and removes everything it
created. It needs Docker and `htpasswd`.

`python3 scripts/self-host-proof.py --guest <user>@<test-mac>` also runs `scripts/self-host-walk.mjs` against that
stack with a link the owner's session mints, then checks that the owner's Activity shows the test Mac's block and
allowed traffic before and after it.

`GUARD_IMAGE=vibtra-guard:self-host python3 scripts/container-smoke.py` boots the image with Google configured and
runs the registry tests against a disposable Postgres.

The walk drives the real Go agent on a macOS virtual machine through its HTTP proxy. It does not exercise the signed
Mac app or its Network Extension.

`tests/integration/infra/self-host-recipe.test.ts` pins the Compose file, the Dockerfile and the entrypoint's secret
generation and refusals; its Postgres cases run when `VIBTRA_TEST_DATABASE_URL` is set.

## Licence

The server is AGPL-3.0-only. The repository's `README.md` lists each path's licence, and
`docs/decisions/0002-community-edition.md` records what the Community Edition includes.
