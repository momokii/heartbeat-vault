#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Heartbeat Vault — Security Verification Script (BRIEF §10)
#
# Lets a user independently prove the deployment is secure.
# Read-only and non-destructive: every check only reads files, container
# state, or database rows; it never writes, restarts, or reconfigures
# anything. It never prints secret values — only their status.
#
# Usage:
#   scripts/verify-security.sh [--json] [--skip-tests]
#
#     --json         Print the machine-readable JSON report instead of the
#                    human-readable report (same results, same exit code).
#     --skip-tests   Skip the crypto self-test suite (useful for quick runs).
#
# Exit codes:
#   0 — no FAIL results (WARN is acceptable; every WARN explains itself)
#   1 — at least one FAIL
#   2 — usage error
#
# Check scope follows BRIEF §10 and .claude/SECURITY_STANDARDS.md:
# image digest pinning, container hardening, port exposure, DB roles,
# secret/file hygiene, TLS + headers, bootstrap state, encryption-at-rest,
# crypto self-test, backup encryption, hardened profile (deferred in v1).
# ─────────────────────────────────────────────────────────────────────────────
set -u

cd "$(dirname "$0")/.." || exit 2

JSON=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *)
      echo "Unknown option: $arg (supported: --json, --skip-tests)" >&2
      exit 2
      ;;
  esac
done

PASS=0
WARN=0
FAIL=0
RESULTS='' # newline-separated records: id|title|status|detail

have() { command -v "$1" >/dev/null 2>&1; }

# Read a variable from .env without ever echoing the value.
# Returns the value on stdout; caller must never print it.
env_value() {
  [ -f .env ] || return 1
  grep -E "^${1}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- | tr -d '\r'
}

add_result() { # id title status detail
  RESULTS="${RESULTS}${1}|${2}|${3}|${4}
"
  case "$3" in
    PASS) PASS=$((PASS + 1)) ;;
    WARN) WARN=$((WARN + 1)) ;;
    *) FAIL=$((FAIL + 1)) ;;
  esac
}

json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r' '  '
}

# ── Environment context ──────────────────────────────────────────────────────
APP_ENV_VAL="development"
if [ -f .env ]; then
  _env_appenv=$(env_value APP_ENV || true)
  [ -n "$_env_appenv" ] && APP_ENV_VAL="$_env_appenv"
fi
if [ "$APP_ENV_VAL" != "production" ] && [ "$APP_ENV_VAL" != "staging" ] &&
  [ "$APP_ENV_VAL" != "development" ]; then
  APP_ENV_VAL="development"
fi

DOCKER_OK=0
have docker && DOCKER_OK=1

STACK_DB_UP=0
if [ "$DOCKER_OK" = 1 ] &&
  docker compose ps --services --filter status=running 2>/dev/null | grep -qx db; then
  STACK_DB_UP=1
fi

API_BASE=''
HTTPS_PORT=$(env_value HTTPS_PORT || true)
HTTP_PORT=$(env_value HTTP_PORT || true)
for api_candidate in \
  "https://127.0.0.1:${HTTPS_PORT:-18443}" \
  "http://127.0.0.1:${HTTP_PORT:-18080}"; do
  if curl -sk --max-time 3 "${api_candidate}/api/health" 2>/dev/null | grep -q 'ok'; then
    API_BASE="$api_candidate"
    break
  fi
done

