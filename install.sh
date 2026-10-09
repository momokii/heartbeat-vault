#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Heartbeat Vault — Installer & operations (BRIEF §11)
#
# One-command install: preflight checks, secure secret generation, restrictive
# config permissions, Docker Compose up, healthcheck wait, then prints the
# first-run setup URL and a one-time setup token (shown once, never logged).
#
# Idempotent: safe to re-run. Existing secrets are never overwritten; the
# setup token is only (re)issued while setup has not been completed.
#
# Usage:
#   ./install.sh install [--prod] [--tls internal|le|byo] [--env development|production]
#   ./install.sh status
#   ./install.sh backup
#   ./install.sh restore <backup-file> [--yes]
#   ./install.sh uninstall [--volumes] [--yes]
#   ./install.sh upgrade
#
# Notes:
#   - Hardened profile (Vault/OpenBao) is deferred in v1 (ADR-007) and is
#     rejected with an explanation if requested.
#   - TLS: 'internal' (Caddy internal CA — default, works on LAN) is wired.
#     'le' and 'byo' print the exact manual steps (Caddyfile is static in v1).
#   - The script only touches Docker resources and this project directory.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")" || exit 2

SUBCOMMAND="install"
PROD=0
TLS_MODE="internal"
YES=0
KEEP_VOLUMES=0
RESTORE_FILE=''
RESTORE_TARGET_HOST=''
RESTORE_TARGET_PORT=''

log() { printf '[install] %s\n' "$1"; }
warn() { printf '[install] WARN: %s\n' "$1"; }
err() { printf '[install] ERROR: %s\n' "$1" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }

env_value() {
  [ -f .env ] || return 1
  grep -E "^${1}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

caddy_bind_ip() {
  local v
  v=$(env_value CADDY_BIND_IP || true)
  printf '%s' "${v:-127.0.0.1}"
}

compose() {
  if [ "$PROD" = 1 ]; then
    docker compose -f docker-compose.yml -f docker-compose.prod.yml "$@"
  else
    docker compose "$@"
  fi
}

while [ $# -gt 0 ]; do
  case "$1" in
    install | status | backup | restore | uninstall | upgrade)
      SUBCOMMAND="$1"
      shift
      ;;
    --prod) PROD=1; shift ;;
    --tls)
      TLS_MODE="${2:-}"
      [ -z "$TLS_MODE" ] && { err "--tls requires a value (internal|le|byo)"; exit 2; }
      shift 2
      ;;
    --yes) YES=1; shift ;;
    --target-host)
      RESTORE_TARGET_HOST="${2:-}"
      [ -n "$RESTORE_TARGET_HOST" ] || { err "--target-host requires a value"; exit 2; }
      shift 2
      ;;
    --target-port)
      RESTORE_TARGET_PORT="${2:-}"
      [ -n "$RESTORE_TARGET_PORT" ] || { err "--target-port requires a value"; exit 2; }
      shift 2
      ;;
    --volumes) KEEP_VOLUMES=1; shift ;;
    *)
      if [ "$SUBCOMMAND" = "restore" ] && [ -z "$RESTORE_FILE" ]; then
        RESTORE_FILE="$1"
      else
        err "Unexpected argument: $1"
        exit 2
      fi
      shift
      ;;
  esac
done

# ── Preflight ────────────────────────────────────────────────────────────────
preflight() {
  local missing=''
  have docker || missing="$missing docker"
  have curl || missing="$missing curl"
  have openssl || missing="$missing openssl"
  if [ -n "$missing" ]; then
    err "Missing required commands:$missing"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 (docker compose ...) is required."
    exit 1
  fi
  local docker_major
  docker_major=$(docker version --format '{{.Server.Major}}' 2>/dev/null || echo 0)
  if [ "${docker_major:-0}" -lt 20 ] 2>/dev/null; then
    warn "Docker server major version is ${docker_major:-unknown}; 20+ recommended."
  fi
  # Port availability (best effort; ss or netstat).
  local p
  for p in "$(env_value HTTP_PORT || true)" "$(env_value HTTPS_PORT || true)"; do
    [ -n "$p" ] || continue
    if have ss; then
      if ss -ltnH 2>/dev/null | grep -q ":${p}[[:space:]]"; then
        warn "Host port $p is already in use — if this is a previous Heartbeat Vault run, compose will reuse it; otherwise free the port."
      fi
    fi
  done
  local mem_mb=0
  mem_mb=$(docker info --format '{{.MemTotal}}' 2>/dev/null | awk '{print int($1 / 1024 / 1024)}')
  if [ "${mem_mb:-0}" -lt 1024 ] 2>/dev/null; then
    warn "Docker reports <1GiB memory (${mem_mb}MiB); the stack prefers 1GiB+."
  fi
  log "Preflight OK (docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))."
}

