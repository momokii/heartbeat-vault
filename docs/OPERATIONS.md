# Operations

## Installation

Install Docker Engine with Compose v2, `curl`, and `openssl`, then run from the repository root:

```bash
./install.sh install
```

The installer creates `.env` from `.env.example` when necessary, replaces known placeholders for `MASTER_KEY`, `SESSION_SECRET`, and `POSTGRES_PASSWORD`, sets `.env` to mode `0600`, builds and starts the standard stack, waits for `/api/health`, and prints a one-time setup token. Record that token securely; it grants creation of the first administrator and is shown only at issue time.

The default `--tls internal` mode is appropriate for LAN/on-premise use and may require trusting Caddy's internal CA. `--tls le` and `--tls byo` print the required manual configuration steps because the v1 Caddyfile is static. The hardened Vault/OpenBao profile is deferred and is rejected by the installer.

Use `./install.sh status` to view Compose state and probe API health.

## Bootstrap and routine operation

Open the setup URL printed by the installer, create the first administrator, and preserve the recovery information offered by the application. Once setup completes, `/api/setup` permanently returns `410 Gone`. Create users or invitations, create a switch, add and accept at least one recipient, store a payload, and arm it. See the root [README](../README.md) for the user-facing lifecycle.

The scheduler is part of the API process. Its durable queue and scheduler heartbeat are designed to recover safely after restarts. When diagnosing delayed work, inspect API logs and the health endpoint first:

```bash
docker compose logs api
curl -sk https://127.0.0.1:18443/api/health
```

Port values may differ from the defaults in `.env`.

## Tailnet / bind-IP operation

Default installs are loopback-only (`CADDY_BIND_IP=127.0.0.1` in `.env.example`). To reach the app from other devices on the same Tailnet, run the opt-in helper — it validates the IP, updates `.env`, and restarts the stack:

```bash
scripts/enable-tailnet.sh 100.124.184.116
# equivalent manual form:
# CADDY_BIND_IP=100.124.184.116
# HTTP_PORT=80
# HTTPS_PORT=443
# APP_URL=http://100.124.184.116
# ./install.sh upgrade
scripts/enable-tailnet.sh --revert   # back to 127.0.0.1:18080/18443
```

Verify the binding:

```bash
ss -ltn | grep -E '100\.124\.184\.116:(80|443)[[:space:]]'   # LISTEN present
ss -ltn | grep -E '(0\.0\.0\.0|\[::\]):(80|443)[[:space:]]' || echo "no wildcard binds"
curl -fsS http://100.124.184.116/api/health                  # {"status":"ok"}
CADDY_BASE_URL=http://100.124.184.116 pnpm --filter @heartbeat-vault/e2e test:caddy-smoke
scripts/verify-security.sh                                   # 0 FAIL; ports/bind checks PASS
```

Raw HTTP serves the SPA and health endpoint, but browser sign-in requires HTTPS because the session cookie is `__Host-session` (rejected over plain HTTP). Use `https://100.124.184.116/` with a one-time trust of Caddy's internal CA, or provide a trusted certificate separately; passkeys also require HTTPS. Peer reachability from another Tailnet device must be checked separately — no `tailscale` CLI is assumed on the host.

## Backups and restore

Create a database backup with:

```bash
./install.sh backup
```

Backups are written under `backups/` as compressed SQL and are always encrypted
(`.sql.gz.enc`, AES-256-CBC with PBKDF2). A real `BACKUP_ENCRYPTION_KEY` in `.env`
is required — the installer refuses to create an unencrypted backup. Protect backup
files as sensitive material even when encrypted. Keep the `.env` keys needed to
decrypt application payloads separately from the database backup.

Restore has two explicit modes — there is no bare restore and no way to point a
restore at an arbitrary database:

```bash
# Safe verification: provisions a disposable database, restores into it,
# verifies the data landed, then destroys it. Never touches live data.
./install.sh restore --drill backups/backup-YYYYMMDDTHHMMSSZ.sql.gz.enc --yes

# Disaster recovery only: overwrites the Compose database. Requires --yes
# plus typing the database name at the prompt (60s limit). Read the
# confirmation message carefully and back up first.
./install.sh restore --live backups/backup-YYYYMMDDTHHMMSSZ.sql.gz.enc --yes
```

The drill provisions its own PostgreSQL container with random credentials, recreates
any roles the dump references, checks container and marker identity before and
after streaming, and removes the container plus any decrypted temporary files on
every exit path. Test restoration with `--drill` before relying on a backup.

Drill evidence (2026-10-10, operator run): encrypted backup
`backups/backup-20261009T181400Z.sql.gz.enc` restored into a disposable target
with "Restore complete"; the live database contains no drill markers and its
row counts are unchanged; no containers, ports, plaintext files, or backup
artifacts remained afterward. The first drill attempt failed honestly on a
missing dump-owner role, which led to the role-recreation step above — drills
catch real recovery gaps.

## Upgrade and uninstall

Make a backup before upgrading. Then rebuild the current source and run container-start migrations:

```bash
./install.sh upgrade
```

`./install.sh uninstall --yes` removes containers and database volumes. Adding `--volumes` retains volumes despite the name; without it, the database volume is removed. Read the command's confirmation message carefully and back up first.

## Key and secret handling

Never commit `.env`. `MASTER_KEY` protects encrypted payload envelopes; loss makes those payloads unrecoverable, while exposure can allow a compromised host to decrypt them. `SESSION_SECRET` and `POSTGRES_PASSWORD` are also generated at install time. Use a protected offline copy of required secrets.

The crypto package supports versioned KEKs and rewrapping. Rotation must keep prior versions available until every envelope has been rewrapped; it is not safe to delete an old key merely because a new key was generated. A payload DEK compromise requires payload re-encryption, not just KEK rewrapping.

## Security verification

Run the read-only verifier regularly and after deployment changes:

```bash
scripts/verify-security.sh
scripts/verify-security.sh --json
scripts/verify-security.sh --skip-tests
```

It exits `0` when there are no FAIL results, `1` when at least one check fails, and `2` for invalid usage. WARN means evidence is incomplete or an operator decision is needed; it is expected on a new installation before bootstrap, a stored payload, or backup encryption exist.

## Production checklist

1. Use real generated secrets and restrict `.env` access.
2. Complete bootstrap and confirm it is disabled.
3. Configure certificate handling appropriate to the deployment and expose ports deliberately.
4. Set `BACKUP_ENCRYPTION_KEY`, make a backup, and test a restore.
5. Run the security verifier and investigate every FAIL and relevant WARN.
6. Review active switches, recipients, delivery channels, and grace windows before relying on them.