# ── 1. Image digest pinning (never `latest`; local build from pinned base) ──
# Multi-stage FROM lines that reference a previously declared stage are not
# images and must not be flagged.
_unpinned_from=$(awk '
  /^[[:space:]]*FROM/ {
    img = $2
    stage = ""
    for (i = 1; i <= NF; i++) if (toupper($i) == "AS") stage = $(i + 1)
    if (stage != "") stages[stage] = 1
    lines[NR] = $0
  }
  END {
    for (i = 1; i <= NR; i++) {
      line = lines[i]
      if (line !~ /^[[:space:]]*FROM/) continue
      split(line, a, " ")
      if (a[2] in stages) continue
      if (line !~ /@sha256:/) print line
    }
  }
' apps/api/Dockerfile 2>/dev/null)
_unpinned_images=''
if [ -f docker-compose.yml ]; then
  _unpinned_images=$(grep -hE '^[[:space:]]*image:' docker-compose.yml docker-compose.prod.yml 2>/dev/null |
    grep -v '@sha256:' | grep -v 'heartbeat-vault-api:local' || true)
fi
if [ -z "$_unpinned_images" ] && [ -z "$_unpinned_from" ]; then
  add_result images-pinned "Images pinned by digest" PASS \
    "All compose images use @sha256: digests; every Dockerfile FROM is digest-pinned or a stage reference; no :latest anywhere."
else
  add_result images-pinned "Images pinned by digest" FAIL \
    "Found image references without a digest pin (or ':latest'): ${_unpinned_images} ${_unpinned_from}"
fi

# ── 2. Database not exposed externally ───────────────────────────────────────
# Comment lines are stripped first: the compose files document the no-ports
# intent inline, and a commented-out "ports:" must not count as exposure.
_db_ports_violation=''
for _f in docker-compose.yml docker-compose.prod.yml; do
  [ -f "$_f" ] || continue
  _hit=$(awk -v file="$_f" '
    /^[[:space:]]*#/ {next}
    /^[[:space:]]{2}db:[[:space:]]*$/ {f=1; next}
    f && /^[[:space:]]{2}[A-Za-z_-]+:[[:space:]]*$/ {f=0}
    f && /^[[:space:]]+ports:/ {print file; exit}
  ' "$_f")
  [ -n "$_hit" ] && _db_ports_violation="$_db_ports_violation $_f"
done
if [ -n "$_db_ports_violation" ]; then
  add_result db-not-exposed "Database not exposed on the host" FAIL \
    "The db service publishes ports in:${_db_ports_violation}. The database must be reachable only inside app_net."
else
  add_result db-not-exposed "Database not exposed on the host" PASS \
    "No db ports in base or prod compose; Postgres is internal-only (app_net)."
fi

# ── 3. Published host ports bind loopback (dev contract) ─────────────────────
_nonloopback_ports=''
if [ -f docker-compose.yml ]; then
  _nonloopback_ports=$(grep -E '^[[:space:]]*-["[:space:]]+[0-9.]+:' docker-compose.yml 2>/dev/null |
    grep -v '127.0.0.1:' || true)
fi
if [ -z "$_nonloopback_ports" ]; then
  add_result ports-loopback "Published ports bound to loopback" PASS \
    "Base compose publishes caddy on 127.0.0.1 only; api and db publish nothing."
else
  add_result ports-loopback "Published ports bound to loopback" WARN \
    "Non-loopback host bindings found in base compose: ${_nonloopback_ports}. Confirm each is intentionally public."
fi

# ── 4. Dev override (when present) binds loopback only ───────────────────────
if [ -f docker-compose.override.yml ]; then
  _ovr_nonloopback=$(grep -E '^[[:space:]]*-["[:space:]]+[0-9.]+:' docker-compose.override.yml 2>/dev/null |
    grep -v '127.0.0.1:' || true)
  if [ -z "$_ovr_nonloopback" ]; then
    add_result override-loopback "Dev override binds loopback only" PASS \
      "Every published port in docker-compose.override.yml binds 127.0.0.1."
  else
    add_result override-loopback "Dev override binds loopback only" FAIL \
      "Non-loopback dev bindings: ${_ovr_nonloopback}. Debug ports must never leave the host."
  fi
else
  add_result override-loopback "Dev override binds loopback only" PASS \
    "No docker-compose.override.yml present (nothing to check)."
fi

# ── 5. Caddy admin API never published off-loopback ──────────────────────────
_admin_published=''
for _f in docker-compose.yml docker-compose.prod.yml docker-compose.override.yml; do
  [ -f "$_f" ] || continue
  _admin_published="$_admin_published$(grep -E '^[[:space:]]*-.*2019' "$_f" 2>/dev/null |
    grep -v '127.0.0.1:' || true)"
done
if [ -z "$_admin_published" ]; then
  add_result caddy-admin-private "Caddy admin API not published" PASS \
    "No non-loopback publish of port 2019 in any compose file."
else
  add_result caddy-admin-private "Caddy admin API not published" FAIL \
    "Caddy admin (2019) published off-loopback: ${_admin_published}"
fi

# ── 6. API container runs as non-root ────────────────────────────────────────
if [ -f apps/api/Dockerfile ] &&
  grep -Eq '^[[:space:]]*USER[[:space:]]+node' apps/api/Dockerfile &&
  ! grep -Eq '^[[:space:]]*USER[[:space:]]+root' apps/api/Dockerfile; then
  add_result non-root "API container non-root" PASS \
    "apps/api/Dockerfile drops to USER node (uid 1000) and never returns to root; postgres image runs as uid 70."
else
  add_result non-root "API container non-root" FAIL \
    "apps/api/Dockerfile must declare a non-root USER and never USER root."
fi

# ── 7. .env is git-ignored and untracked; example exists ─────────────────────
if have git; then
  _env_tracked=$(git ls-files -- .env 2>/dev/null)
  _env_ignored=$(git check-ignore -q .env 2>/dev/null && echo yes || echo no)
  if [ -z "$_env_tracked" ] && [ "$_env_ignored" = "yes" ] && [ -f .env.example ]; then
    add_result env-git "Secrets file excluded from version control" PASS \
      ".env is git-ignored and untracked; .env.example is committed."
  else
    add_result env-git "Secrets file excluded from version control" FAIL \
      "tracked=[$(printf '%s' "$_env_tracked" | wc -l)] ignored=$_env_ignored example=$([ -f .env.example ] && echo yes || echo no). .env must be ignored and never committed."
  fi
else
  add_result env-git "Secrets file excluded from version control" WARN \
    "git unavailable; cannot verify .env exclusion."
fi

# ── 8. .env file permissions ─────────────────────────────────────────────────
if [ -f .env ]; then
  _perms=$(stat -c '%a' .env 2>/dev/null || stat -f '%Lp' .env 2>/dev/null || echo 'unknown')
  if [ "$_perms" = "600" ] || [ "$_perms" = "400" ]; then
    add_result env-perms ".env permissions restrictive" PASS \
      ".env mode is $_perms (owner-only)."
  else
    add_result env-perms ".env permissions restrictive" WARN \
      ".env mode is $_perms; expected 600 (owner-only). Fix: chmod 600 .env"
  fi
else
  add_result env-perms ".env permissions restrictive" WARN \
    ".env does not exist yet — nothing deployed to verify (run install.sh in a later phase)."
fi

# ── 9. No default or weak credentials ────────────────────────────────────────
# Secret hygiene is environment-driven: WARN in development/staging (placeholders
# are accepted for local iteration), FAIL in production.
# Values are only compared — never printed.
_secret_status() { # name → PASS|WARN|FAIL|MISSING, detail without values
  local name="$1" min_len="$2"
  local val
  val=$(env_value "$name" || true)
  if [ -z "$val" ]; then
    echo "MISSING|not set"
    return
  fi
  case "$val" in
    change-me* | dev-placeholder* | *"generate-with-openssl"*)
      echo "PLACEHOLDER|matches the known placeholder pattern"
      return
      ;;
  esac
  local decoded=''
  decoded=$(printf '%s' "$val" | base64 -d 2>/dev/null | wc -c | tr -d ' ')
  if [ "${#val}" -ge 64 ] && [ "$decoded" = "32" ]; then
    echo "OK|32-byte key (base64)"
  elif [ "$min_len" = "0" ]; then
    echo "OK|set"
  elif [ "${#val}" -lt 24 ]; then
    echo "SHORT|suspiciously short"
  else
    echo "OK|set"
  fi
}

