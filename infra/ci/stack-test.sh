#!/usr/bin/env bash
# CI job server-stack (spec §13.3, R11): the whole VPS story on a simulated shared host.
# Runs as the runner's normal user (never root, never sudo). Deterministic: no step depends on the
# wall-clock minute (the alerts clock is shifted to the fixture, the gate uses short test gaps, the
# rate-limit burst is larger than two minute buckets, dump names are read back, not guessed).
set -euo pipefail
ROOT="$(pwd)"
export CI_DIR="${RUNNER_TEMP:-/tmp}/thuammai-ci"
export THUAMMAI_HOME="$HOME/thuammai"
TH="$THUAMMAI_HOME"
IMAGE=ghcr.io/thaiglider/thuammai-server
NODE_IMG=node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
P256DH='BKKxKoz4vcAPfhOVpockZrObSZr5-iZRoOUpjfJhSGMRJYywCoqgcgaGnw9kJ2VSMFUMMXipV1Axnyisrc2p-Z0'
AUTH='BwcHBwcHBwcHBwcHBwcHBw'
ORIGIN='https://thaiglider.github.io'
TOKEN='123456:CIfakeTokenForTheStackTest0123456789'
mkdir -p "$CI_DIR/bin" "$CI_DIR/certs"
OUT="$CI_DIR/out.log"
: >"$OUT"
# Everything this test and the scripts under test print is kept, and scanned for secrets at the end.
exec > >(tee -a "$OUT") 2>&1