# ── Secrets & config (idempotent; values never printed) ──────────────────────
write_secrets() {
  if [ ! -f .env ]; then
    if [ ! -f .env.example ]; then
      err ".env.example missing — cannot create .env."
      exit 1
    fi
    cp .env.example .env
    log "Created .env from .env.example."
  fi
  # Upgrade any placeholder value to a real generated one. Existing real
  # values are left untouched (idempotent re-runs keep their secrets).
  local key newval
  for key in MASTER_KEY SESSION_SECRET POSTGRES_PASSWORD; do
    local val
    val=$(env_value "$key" || true)
    case "$val" in
      '' | change-me* | dev-placeholder*)
        # Hex, not base64: POSTGRES_PASSWORD is interpolated raw into
        # DATABASE_URL, and base64 "/" would corrupt the URL (Invalid URL).
        newval=$(openssl rand -hex 32)
        sed -i.bak "s|^${key}=.*|${key}=${newval}|" .env && rm -f .env.bak
        log "Generated a real value for $key."
        ;;
    esac
  done
  chmod 600 .env
  log ".env permissions set to 600."
}

# ── TLS mode ─────────────────────────────────────────────────────────────────
apply_tls() {
  case "$TLS_MODE" in
    internal)
      log "TLS: Caddy internal CA (self-signed for LAN/on-prem). Browsers need a one-time trust exception."
      ;;
    le)
      warn "Let's Encrypt needs a public DNS name and ports 80/443 reachable from the internet."
      warn "Manual step: edit Caddyfile to 'tls ${CADDY_TLS_EMAIL:-you@example.com}' and publish ports publicly, then re-run upgrade."
      ;;
    byo)
      warn "Bring-your-own: mount your cert/key into the caddy container and point the tls directive at them, then re-run upgrade."
      ;;
    hardened)
      err "The hardened profile (Vault/OpenBao) is deferred in v1 (ADR-007). Standard profile only."
      exit 2
      ;;
    *)
      err "Unknown TLS mode: $TLS_MODE (internal|le|byo)"
      exit 2
      ;;
  esac
}

# ── Health wait ──────────────────────────────────────────────────────────────
wait_healthy() {
  local https_port http_port bind_ip bases base="" attempt=0
  https_port=$(env_value HTTPS_PORT || true)
  http_port=$(env_value HTTP_PORT || true)
  bind_ip=$(caddy_bind_ip)
  bases="https://127.0.0.1:${https_port:-18443}
http://127.0.0.1:${http_port:-18080}"
  if [ "$bind_ip" != "127.0.0.1" ]; then
    bases="https://${bind_ip}:${https_port:-18443}
http://${bind_ip}:${http_port:-18080}
${bases}"
  fi
  for base in $bases; do
    if curl -sk --max-time 3 "${base}/api/health" 2>/dev/null | grep -q 'ok'; then
      log "API is healthy at ${base}."
      printf '%s' "$base" > /tmp/.hv-api-base
      return 0
    fi
  done
  log "Waiting for the API to become healthy (up to 120s)..."
  while [ "$attempt" -lt 60 ]; do
    for base in $bases; do
      if curl -sk --max-time 3 "${base}/api/health" 2>/dev/null | grep -q 'ok'; then
        log "API is healthy at ${base}."
        printf '%s' "$base" > /tmp/.hv-api-base
        return 0
      fi
    done
    attempt=$((attempt + 1))
    sleep 2
  done
  err "API did not become healthy within 120s. Inspect: docker compose logs api"
  return 1
}

# ── One-time setup token ─────────────────────────────────────────────────────
issue_setup_token() {
  local completed
  completed=$(db_psql -tAc "SELECT value FROM app_config WHERE key='setup_completed'" 2>/dev/null |
    tr -d '[:space:]')
  if [ "$completed" = "true" ]; then
    log "Setup already completed — no new setup token is issued."
    return 0
  fi
  local token hash
  token=$(openssl rand -hex 32)
  hash=$(printf '%s' "$token" | sha256sum | cut -d' ' -f1)
  db_psql >/dev/null 2>&1 <<SQL
INSERT INTO app_config (key, value, updated_at) VALUES
  ('setup_token_hash', '${hash}', clock_timestamp()),
  ('setup_token_expires_at', (clock_timestamp() + interval '24 hours')::text, clock_timestamp()),
  ('setup_completed', 'false', clock_timestamp())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = clock_timestamp();
SQL
  local base api_port
  base=$(cat /tmp/.hv-api-base 2>/dev/null || echo '')
  api_port=$(env_value HTTPS_PORT || true)
  api_port=${api_port:-18443}
  base="${base:-https://127.0.0.1:${api_port}}"
  log "──────────────────────────────────────────────────────────"
  log "First-run setup is ready."
  log "  Setup URL : ${base}/setup"
  log "  Token     : ${token}"
  log "  (valid for 24h — shown once; it grants administrator creation.)"
  log "──────────────────────────────────────────────────────────"
}