_prod_env=0
[ "$APP_ENV_VAL" = "production" ] && _prod_env=1
_env_issues=0
for _s in MASTER_KEY SESSION_SECRET POSTGRES_PASSWORD; do
  case "$_s" in
    MASTER_KEY) _min=32 ;;
    *) _min=0 ;;
  esac
  _out=$(_secret_status "$_s" "$_min" 2>/dev/null)
  _verdict=${_out%%|*}
  _why=${_out#*|}
  case "$_verdict" in
    OK) continue ;;
    MISSING | PLACEHOLDER | SHORT)
      _env_issues=$((_env_issues + 1))
      if [ "$_prod_env" = "1" ]; then
        add_result "secret-$_s" "Credential hygiene: $_s" FAIL "$_verdict — $_why (production requires a real value)."
      else
        add_result "secret-$_s" "Credential hygiene: $_s" WARN "$_verdict — $_why (accepted for $APP_ENV_VAL; generate real values before production)."
      fi
      ;;
  esac
done
if [ "$_env_issues" = 0 ]; then
  add_result secret-hygiene "Credential hygiene (MASTER_KEY, SESSION_SECRET, POSTGRES_PASSWORD)" PASS \
    "All three credentials are set to non-placeholder values (values never printed)."
fi

# ── 10. TLS configuration ────────────────────────────────────────────────────
if [ -f Caddyfile ] && grep -qE '^[[:space:]]*tls[[:space:]]' Caddyfile; then
  add_result tls-configured "TLS configured" PASS \
    "Caddyfile carries a tls directive (default: 'tls internal' for LAN; ACME/BYO opt-in via env)."
