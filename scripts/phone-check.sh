#!/usr/bin/env bash
# The production build on this machine, reachable over HTTPS from a phone (phase 6 step 7).
# A phone on the LAN over http://<ip> has no secure context: no OPFS, no crypto.subtle (risk 49).
# This starts the server on a throwaway database and a Cloudflare quick tunnel (a random
# https://*.trycloudflare.com URL, public while the script runs). Ctrl-C stops both.
#
#   pnpm --filter @kd-learn/web build && scripts/phone-check.sh
#
# Reads KD_LEARN_SECRET_KEY, the admin and the demo settings from .env when it is there. Nothing
# of .env is printed. The database is deleted when the script stops.
set -euo pipefail
cd "$(dirname "$0")/.."
port="${PHONE_CHECK_PORT:-4180}"
web=apps/web/.output/server/index.mjs
[ -f "$web" ] || { echo "No build: run pnpm --filter @kd-learn/web build first" >&2; exit 1; }
command -v cloudflared >/dev/null || { echo "Needs cloudflared (brew install cloudflared)" >&2; exit 1; }

if [ -f .env ]; then set -a; . ./.env; set +a; fi
db="$(mktemp -d)"
export PORT="$port" KD_LEARN_DB_PATH="$db/phone.db" KD_LEARN_TRUST_PROXY=1
export KD_LEARN_REGISTRATION="${KD_LEARN_REGISTRATION:-open}"
export KD_LEARN_SECRET_KEY="${KD_LEARN_SECRET_KEY:-$(openssl rand -base64 32)}"

cleanup() { kill "${server:-}" "${tunnel:-}" 2>/dev/null || true; rm -rf "$db"; }
trap cleanup EXIT INT TERM
node "$web" >"$db/server.log" 2>&1 &
server=$!
for _ in $(seq 30); do curl -fs "http://localhost:$port/api/config" >/dev/null && break; sleep 1; done

cloudflared tunnel --no-autoupdate --url "http://localhost:$port" >"$db/tunnel.log" 2>&1 &
tunnel=$!
url=""
for _ in $(seq 60); do
  url="$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$db/tunnel.log" | head -1 || true)"
  [ -n "$url" ] && break
  sleep 1
done
[ -n "$url" ] || { echo "The tunnel did not start; see $db/tunnel.log" >&2; exit 1; }
echo "Open on the phone: $url"
echo "Checklist: plan/archive/phase-6.md, step 7. Ctrl-C to stop."
wait "$server"