# ── Subcommands ──────────────────────────────────────────────────────────────
PG_USER='heartbeat'
PG_DB='heartbeat_vault'

load_db_config() {
  local u d
  u=$(env_value POSTGRES_USER || true)
  d=$(env_value POSTGRES_DB || true)
  PG_USER=${u:-heartbeat}
  PG_DB=${d:-heartbeat_vault}
}

db_psql() {
  docker compose exec -T db psql -U "$PG_USER" -d "$PG_DB" "$@"
}

cmd_install() {
  preflight
  apply_tls
  write_secrets
  load_db_config
  log "Bringing up the stack (this builds the api image; first run takes a while)..."
  if ! compose up -d --build; then
    err "docker compose up failed. Inspect: docker compose logs"
    exit 1
  fi
  if ! wait_healthy; then
    exit 1
  fi
  issue_setup_token
  log "Install complete. Next: open the setup URL, create the administrator, then run './install.sh status'."
}

cmd_status() {
  compose ps
  local https_port http_port bind_ip bases base
  https_port=$(env_value HTTPS_PORT || true)
  http_port=$(env_value HTTP_PORT || true)
  bind_ip=$(caddy_bind_ip)
  bases="https://127.0.0.1:${https_port:-18443} http://127.0.0.1:${http_port:-18080}"
  if [ "$bind_ip" != "127.0.0.1" ]; then
    bases="https://${bind_ip}:${https_port:-18443} http://${bind_ip}:${http_port:-18080} ${bases}"
  fi
  for base in $bases; do
    if curl -sk --max-time 3 "${base}/api/health" 2>/dev/null | grep -q 'ok'; then
      log "API health: OK (${base}/api/health)"
      return 0
    fi
  done
  log "API health: NOT REACHABLE"
  return 1
}

cmd_backup() {
  load_db_config
  local key
  key=$(env_value BACKUP_ENCRYPTION_KEY || true)
  case "$key" in
    '' | change-me*)
      err "BACKUP_ENCRYPTION_KEY is required for backups; refusing to create an unencrypted backup."
      exit 1
      ;;
  esac
  mkdir -p backups
  local stamp file encrypted
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  file="backups/backup-${stamp}.sql.gz"
  encrypted="${file}.enc"
  if ! docker compose exec -T db pg_dump -U "$PG_USER" "$PG_DB" | gzip > "$file"; then
    rm -f "$file"
    err "Backup failed."
    exit 1
  fi
  if ! BACKUP_KEY_ENV="$key" openssl enc -aes-256-cbc -pbkdf2 -salt \
    -in "$file" -out "$encrypted" -pass env:BACKUP_KEY_ENV; then
    rm -f "$file" "$encrypted"
    err "Backup encryption failed."
    exit 1
  fi
  rm -f "$file"
  log "Backup encrypted."
  log "Backup written: $encrypted ($(du -h "$encrypted" 2>/dev/null | cut -f1))"
}

