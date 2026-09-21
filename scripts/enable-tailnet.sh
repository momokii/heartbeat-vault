#!/usr/bin/env bash
set -u
cd "$(dirname "$0")/.." || exit 2

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/enable-tailnet.sh <tailscale-ip> [--http-port 80] [--https-port 443] [--revert]

  <tailscale-ip>  Single host IP to publish Caddy 80/443 on (e.g. 100.124.184.116).
                  NEVER 0.0.0.0, ::, or a CIDR.
  --http-port     Host HTTP port (default 80).
  --https-port    Host HTTPS port (default 443).
  --revert        Revert to loopback defaults (127.0.0.1:18080/18443).

Default install is loopback-only (CADDY_BIND_IP=127.0.0.1).
This helper is opt-in — run it only when you need Tailnet reachability.
USAGE
  exit 2
}

IP=""
HTTP_PORT=80
HTTPS_PORT=443
REVERT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --http-port) HTTP_PORT="${2:-}"; [ -n "$HTTP_PORT" ] || usage; shift 2 ;;
    --https-port) HTTPS_PORT="${2:-}"; [ -n "$HTTPS_PORT" ] || usage; shift 2 ;;
    --revert) REVERT=1; shift ;;
    -h|--help) usage ;;
    --) shift; break ;;
    -*) usage ;;
    *) [ -z "$IP" ] || usage; IP="$1"; shift ;;
  esac
done

if [ "$REVERT" = 1 ]; then
  IP="127.0.0.1"
  HTTP_PORT=18080
  HTTPS_PORT=18443
  APP_URL="http://localhost:18080"
else
  [ -n "$IP" ] || usage
  case "$IP" in
    '0.0.0.0'|'::'|'*') echo "Refusing wildcard bind: $IP" >&2; exit 2 ;;
    *'/'*) echo "Refusing CIDR: $IP" >&2; exit 2 ;;
  esac
  if ! printf '%s' "$IP" | grep -Eq '^((25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])$' \
    && ! printf '%s' "$IP" | grep -Eq '^[0-9A-Fa-f:.]+:[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*$'; then
    echo "Invalid IP: $IP (expected single IPv4 like 100.x.y.z)" >&2; exit 2
  fi
  APP_URL="http://${IP}"
  if [ "$HTTP_PORT" != 80 ] || [ "$HTTPS_PORT" != 443 ]; then
    # keep URL port-explicit only when non-standard
    APP_URL="http://${IP}:${HTTP_PORT}"
  fi
fi

if [ ! -f .env ]; then
  [ -f .env.example ] || { echo ".env.example missing" >&2; exit 1; }
  cp .env.example .env
  echo "[tailnet] Created .env from .env.example"
fi

set_kv() {
  local k="$1" v="$2"
  if grep -q "^${k}=" .env 2>/dev/null; then
    sed -i.bak "s|^${k}=.*|${k}=${v}|" .env && rm -f .env.bak
  else
    printf '%s=%s\n' "$k" "$v" >> .env
  fi
}

set_kv CADDY_BIND_IP "$IP"
set_kv HTTP_PORT "$HTTP_PORT"
set_kv HTTPS_PORT "$HTTPS_PORT"
set_kv APP_URL "$APP_URL"
chmod 600 .env

echo "[tailnet] .env updated: CADDY_BIND_IP=$IP HTTP_PORT=$HTTP_PORT HTTPS_PORT=$HTTPS_PORT APP_URL=$APP_URL"

if ! bash -n scripts/verify-security.sh 2>/dev/null; then
  echo "[tailnet] verify-security.sh has syntax errors — aborting before restart" >&2; exit 1
fi

echo "[tailnet] Restarting stack to apply new bind..."
./install.sh upgrade