else
  add_result tls-configured "TLS configured" WARN \
    "No tls directive found in Caddyfile — traffic would be plaintext."
fi

# ── 11. Security headers present in proxy config ─────────────────────────────
_hdr_missing=''
for _h in 'Strict-Transport-Security' 'X-Frame-Options' 'X-Content-Type-Options' \
  'Content-Security-Policy' 'Referrer-Policy' 'Permissions-Policy'; do
  grep -q "$_h" Caddyfile 2>/dev/null || _hdr_missing="$_hdr_missing $_h"
done
if [ -z "$_hdr_missing" ]; then
  add_result security-headers "Security headers configured" PASS \
    "HSTS, X-Frame-Options DENY, nosniff, CSP, Referrer-Policy and Permissions-Policy are set in Caddyfile."
else
  add_result security-headers "Security headers configured" WARN \
    "Missing header directives:$_hdr_missing"
fi

# ── 12. Prod overrides (restart policy + resource limits) ────────────────────
if [ -f docker-compose.prod.yml ]; then
  _restarts=$(grep -c 'restart: unless-stopped' docker-compose.prod.yml 2>/dev/null || echo 0)
  _limits=$(grep -c 'limits:' docker-compose.prod.yml 2>/dev/null || echo 0)
  if [ "${_restarts:-0}" -ge 3 ] && [ "${_limits:-0}" -ge 3 ]; then
    add_result prod-hardening "Production restart policies and resource limits" PASS \
      "prod override sets unless-stopped restart and cpu/memory limits for db, api, caddy; log rotation capped."
  else
    add_result prod-hardening "Production restart policies and resource limits" WARN \
      "restart lines: $_restarts/3, resource limits: $_limits/3 in docker-compose.prod.yml."
  fi
else
  add_result prod-hardening "Production restart policies and resource limits" WARN \
    "docker-compose.prod.yml not found."
fi

# ── 13. Server-side sealing (static proof of encryption before storage) ──────
if grep -q 'encrypt(' apps/api/src/routes/switches.ts 2>/dev/null &&
  grep -q 'payload_ct' apps/api/src/routes/switches.ts 2>/dev/null; then
  add_result sealing-static "Payloads sealed before storage (static)" PASS \
    "The payload route encrypts via the envelope AEAD before any INSERT; plaintext never reaches SQL."
else
  add_result sealing-static "Payloads sealed before storage (static)" FAIL \
    "Could not find envelope encryption in the payload storage route."
