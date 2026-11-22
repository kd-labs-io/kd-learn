#!/usr/bin/env bash
# Smoke test of the Compose stack (plan step 9): build, start, wait for the healthcheck, sign in
# as the first admin, keep data across down and up (volume), and run the backup and restore
# commands of docs/deploy.md. Uses a throwaway env file, project and volume; prints no secret.
set -euo pipefail
cd "$(dirname "$0")/.."

project=kd-learn-smoke
port=${KD_LEARN_PORT:-3999}
base="http://127.0.0.1:$port"
work=$(mktemp -d)
email=admin@smoke.test
password=$(openssl rand -hex 16)
cat >"$work/env" <<ENV
KD_LEARN_SECRET_KEY=$(openssl rand -base64 32)
KD_LEARN_ADMIN_EMAIL=$email
KD_LEARN_ADMIN_PASSWORD=$password
SEARXNG_SECRET=$(openssl rand -hex 16)
ENV

compose() { KD_LEARN_ENV_FILE=$work/env KD_LEARN_PORT=$port docker compose -p "$project" "$@"; }
cleanup() {
  local status=$?
  # The server log on failure only. It holds no secret (checked below on success).
  [ "$status" -eq 0 ] || compose logs --no-color web 2>/dev/null | tail -n 40 || true
  compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
fail() { echo "$1" >&2; exit 1; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(eval("JSON.parse(s)"+process.argv[1])))' "$1"; }

token() {
  curl -fsS -X POST "$base/api/auth/login" -H 'content-type: application/json' \
    --data "{\"email\":\"$email\",\"password\":\"$password\"}" | json .token
}
sessions() {
  curl -fsS "$base/api/account/sessions" -H "authorization: Bearer $(token)" | json .sessions.length
}
restart() {
  compose down >/dev/null 2>&1
  compose up -d --wait --wait-timeout 60 >/dev/null 2>&1
}

compose up -d --build --wait --wait-timeout 120
curl -fsS "$base/api/config" | grep -q '"accounts":true' || fail 'accounts are off'
echo 'healthy, accounts on'
token >/dev/null || fail 'admin sign-in failed'
echo 'admin signed in'

# SearXNG answers JSON on the internal network (no published port).
compose exec -T web node -e "fetch(process.env.KD_SEARXNG_URL+'/search?q=test&format=json').then(r=>{if(r.status!==200)process.exit(1);console.log('searxng json ok')})" \
  || fail 'searxng is not reachable from the web service'

# An uploaded PDF is read by the ingest job in a worker thread (pdfjs traced into the image).
curl -fsS -o /dev/null -X POST "$base/api/account/sources" -H "authorization: Bearer $(token)" \
  -F 'file=@packages/server/test/fixtures/pdf/vi-5pages.pdf;type=application/pdf'
for _ in $(seq 1 30); do
  state=$(curl -fsS "$base/api/account/sources" -H "authorization: Bearer $(token)" | json '.sources[0].state')
  [ "$state" = pending ] || break
  sleep 1
done
[ "$state" = ready ] || fail "the PDF was not read (state: $state)"
echo 'PDF read in the image'

curl -fsS -o /dev/null -X POST "$base/api/account/sessions" -H "authorization: Bearer $(token)" \
  -H 'content-type: application/json' --data '{"topic":"Smoke test","language":"en"}'
restart
[ "$(sessions)" = 1 ] || fail 'the session is gone after down and up'
echo 'data kept across down and up'

# Backup and restore, as in docs/deploy.md.
compose exec -T web node -e "const s=require('node:sqlite');s.backup(new s.DatabaseSync('/data/kd-learn.db'),'/data/backup.db').then(()=>console.log('backup written'))"
compose cp web:/data/backup.db "$work/backup.db" >/dev/null 2>&1
compose stop web >/dev/null 2>&1
compose run --rm --no-deps web sh -c 'rm -f /data/kd-learn.db*' >/dev/null 2>&1
restart
[ "$(sessions)" = 0 ] || fail 'the database was not wiped'
compose stop web >/dev/null 2>&1
compose run --rm --no-deps -v "$work/backup.db:/restore.db:ro" web \
  sh -c 'cp /restore.db /data/kd-learn.db && rm -f /data/kd-learn.db-wal /data/kd-learn.db-shm' >/dev/null 2>&1
restart
[ "$(sessions)" = 1 ] || fail 'the session is not back after restore'
echo 'backup restored'

if compose logs --no-color web | grep -qF "$password"; then
  fail 'the admin password is in the server log'
fi
echo 'no admin password in the log'