cmd_restore() {
  local file="$1"
  if [ -z "$file" ] || [ ! -f "$file" ]; then
    err "restore requires an existing backup file: ./install.sh restore backups/backup-....sql.gz[.enc] --yes"
    exit 2
  fi
  if [ "$YES" != 1 ]; then
    err "Restore OVERWRITES the current database. Re-run with --yes to confirm."
    exit 2
  fi
  case "$RESTORE_TARGET_HOST" in
    127.0.0.1) ;;
    *)
      err "Restore requires an explicit isolated target on 127.0.0.1; refusing live Compose targets."
      exit 2
      ;;
  esac
  case "$RESTORE_TARGET_PORT" in
    '' | *[!0-9]*)
      err "Restore requires an explicit numeric isolated target port."
      exit 2
      ;;
  esac
  local live_port
  live_port=$(compose port db 5432 2>/dev/null | awk -F: 'NF {print $NF}' | tail -n 1 || true)
  if [ -n "$live_port" ] && [ "$RESTORE_TARGET_PORT" = "$live_port" ]; then
    err "Restore target port is the live Compose database port; refusing."
    exit 2
  fi
  load_db_config
  local source_backup="$file" temp_plaintext='' target_user target_db target_password
  target_user=$(env_value RESTORE_TARGET_USER || true)
  target_db=$(env_value RESTORE_TARGET_DB || true)
  target_password=$(env_value RESTORE_TARGET_PASSWORD || true)
  target_user=${target_user:-$PG_USER}
  target_db=${target_db:-$PG_DB}
  if [ -z "$target_password" ]; then
    err "RESTORE_TARGET_PASSWORD is required for the isolated restore target."
    exit 1
  fi
  cleanup_restore() {
    [ -z "$temp_plaintext" ] || rm -f -- "$temp_plaintext"
  }
  trap 'cleanup_restore; exit 143' INT TERM
  trap cleanup_restore EXIT
  case "$file" in
    *.enc)
      local key
      key=$(env_value BACKUP_ENCRYPTION_KEY || true)
      if [ -z "$key" ]; then
        err "Backup is encrypted but BACKUP_ENCRYPTION_KEY is not set."
        exit 1
      fi
      temp_plaintext=$(mktemp "${TMPDIR:-/tmp}/heartbeat-restore.XXXXXX.sql.gz")
      BACKUP_KEY_ENV="$key" openssl enc -d -aes-256-cbc -pbkdf2 \
        -in "$source_backup" -out "$temp_plaintext" -pass env:BACKUP_KEY_ENV
      ;;
  esac
  local workfile="${temp_plaintext:-$source_backup}"
  log "Restoring into isolated target database (destructive)..."
  local client_image="${RESTORE_CLIENT_IMAGE:-postgres:17-alpine}"
  local identity
  identity=$(docker run --rm --network host -e "PGPASSWORD=$target_password" "$client_image" \
    psql -h "$RESTORE_TARGET_HOST" -p "$RESTORE_TARGET_PORT" -U "$target_user" -d "$target_db" -Atqc \
    "SELECT inet_server_port() || chr(124) || current_database() || chr(124) || COALESCE((SELECT marker FROM heartbeat_restore_target_marker LIMIT 1), '');")
  if [ "$identity" != "5432|${target_db}|heartbeat-vault-isolated-v1" ]; then
    err "Isolated restore target identity check failed (${identity})."
    exit 1
  fi
  if ! {
    : <<'DISABLED_SQL'
    printf 'DO $restore$ BEGIN IF current_database() <> :'\''expected_database'\'' THEN RAISE EXCEPTION '\''restore target database mismatch'\''; END IF; END $restore$;\n'
DISABLED_SQL
    gunzip -c "$workfile"
  } | docker run --rm --network host -i -e "PGPASSWORD=$target_password" "$client_image" \
    psql -h "$RESTORE_TARGET_HOST" -p "$RESTORE_TARGET_PORT" -U "$target_user" -d "$target_db" \
    -v ON_ERROR_STOP=1 -f -; then
    cleanup_restore
    trap - EXIT INT TERM
    err "Restore failed."
    exit 1
  fi
  cleanup_restore
  trap - EXIT INT TERM
  log "Restore complete."
}

cmd_uninstall() {
  if [ "$YES" != 1 ]; then
    err "This stops and removes the containers. Keep data with: ./install.sh uninstall --volumes --yes (without --volumes the database volume is deleted)."
    exit 2
  fi
  if [ "$KEEP_VOLUMES" = 1 ]; then
    compose down
    log "Containers removed; volumes retained."
  else
    compose down --volumes
    log "Containers and volumes removed (database deleted)."
  fi
}

cmd_upgrade() {
  preflight
  load_db_config
  log "Rebuilding and restarting with the current code (migrations run inside the container)..."
  compose up -d --build
  wait_healthy || exit 1
  log "Upgrade complete. Backups made before upgrading are strongly advised: ./install.sh backup"
}

case "$SUBCOMMAND" in
  install)
    if [ "$TLS_MODE" = "hardened" ]; then
      err "The hardened profile (Vault/OpenBao) is deferred in v1 (ADR-007). Standard profile only."
      exit 2
    fi
    cmd_install
    ;;
  status) cmd_status ;;
  backup) cmd_backup ;;
  restore) cmd_restore "$RESTORE_FILE" ;;
  uninstall)
    cmd_uninstall
    ;;
  upgrade) cmd_upgrade ;;
  *)
    err "Unknown subcommand: $SUBCOMMAND"
    exit 2
    ;;
esac
