#!/usr/bin/env bash
set -Eeuo pipefail

readonly compose_project='heartbeat-vault-ci-smoke'
readonly preview_http_port='28080'
readonly preview_https_port='28443'
readonly compose=(docker compose -p "$compose_project" -f docker-compose.yml)

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  printf '%s\n' 'Docker is unavailable; skipping the disposable Caddy smoke job.'
  exit 0
fi

export APP_ENV=test
export CADDY_BIND_IP=127.0.0.1
export HTTP_PORT="$preview_http_port"
export HTTPS_PORT="$preview_https_port"
# CI-only test key: 64 hex chars decode to exactly 32 bytes, satisfying the
# API's fail-closed MASTER_KEY check. Protects nothing real.
export MASTER_KEY='0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
export POSTGRES_PASSWORD='ci-smoke-password'
export SESSION_SECRET='ci-smoke-session-secret'

cleanup() {
  local status=$?
  "${compose[@]}" down --volumes --remove-orphans

  if docker ps --filter "label=com.docker.compose.project=$compose_project" --format '{{.ID}}' | grep -q .; then
    printf '%s\n' 'Caddy smoke teardown left containers behind.' >&2
    status=1
  else
    printf '%s\n' 'Caddy smoke teardown complete; no preview containers remain.'
  fi

  return "$status"
}
trap cleanup EXIT

wait_for_health() {
  local service=$1
  local container_id
  local health

  for _ in {1..60}; do
    container_id="$("${compose[@]}" ps -q "$service")"
    if [[ -n "$container_id" ]]; then
      health="$(docker inspect --format '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
      case "$health" in
        healthy)
          printf '%s\n' "$service is healthy"
          return 0
          ;;
        unhealthy)
          printf '%s\n' "$service became unhealthy" >&2
          return 1
          ;;
      esac
    fi
    sleep 2
  done

  printf '%s\n' "Timed out waiting for $service health." >&2
  "${compose[@]}" ps
  return 1
}

"${compose[@]}" up --build --detach db api caddy
wait_for_health db
wait_for_health api
wait_for_health caddy
pnpm --filter @heartbeat-vault/e2e test:caddy-smoke