step() { printf '\n== %s (%ss)\n' "$*" "$SECONDS"; }
fail() {
  printf 'FAIL: %s\n' "$*"
  docker ps -a || true
  for c in thuammai-api-1 thuammai-alerts-1 thuammai-db-1 caddy fakes; do printf -- '--- %s\n' "$c"; docker logs --tail 40 "$c" 2>&1 || true; done
  for f in "$TH"/logs/*.log; do [ -f "$f" ] && { printf -- '--- %s\n' "$f"; tail -n 40 "$f"; }; done
  printf -- '--- fake records\n'; records || true
  exit 1
}
api() { curl -sS -k -m 15 --resolve flood.test:443:127.0.0.1 "$@"; }
code() { api -o /dev/null -w '%{http_code}' "$@"; }
records() { curl -fsS -m 5 http://127.0.0.1:8088/__records; }
count() { records | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);const [k,f,v]=process.argv.slice(1);console.log(r[k].filter(x=>!f||String(x[f])===v).length)})' "$@"; }
id12() { docker image inspect -f '{{.Id}}' "$1" | cut -c8-19; }
current() { basename "$(readlink -f "$TH/current")"; }
# wait_for <seconds> <command…>: poll every 2 s until the command succeeds.
wait_for() {
  local t=$((SECONDS + $1))
  shift
  until "$@"; do [ "$SECONDS" -lt "$t" ] || return 1; sleep 2; done
}
status_is() { [[ "$(api https://flood.test/v1/status 2>/dev/null || true)" == *"\"alerts\":\"$1\""* ]]; }
# kuma_has <token> <msg> <up|down>: the fake Kuma got that push.
kuma_has() { [[ "$(records)" == *"\"name\":\"$1\",\"status\":\"$3\",\"msg\":\"$2\""* ]]; }
health_ok() { [ "$(code https://flood.test/v1/health)" = 200 ]; }
pushes_ge() { [ "$(count push)" -ge "$1" ]; }

step "fixture data and three images: A, B (api exits at start), A2"
npm run pipeline:fixtures >/dev/null
export CI_DATA="$ROOT/dist/data"
[ -f "$CI_DATA/meta.json" ] || fail "no fixture data in $CI_DATA"
docker build -q -f server/Dockerfile --build-arg VERSION=ci-a -t "$IMAGE:stable" . >/dev/null
docker build -q -f server/Dockerfile --build-arg VERSION=ci-b --build-arg CI_BREAK=1 -t thuammai-ci:b . >/dev/null
docker build -q -f server/Dockerfile --build-arg VERSION=ci-a2 --label ci.variant=a2 -t thuammai-ci:a2 . >/dev/null
A="$(id12 "$IMAGE:stable")"

step "CA + certificates for the fakes, the shared host, a crontab stand-in"
(
  cd "$CI_DIR/certs"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=thuammai CI CA" -keyout ca.key -out ca.pem 2>/dev/null
  openssl req -newkey rsa:2048 -nodes -subj "/CN=fakes" -keyout fake.key -out fake.csr 2>/dev/null
  printf 'subjectAltName=DNS:fcm.googleapis.com,DNS:api.telegram.org\n' >san.ext
  openssl x509 -req -in fake.csr -CA ca.pem -CAkey ca.key -CAcreateserial -days 2 -extfile san.ext -out fake.pem 2>/dev/null
  chmod 644 ./*
)
cp infra/ci/Caddyfile "$CI_DIR/Caddyfile"
# The runner's real cron must never run update.sh/hostcheck.sh against this stack in the middle of a
# step: `crontab` is a stand-in that only keeps the table in a file (the block is still checked).
cat >"$CI_DIR/bin/crontab" <<EOF
#!/bin/sh
f="$CI_DIR/crontab.txt"
case "\${1:-}" in
  -l) [ -f "\$f" ] && cat "\$f" || { echo "no crontab for \$(id -un)" >&2; exit 1; } ;;
  -r) rm -f "\$f" ;;
  -) cat >"\$f" ;;
  *) echo "crontab stand-in: \$*" >&2; exit 2 ;;
esac
EOF
chmod +x "$CI_DIR/bin/crontab"
export PATH="$CI_DIR/bin:$PATH"
docker compose -f infra/ci/stack-host.yaml up -d --quiet-pull
wait_for 60 records >/dev/null || fail "the fakes did not start"
wait_for 60 docker exec caddy caddy version >/dev/null || fail "caddy did not start"

step "install as a normal user (no sudo), caddy add, finish"
[ "$(id -u)" != 0 ] || fail "must not run as root"
export THUAMMAI_NO_PULL=1 THUAMMAI_COMPOSE_OVERRIDE="$ROOT/infra/ci/override.yaml" CADDYFILE="$CI_DIR/Caddyfile"
export THUAMMAI_CURL_OPTS="-k --resolve flood.test:443:127.0.0.1"
# Test knobs (F2-8): a short health gate (two polls 15 s apart, 120 s at most).
export THUAMMAI_GATE_GAP=15 THUAMMAI_GATE_SLEEP=5 THUAMMAI_GATE_SECONDS=120
CI_CLOCK_OFFSET_MS="$(node -e "console.log(Date.parse('2026-09-28T14:50:00+07:00') - Date.now())")"
export CI_CLOCK_OFFSET_MS
# The pasted URLs are the public-dashboard form; install stores them as http://uptime-kuma:3001/…
# (F2-K). Their tokens (ciTok…) must never appear in any log or output.
KUMA_PUSH_ALERTS=https://uptime.example.test/api/push/ciTokAlerts \
  KUMA_PUSH_BACKUP=https://uptime.example.test/api/push/ciTokBackup \
  KUMA_PUSH_DEPLOY=https://uptime.example.test/api/push/ciTokDeploy \
  KUMA_PUSH_HOST=https://uptime.example.test/api/push/ciTokHost \
  API_HOST=flood.test TELEGRAM_BOT_TOKEN="$TOKEN" \
  bash infra/setup.sh --non-interactive >"$CI_DIR/setup.out" 2>&1 || { cat "$CI_DIR/setup.out"; fail "setup"; }
cat "$CI_DIR/setup.out"
# The fake Kuma answers through the network alias uptime-kuma (ruling T7-4): no false warning.
if grep -q "answers as 'uptime-kuma'" "$CI_DIR/setup.out"; then fail "setup did not see Kuma's network alias"; fi
CLI="$TH/current/bin/thuammai"
[ "$(current)" = "$A" ] || fail "current is not A"
[ "$(stat -c %a "$TH/secrets")" = 700 ] || fail "secrets dir is not 0700"
[ "$(stat -c %a "$TH/.env")" = 600 ] || fail ".env is not 0600"
[ "$(cat "$TH/secrets/kuma_push_alerts")" = "http://uptime-kuma:3001/api/push/ciTokAlerts" ] || fail "the Kuma URL was not stored in its internal form"
grep -q "^TELEGRAM_BOT_USERNAME=thuammai_ci_bot$" "$TH/.env" || fail "getMe through the tools container"
grep -q '^# BEGIN thuammai' "$CI_DIR/crontab.txt" || fail "no crontab block"
grep -qF "$TH/current/bin/update.sh" "$CI_DIR/crontab.txt" || fail "the crontab block does not run update.sh"
[ -L "$HOME/bin/thuammai" ] || fail "no ~/bin/thuammai"
printf 'yes\n' | bash "$CLI" caddy add || fail "caddy add"
grep -qxF 'flood.test {' "$CADDYFILE" || fail "the site block is not in the Caddyfile"
grep -qF 'keepalive 60s' "$CADDYFILE" || fail "no keepalive 60s"
if grep -v '^[[:space:]]*#' "$CADDYFILE" | grep -Eq '(^|[[:space:]])(log|access_log)([[:space:]]|[{]|$)'; then fail "the Caddyfile logs requests"; fi
again="$(printf 'yes\n' | bash "$CLI" caddy add)" || fail "second caddy add"
[[ "$again" == *already* ]] || fail "a second caddy add must be a no-op"
[ "$(grep -cxF 'flood.test {' "$CADDYFILE")" = 1 ] || fail "the site block was added twice"
# Caddy issues the local certificate right after the reload.
wait_for 60 health_ok || fail "health through caddy"
bash "$CLI" finish || fail "finish"
grep -q '^FINISHED=1$' "$TH/.env" || fail "FINISHED is not 1"
[ "$(count tg method setWebhook)" -ge 1 ] || fail "finish did not set the Telegram webhook"
for m in Backup Deploy Host; do kuma_has "ciTok$m" finish up || fail "no Kuma push ciTok$m up finish"; done

step "smoke through caddy"
wait_for 120 status_is on || fail "status is not on: $(api https://flood.test/v1/status || true)"
[ "$(code https://flood.test/v1/health)" = 200 ] || fail "health"
# `/` is now the web, proxied from GitHub Pages (domain move stage ก). `thuammai finish` above already needs
# `/` to answer 200 or 302 (the production rule), so here the proxy must answer 200: a redirect, the old 404
# or an upstream error fails CI (GitHub runners reach github.io).
[ "$(code https://flood.test/)" = 200 ] || fail "/ did not answer 200 from the Pages upstream"
webh="$(api -o /dev/null -D - https://flood.test/ | tr -d '\r')"
grep -qi '^permissions-policy:.*geolocation=(self)' <<<"$webh" || fail "the web handle lacks Permissions-Policy geolocation=(self)"
apih="$(api -o /dev/null -D - https://flood.test/v1/health | tr -d '\r')"
grep -qi 'geolocation=(self)' <<<"$apih" && fail "/v1 must not allow geolocation"
grep -qi '^x-frame-options: SAMEORIGIN$' <<<"$apih" || fail "/v1 lost the security_headers snippet"
[ "$(code https://flood.test/internal/v1/places)" = 404 ] || fail "internal path answered"
[ "$(code -X POST -H 'content-type: application/json' -H 'x-telegram-bot-api-secret-token: wrong' -d '{}' https://flood.test/v1/telegram)" = 401 ] || fail "telegram secret"
pre="$(api -o /dev/null -D - -X OPTIONS -H "Origin: $ORIGIN" -H 'Access-Control-Request-Method: POST' https://flood.test/v1/push/subscription | tr -d '\r')"
grep -qi "^access-control-allow-origin: $ORIGIN$" <<<"$pre" || fail "CORS"
grep -qi '^x-content-type-options: nosniff$' <<<"$pre" || fail "the shared security_headers snippet is not imported"
sub='{"endpoint":"https://fcm.googleapis.com/fcm/send/ci-1","keys":{"p256dh":"'"$P256DH"'","auth":"'"$AUTH"'"},"places":[{"lat":13.854,"lon":100.587}]}'
[ "$(code -X POST -H "origin: $ORIGIN" -H 'content-type: application/json' -d "$sub" https://flood.test/v1/push/subscription)" = 200 ] || fail "subscribe"

step "the Telegram webhook path: the right secret reaches the bot logic, which answers through (fake) Telegram"
upd='{"update_id":1,"message":{"message_id":1,"date":0,"chat":{"id":4242,"type":"private"},"text":"/help"}}'
[ "$(code -X POST -H 'content-type: application/json' -H "x-telegram-bot-api-secret-token: $(cat "$TH/secrets/telegram_webhook_secret")" -d "$upd" https://flood.test/v1/telegram)" = 200 ] || fail "telegram update"
[ "$(count tg chat 4242)" -ge 1 ] || fail "the bot did not answer /help through the fake Telegram"

step "a real alert reaches the fake FCM (fixture level 4)"
docker exec thuammai-db-1 psql -U postgres -d thuammai -qc 'UPDATE alert_run SET gen = NULL' >/dev/null
docker exec thuammai-db-1 psql -U postgres -d thuammai -qc 'TRUNCATE point_state' >/dev/null
bash "$CLI" restart alerts >/dev/null
wait_for 180 pushes_ge 1 || fail "no push reached the fake FCM"
[[ "$(records)" == *'"urgency":"high"'* ]] || fail "the push was not urgent"
wait_for 90 kuma_has ciTokAlerts OK up || fail "no Kuma push up from alerts"

step "rate limit: spoofed X-Forwarded-For / CF-Connecting-IP cannot dodge it; another peer has its own bucket"
del='{"endpoint":"https://fcm.googleapis.com/fcm/send/x","auth":"'"$AUTH"'"}'
# 25 > 2 × 10: even when the burst straddles a minute, one minute bucket goes over the limit.
codes=""
for i in $(seq 1 25); do codes="$codes $(code -X DELETE -H "origin: $ORIGIN" -H 'content-type: application/json' -H "x-forwarded-for: 203.0.113.$i" -H "cf-connecting-ip: 198.51.100.$i" -d "$del" https://flood.test/v1/push/subscription)"; done
[[ "$codes" == *429* ]] || fail "no 429: $codes"
other="$(docker run --rm --network ai-stack_ai-stack "$NODE_IMG" node -e "fetch('http://thuammai-api:8080/v1/push/subscription',{method:'DELETE',headers:{origin:'$ORIGIN','content-type':'application/json','x-forwarded-for':'1.2.3.4'},body:'$del'}).then(r=>console.log(r.status))")"
[ "$other" = 204 ] || fail "a different peer was limited too ($other)"

step "pause / resume (server-side switch, R28)"
tg_del="$(count tg method deleteWebhook)"
bash "$CLI" pause || fail "pause"
wait_for 60 status_is paused || fail "status is not paused"
[ "$(count tg method deleteWebhook)" -gt "$tg_del" ] || fail "pause did not delete the webhook"
[ "$(code -X POST -H "origin: $ORIGIN" -H 'content-type: application/json' -d "$sub" https://flood.test/v1/push/subscription)" != 200 ] || fail "a sign-up was accepted while paused"
tg_set="$(count tg method setWebhook)"
bash "$CLI" resume || fail "resume"
wait_for 60 status_is on || fail "status is not on after resume"
[ "$(count tg method setWebhook)" -gt "$tg_set" ] || fail "resume did not set the webhook"
grep -q '^ALERTS_PAUSED=0$' "$TH/.env" || fail "ALERTS_PAUSED is not 0 after resume"

step "hygiene: no published port, limits, no secret in env, counts-only logs"
[ -z "$(docker ps --filter label=com.docker.compose.project=thuammai --format '{{.Ports}}' | grep -E '0\.0\.0\.0:|:::' || true)" ] || fail "a port is published"
[ "$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}' thuammai-api-1)" = "268435456 500000000 256" ] || fail "api limits"
[ "$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}} {{.HostConfig.PidsLimit}}' thuammai-alerts-1)" = "536870912 1000000000 256" ] || fail "alerts limits"
[ "$(docker inspect -f '{{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}' thuammai-db-1)" = "1073741824 1000000000" ] || fail "db limits"
for s in rate_hmac_key pg_app vapid_private_key telegram_webhook_secret telegram_bot_token; do
  v="$(cat "$TH/secrets/$s")"
  [ -n "$v" ] || fail "secret $s is empty"
  for c in thuammai-api-1 thuammai-alerts-1 thuammai-db-1; do
    if docker inspect -f '{{json .Config.Env}}' "$c" | grep -qF "$v"; then fail "$s visible in $c env"; fi
  done
done
for c in thuammai-api-1 thuammai-alerts-1; do
  bad="$(docker logs "$c" 2>&1 | grep -vE '^(alerts|api) [a-z_]+( [a-z0-9_]+=[0-9]+)*$' || true)"
  [ -z "$bad" ] || fail "$c printed a non-counts line: $bad"
done

step "update: broken B is rolled back and marked bad; then A2 deploys"
# Ruling T7-1: the db mounts its config from $TH/db, so release switches never recreate Postgres.
db_before="$(docker inspect -f '{{.Id}}' thuammai-db-1)"
docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' thuammai-db-1 | tr ' ' '\n' | grep -qxF "$TH/db/postgresql.conf" || fail "db does not mount \$TH/db/postgresql.conf"
docker tag thuammai-ci:b "$IMAGE:stable"
B="$(id12 "$IMAGE:stable")"
if bash "$TH/current/bin/update.sh"; then fail "the broken image was deployed"; fi
[ "$(current)" = "$A" ] || fail "current is not A after the rollback"
grep -qx "$B" "$TH/run/bad-digests" || fail "B is not in bad-digests"
kuma_has ciTokDeploy rollback_ci-b down || fail "no rollback_ci-b push"
wait_for 60 status_is on || fail "not on after the rollback"
[ "$(docker inspect -f '{{.Config.Image}}' thuammai-api-1)" = "thuammai-local:$A" ] || fail "api does not run A after the rollback"
bash "$TH/current/bin/update.sh" || fail "update with a bad :stable must exit 0"
kuma_has ciTokDeploy stable_is_bad down || fail "no stable_is_bad push"
docker tag thuammai-ci:a2 "$IMAGE:stable"
A2="$(id12 thuammai-ci:a2)"
bash "$TH/current/bin/update.sh" || fail "A2 did not deploy"
[ "$(current)" = "$A2" ] || fail "current is not A2"
[ "$(docker inspect -f '{{.Id}}' thuammai-db-1)" = "$db_before" ] || fail "a release switch recreated Postgres"
[ "$(cat "$TH/run/previous")" = "$A" ] || fail "run/previous is not A"
kuma_has ciTokDeploy deployed_ci-a2 up || fail "no deployed_ci-a2 push"
[ -n "$(ls "$TH/backups/predeploy/"*.dump 2>/dev/null)" ] || fail "no pre-deploy dump"
bash "$TH/current/bin/update.sh" || fail "an update with nothing new must exit 0"
kuma_has ciTokDeploy ok up || fail "no 'ok' deploy push"

step "backup → restore → the same rows; restore-test; hostcheck"
bash "$CLI" backup now || fail "backup"
kuma_has ciTokBackup offsite_missing up || fail "backup push"
dump="$(cd "$TH/backups/daily" && ls -t -- [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump | head -n 1)"
[ -n "$dump" ] || fail "no nightly dump"
[ "$(stat -c %a "$TH/backups/daily/$dump")" = 600 ] || fail "the dump is not 0600"
before="$(docker exec thuammai-db-1 psql -U postgres -d thuammai -Atc 'SELECT count(*) FROM follow')"
# A row written after the dump must be gone after the restore.
[ "$(code -X POST -H "origin: $ORIGIN" -H 'content-type: application/json' -d "${sub/ci-1/ci-2}" https://flood.test/v1/push/subscription)" = 200 ] || fail "second subscribe"
[ "$(docker exec thuammai-db-1 psql -U postgres -d thuammai -Atc 'SELECT count(*) FROM follow')" -gt "$before" ] || fail "the second follow was not written"
bash "$CLI" restore --yes "daily/$dump" || fail "restore"
[ ! -e "$TH/run/restore-incomplete" ] || fail "restore left the incomplete marker"
after="$(docker exec thuammai-db-1 psql -U postgres -d thuammai -Atc 'SELECT count(*) FROM follow')"
{ [ "$before" = "$after" ] && [ "$before" -ge 1 ]; } || fail "row count $before → $after"
ls "$TH/backups/daily/"prerestore-*.dump >/dev/null 2>&1 || fail "no safety dump before the restore"
wait_for 60 status_is on || fail "not on after the restore"
bash "$CLI" restore-test || fail "restore-test"
kuma_has ciTokBackup restore_test_ok up || fail "restore-test push"
bash "$TH/current/bin/hostcheck.sh" || fail "hostcheck"
[ "$(count kuma name ciTokHost)" -ge 2 ] || fail "no hostcheck push"

step "other app on the shared host still answers"
[ "$(curl -sS -k --resolve other.test:443:127.0.0.1 https://other.test/)" = "another app on the shared host" ] || fail "other.test broke"

step "no secret, push URL or token in any output or log"
scan=("$OUT" "$TH"/logs/*.log)
for c in thuammai-api-1 thuammai-alerts-1 thuammai-db-1; do docker logs "$c" >"$CI_DIR/$c.log" 2>&1 || true; scan+=("$CI_DIR/$c.log"); done
for s in rate_hmac_key pg_app pg_owner pg_superuser vapid_private_key telegram_webhook_secret telegram_bot_token export_passphrase; do
  v="$(cat "$TH/secrets/$s")"
  for f in "${scan[@]}"; do [ -f "$f" ] || continue; if grep -qF -- "$v" "$f"; then fail "secret $s found in $(basename "$f")"; fi; done
done
for f in "${scan[@]}"; do [ -f "$f" ] || continue; if grep -qE 'ciTok|CIfakeToken' "$f"; then fail "a Kuma token or the bot token was printed in $(basename "$f")"; fi; done
printf '\nALL GREEN (%ss)\n' "$SECONDS"