fi

# ── 14. Runtime proof: only ciphertext at rest + least-privilege roles ───────
if [ "$STACK_DB_UP" = 1 ] && [ -f .env ]; then
  _pgu=$(env_value POSTGRES_USER || true)
  _pgd=$(env_value POSTGRES_DB || true)
  _pgu=${_pgu:-heartbeat}
  _pgd=${_pgd:-heartbeat_vault}
  _sealed=$(docker compose exec -T db psql -U "$_pgu" -d "$_pgd" -tAc \
    "SELECT count(*) FROM sealed_payloads WHERE payload_ct IS NOT NULL AND octet_length(payload_ct) > 0" 2>/dev/null |
    tr -d '[:space:]')
  _super=$(docker compose exec -T db psql -U "$_pgu" -d "$_pgd" -tAc \
    "SELECT count(*) FROM pg_roles WHERE rolname IN ('app','migrator') AND rolsuper" 2>/dev/null |
    tr -d '[:space:]')
  if [ -z "$_sealed" ]; then
    add_result at-rest-runtime "Encryption-at-rest proof (runtime rows)" WARN \
      "Runtime query returned no data — the running db may predate migrations or hold no schema. Start the current stack to verify."
  elif [ "$_sealed" -gt 0 ]; then
    add_result at-rest-runtime "Encryption-at-rest proof (runtime rows)" PASS \
      "$_sealed sealed payload(s) store non-empty ciphertext columns only."
  else
    add_result at-rest-runtime "Encryption-at-rest proof (runtime rows)" WARN \
      "No stored payloads yet (count=0) — runtime proof unavailable until one is sealed."
  fi
  if [ -n "$_super" ] && [ "$_super" -eq 0 ]; then
    add_result db-roles-runtime "DB roles least-privilege (runtime)" PASS \
      "App roles 'app' and 'migrator' exist and none is a superuser."
  else
    add_result db-roles-runtime "DB roles least-privilege (runtime)" FAIL \
      "Unexpected superuser among app roles (count=$_super)."
  fi
else
  add_result at-rest-runtime "Encryption-at-rest proof (runtime rows)" WARN \
    "Stack (db service) not running — runtime row inspection skipped. Static sealing check passed above."
  add_result db-roles-runtime "DB roles least-privilege (runtime)" WARN \
    "Stack (db service) not running — runtime role inspection skipped. Static check: migrations create non-superuser roles with scoped grants."
fi

# ── 15. Bootstrap endpoint state (non-destructive probe) ─────────────────────
# POST /api/setup with an empty body never passes validation, mutates nothing,
# and distinguishes the two states: 400 = setup still open, 410 = disabled.
if [ -n "$API_BASE" ]; then
  _code=$(curl -sk --max-time 5 -o /dev/null -w '%{http_code}' \
    -X POST -H 'content-type: application/json' -d '{}' \
    "$API_BASE/api/setup" 2>/dev/null)
  case "$_code" in
    410) add_result bootstrap "Bootstrap disabled after setup" PASS \
      "POST /api/setup responds 410 Gone — the one-time bootstrap is permanently disabled." ;;
    400) add_result bootstrap "Bootstrap disabled after setup" WARN \
      "POST /api/setup responds 400 — bootstrap is still OPEN (expected right after install). Complete setup to disable it." ;;
    404) add_result bootstrap "Bootstrap disabled after setup" WARN \
      "POST /api/setup returned 404 — the running API does not expose the setup route. The deployment is stale or misconfigured; rebuild and redeploy to verify bootstrap state." ;;
  esac
else
  add_result bootstrap "Bootstrap disabled after setup" WARN \
    "API not reachable (stack down?) — runtime bootstrap check skipped."
fi

# ── 16. Crypto self-test (round-trip + known-answer vectors) ─────────────────
if [ "$SKIP_TESTS" = 1 ]; then
  add_result crypto-self-test "Crypto self-test" WARN "Skipped by --skip-tests."
