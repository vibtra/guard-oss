#!/usr/bin/env python3
"""Self-host proof (VIB-21; docs/self-host.md): the documented Compose recipe on CLEAN volumes, end to end.

  python3 scripts/self-host-proof.py [--keep] [--guest USER@HOST]

Builds apps/registry/docker-compose.yml from this checkout, adds a local dex OpenID Connect provider (test overlay,
never part of the recipe), and runs scripts/self-host-e2e.mjs inside the stack: real sign-in through dex's own login
form, policy, enrol link, a simulated laptop on the agent's sync doors, a synthetic content block. Then it restarts the
stack (containers recreated, volumes kept), takes the documented backup, destroys the original volumes, restores into
a fresh project and verifies again. Postgres is checked for prompt text. A second dex user on a personal mailbox
(REGISTRY_OWNER_EMAIL) gets its own organisation and a third is refused. With --guest, the real Go agent is enrolled
inside that guest Mac through scripts/self-host-walk.mjs with a link the owner's session mints, and the owner's
Activity must show its block. Projects vib21 and vib21r, host port 5940
(GUARD_PROOF_PORT), loopback only. Everything it creates is removed at the end unless --keep. Never touches the host's
Guard install, keychain, trust store or proxy settings. Needs Docker with Compose v2 and `htpasswd` (bcrypt).
"""
import os, secrets, shutil, subprocess, sys, tempfile, json, uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COMPOSE = ROOT / "apps/registry/docker-compose.yml"
PORT = os.environ.get("GUARD_PROOF_PORT", "5940")
PROJECT, RESTORED = "vib21", "vib21r"
DEX = "ghcr.io/dexidp/dex:v2.41.1@sha256:bc7cfce7c17f52864e2bb2a4dc1d2f86a41e3019f6d42e81d92a301fad0c8a1d"
OWNER = "owner@acme.test"
PERSONAL = "founder.selfhost@gmail.com"
STRANGER = "stranger.selfhost@gmail.com"
KEEP = "--keep" in sys.argv
GUEST = sys.argv[sys.argv.index("--guest") + 1] if "--guest" in sys.argv else None


def say(line):
    print(f"[self-host-proof] {line}", flush=True)


def run(args, **kw):
    out = subprocess.run(args, text=True, capture_output=True, **kw)
    if out.returncode != 0:
        raise RuntimeError(f"{' '.join(map(str, args[:8]))} …\n{out.stdout[-3000:]}\n{out.stderr[-3000:]}")
    return out.stdout