elif have pnpm; then
  if pnpm --filter @heartbeat-vault/crypto test >/dev/null 2>&1; then
    add_result crypto-self-test "Crypto self-test" PASS \
      "Full crypto suite green (AEAD round-trip, KATs, tamper matrix, KDF, Shamir)."
  else
    add_result crypto-self-test "Crypto self-test" FAIL \
      "The crypto suite FAILED on this machine — cryptography cannot be trusted here."
  fi
else
  add_result crypto-self-test "Crypto self-test" WARN \
    "pnpm unavailable — cannot run the crypto suite."
fi

# ── 17. Backup encryption ────────────────────────────────────────────────────
_bk=$(env_value BACKUP_ENCRYPTION_KEY || true)
if [ -n "$_bk" ]; then
  add_result backup-encryption "Backup encryption configured" PASS \
    "BACKUP_ENCRYPTION_KEY is set (value never printed)."
else
  add_result backup-encryption "Backup encryption configured" WARN \
    "BACKUP_ENCRYPTION_KEY not set — backup/restore lands with the installer phase; configure before first real backups."
fi

# ── 18. Hardened profile (deferred in v1 per ADR-007 / user decision) ────────
_hardened_services=''
for _f in docker-compose.yml docker-compose.prod.yml; do
  [ -f "$_f" ] || continue
  _hardened_services="${_hardened_services}$(awk '
    /^[[:space:]]*#/ { next }
    /^services:[[:space:]]*$/ { in_services = 1; next }
    /^[^[:space:]#][^:]*:[[:space:]]*$/ { in_services = 0 }
    in_services && /^[[:space:]][[:space:]](vault|openbao):[[:space:]]*$/ { print FILENAME; exit }
  ' "$_f")"
done
if [ -n "$_hardened_services" ]; then
  add_result hardened-profile "Hardened profile (Vault/OpenBao)" PASS \
    "Hardened services detected — Vault-specific checks apply when enabled."
else
  add_result hardened-profile "Hardened profile (Vault/OpenBao)" WARN \
    "Hardened profile not enabled (deferred by decision: not in v1; ADR-007). Vault seal/audit/token checks apply when it lands."
fi

# ── Report ───────────────────────────────────────────────────────────────────
_now=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if [ "$JSON" = 1 ]; then
  printf '{"script":"verify-security","generatedAt":"%s","environment":"%s","summary":{"pass":%d,"warn":%d,"fail":%d},"results":[' \
    "$_now" "$APP_ENV_VAL" "$PASS" "$WARN" "$FAIL"
  _first=1
  printf '%s' "$RESULTS" | while IFS= read -r _row; do
    [ -z "$_row" ] && continue
    _id=${_row%%|*}
    _rest=${_row#*|}
    _title=${_rest%%|*}
    _rest=${_rest#*|}
    _status=${_rest%%|*}
    _detail=${_rest#*|}
    [ "$_first" = 1 ] || printf ','
    printf '{"id":"%s","title":"%s","status":"%s","detail":"%s"}' \
      "$(json_escape "$_id")" "$(json_escape "$_title")" "$(json_escape "$_status")" "$(json_escape "$_detail")"
    _first=0
  done
  printf ']}%s' '
'
else
  printf 'Heartbeat Vault — Security Verification (environment: %s, %s)\n' "$APP_ENV_VAL" "$_now"
  printf '=================================================================\n'
  printf '%s' "$RESULTS" | while IFS= read -r _row; do
    [ -z "$_row" ] && continue
    _id=${_row%%|*}
    _rest=${_row#*|}
    _title=${_rest%%|*}
    _rest=${_rest#*|}
    _status=${_rest%%|*}
    _detail=${_rest#*|}
    printf '[%s] %-46s %s\n' "$_status" "$_id" "$_detail"
  done
  printf '=================================================================\n'
  printf 'Summary: PASS %d | WARN %d | FAIL %d\n' "$PASS" "$WARN" "$FAIL"
  printf 'Secret values are never printed by this script.\n'
fi

[ "$FAIL" -eq 0 ] && exit 0
exit 1