def main():
    work = Path(tempfile.mkdtemp(prefix="guard-self-host-proof-"))
    os.chmod(work, 0o700)
    (work / "state").mkdir(mode=0o777)
    os.chmod(work / "state", 0o777)
    password = secrets.token_urlsafe(18)
    bcrypt = run(["htpasswd", "-nbBC", "10", "owner", password]).strip().split(":", 1)[1].replace("$2y$", "$2a$")
    client_secret = secrets.token_hex(24)
    (work / "dex.yaml").write_text(
        "\n".join(
            [
                "issuer: http://dex:5556/dex",
                "storage: {type: memory}",
                "web: {http: 0.0.0.0:5556}",
                "oauth2: {skipApprovalScreen: true}",
                "enablePasswordDB: true",
                "staticPasswords:",
                *[
                    line
                    for email, name in ((OWNER, "owner"), (PERSONAL, "founder"), (STRANGER, "stranger"))
                    for line in (f"  - email: {email}", f"    hash: \"{bcrypt}\"", f"    username: {name}", f"    userID: \"{uuid.uuid4()}\"")
                ],
                "staticClients:",
                "  - id: guard-selfhost-proof",
                f"    secret: {client_secret}",
                "    name: Guard",
                "    redirectURIs: [\"http://localhost:4700/api/auth/callback/oidc\"]",
                "",
            ]
        )
    )
    os.chmod(work / "dex.yaml", 0o644)
    env = work / "guard.env"
    env.write_text(
        "\n".join(
            [
                "REGISTRY_BASE_URL=http://localhost:4700",
                f"GUARD_DB_PASSWORD={secrets.token_hex(24)}",
                "REGISTRY_OIDC_PROVIDER=oidc",
                "REGISTRY_OIDC_ISSUER=http://dex:5556/dex",
                "REGISTRY_OIDC_NAME=Acme SSO",
                "REGISTRY_OIDC_CLIENT_ID=guard-selfhost-proof",
                f"REGISTRY_OIDC_CLIENT_SECRET={client_secret}",
                "REGISTRY_REGISTRATION=allowlist",
                "REGISTRY_OPERATOR_DOMAIN=acme.test",
                "REGISTRY_CONTACT_EMAIL=it@acme.test",
                f"REGISTRY_OWNER_EMAIL={PERSONAL}",
                "GUARD_BIND_ADDRESS=127.0.0.1",
                f"GUARD_PORT={PORT}",
                "",
            ]
        )
    )
    os.chmod(env, 0o600)
    overlay = work / "oidc-test.yml"
    overlay.write_text(
        f"""services:
  dex:
    image: {DEX}
    command: ["dex", "serve", "/etc/dex/config.yaml"]
    volumes: ["{work / 'dex.yaml'}:/etc/dex/config.yaml:ro"]
  guard:
    depends_on: [dex]
  e2e:
    image: vibtra-guard:self-host
    profiles: [e2e]
    network_mode: "service:guard"
    entrypoint: ["/app/apps/registry/node_modules/.bin/tsx", "/app/scripts/self-host-e2e.mjs"]
    environment:
      GUARD_E2E_BASE_URL: http://localhost:4700
      GUARD_E2E_EMAIL: {OWNER}
      GUARD_E2E_PASSWORD: "{password}"
      GUARD_E2E_PERSONAL_EMAIL: {PERSONAL}
      GUARD_E2E_STRANGER_EMAIL: {STRANGER}
    volumes:
      - "{ROOT / 'scripts/self-host-e2e.mjs'}:/app/scripts/self-host-e2e.mjs:ro"
      - "{work / 'state'}:/state"
"""
    )
    os.chmod(overlay, 0o600)

    def compose(project, *args, **kw):
        return run(["docker", "compose", "-p", project, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), *args], cwd=ROOT, **kw)

    def e2e(project, phase, *extra):
        out = compose(project, "run", "--rm", "-T", "e2e", phase, "/state/state.json", *extra)
        print(out, end="", flush=True)

    def no_prompt_text(project):
        nonce = json.loads((work / "state/state.json").read_text())["nonce"]
        dump = compose(project, "exec", "-T", "postgres", "pg_dump", "-U", "guard", "-d", "guard")
        assert nonce not in dump and "budget for me" not in dump, "prompt text found in Postgres"
        say(f"ok  Postgres dump ({len(dump)} bytes) holds no prompt text")

    try:
        for project in (PROJECT, RESTORED):
            subprocess.run(["docker", "compose", "-p", project, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "down", "-v", "--remove-orphans"], cwd=ROOT, capture_output=True)
        say("building and starting the stack on clean volumes …")
        compose(PROJECT, "build", "guard")
        compose(PROJECT, "up", "-d", "--wait", "--wait-timeout", "180")
        say(f"stack healthy on 127.0.0.1:{PORT}")
        mode = compose(PROJECT, "exec", "-T", "guard", "stat", "-c", "%a %U", "/data/secrets.env").strip()
        assert mode == "600 node", mode
        say("ok  server secrets generated on first boot in the guard-data volume (600, node)")
        image_env = run(["docker", "image", "inspect", "vibtra-guard:self-host", "--format", "{{json .Config.Env}}"])
        assert "SECRET" not in image_env and "VAULT_KEY" not in image_env, image_env
        listing = run(["docker", "run", "--rm", "--entrypoint", "sh", "vibtra-guard:self-host", "-c", "ls -A /data; test ! -e /app/ee && echo no-ee"]).split()
        assert listing == ["no-ee"], listing
        say("ok  the image carries no secrets, an empty /data and no ee/ directory")
        assert compose(PROJECT, "port", "guard", "4700").strip() == f"127.0.0.1:{PORT}"
        assert subprocess.run(["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "port", "postgres", "5432"], cwd=ROOT, capture_output=True, text=True).stdout.strip() in ("", ":0")
        say("ok  only Guard is published, on loopback")

        e2e(PROJECT, "setup")
        e2e(PROJECT, "personal")
        if GUEST:
            say(f"guest Mac walk on {GUEST} …")
            e2e(PROJECT, "link", "/state/enrol-link")
            walk = subprocess.run(
                ["node", str(ROOT / "scripts/self-host-walk.mjs"), "--guest", GUEST, "--link-file", str(work / "state/enrol-link"), "--host-port", PORT, "--compose-env", str(env), "--project", PROJECT, "--out", str(work / "state/walk.json")],
                cwd=ROOT,
                text=True,
            )
            assert walk.returncode == 0, "the guest Mac walk failed"
            e2e(PROJECT, "activity", "/state/walk.json")
        no_prompt_text(PROJECT)

        say("restart: containers recreated, volumes kept …")
        compose(PROJECT, "down")
        compose(PROJECT, "up", "-d", "--wait", "--wait-timeout", "180")
        e2e(PROJECT, "verify")

        say("backup (docs/self-host.md §Backup) …")
        backup = work / "backup"
        backup.mkdir(mode=0o700)
        with open(backup / "guard-db.dump", "wb") as f:
            subprocess.run(["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "exec", "-T", "postgres", "pg_dump", "-U", "guard", "-d", "guard", "--format=custom"], cwd=ROOT, stdout=f, check=True)
        with open(backup / "secrets.env", "wb") as f:
            subprocess.run(["docker", "compose", "-p", PROJECT, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "exec", "-T", "guard", "cat", "/data/secrets.env"], cwd=ROOT, stdout=f, check=True)
        os.chmod(backup / "secrets.env", 0o600)
        say(f"ok  backup taken: database {os.path.getsize(backup / 'guard-db.dump')} bytes, secrets file {os.path.getsize(backup / 'secrets.env')} bytes")

        say("losing the original stack and its volumes …")
        compose(PROJECT, "down", "-v")
        say("restore into fresh volumes (docs/self-host.md §Restore) …")
        compose(RESTORED, "up", "-d", "--wait", "postgres")
        with open(backup / "guard-db.dump", "rb") as f:
            subprocess.run(["docker", "compose", "-p", RESTORED, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "exec", "-T", "postgres", "pg_restore", "-U", "guard", "-d", "guard", "--no-owner", "--exit-on-error"], cwd=ROOT, stdin=f, check=True)
        refused = subprocess.run(["docker", "compose", "-p", RESTORED, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "run", "--rm", "--no-deps", "-T", "guard"], cwd=ROOT, capture_output=True, text=True)
        assert refused.returncode != 0 and "already holds Guard data" in refused.stderr, refused.stderr[-500:]
        say("ok  without secrets.env the server refuses to mint new keys for the restored database")
        with open(backup / "secrets.env", "rb") as f:
            subprocess.run(["docker", "compose", "-p", RESTORED, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "run", "--rm", "--no-deps", "-T", "--entrypoint", "sh", "guard", "-c", "umask 077 && cat > /data/secrets.env"], cwd=ROOT, stdin=f, check=True)
        compose(RESTORED, "up", "-d", "--wait", "--wait-timeout", "180")
        e2e(RESTORED, "verify")
        no_prompt_text(RESTORED)
        say("PASS: clean-volume install, OIDC sign-in, policy, enrolment, content block, restart, backup and restore")
    finally:
        if KEEP:
            say(f"--keep: projects {PROJECT}/{RESTORED} and {work} left running")
        else:
            for project in (PROJECT, RESTORED):
                subprocess.run(["docker", "compose", "-p", project, "-f", str(COMPOSE), "-f", str(overlay), "--env-file", str(env), "--profile", "e2e", "down", "-v", "--remove-orphans"], cwd=ROOT, capture_output=True)
            shutil.rmtree(work, ignore_errors=True)
            say("removed both projects, their volumes and the work directory")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:  # noqa: BLE001
        print(f"[self-host-proof] FAILED: {error}", file=sys.stderr)
        sys.exit(1)
