#!/usr/bin/env bash
# Shared helpers for thuammai's host scripts (spec §9–§11). Sourced, never run directly.
# Rules (R24, C2): no root; nothing outside $THUAMMAI_HOME except the crontab block between the
# markers, our compose project "thuammai" and its images — and, after an explicit "y", the shared
# Caddyfile; never print a secret (only `thuammai secrets show` does).
set -euo pipefail

TH="${THUAMMAI_HOME:-$HOME/thuammai}"
IMAGE="${THUAMMAI_IMAGE:-ghcr.io/thaiglider/thuammai-server}"
LOCAL_IMAGE="thuammai-local"
# Our own tag for the Postgres image the db runs (DB_IMAGE in .env): we never retag a public image.
DB_LOCAL="thuammai-db"
PROJECT="thuammai"
SECRET_FILES="pg_superuser pg_owner pg_app rate_hmac_key vapid_private_key telegram_bot_token telegram_webhook_secret kuma_push_alerts kuma_push_backup kuma_push_deploy kuma_push_host restic_password restic_repository restic_env export_passphrase line_channel_secret line_channel_token"

log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
say() { printf '%s\n' "$*"; }
die() { log "error: $*" >&2; exit 1; }

# Keep the last 2,000 lines once a log is over 1 MB (no logrotate: it needs root). Rewritten in
# place (same inode): cron's `>> log` descriptor, already open in this very script, keeps working.
trim_log() {
  local f="$1"
  if [ -f "$f" ] && [ "$(wc -c <"$f")" -gt 1048576 ]; then tail -n 2000 "$f" >"$f.tmp" && cat "$f.tmp" >"$f" && rm -f "$f.tmp"; fi
}

env_get() { [ -f "$TH/.env" ] || return 0; sed -n "s/^$1=//p" "$TH/.env" | tail -n 1; }
env_set() {
  local k="$1" v="$2" f="$TH/.env" tmp
  (umask 077 && touch "$f")
  chmod 600 "$f"
  if grep -q "^$k=" "$f"; then
    tmp="$(mktemp "$TH/.env.XXXXXX")"
    awk -v k="$k" -v v="$v" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$f" >"$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}
env_default() { [ -n "$(env_get "$1")" ] || env_set "$1" "$2"; }

# Secret files: directory 0700 (nobody else on the shared host can reach them), files 0600 — except
# pg_owner and pg_app, which the db image's initdb script (20-roles.sh) reads as the in-container
# postgres uid, not ours; compose file secrets are plain bind mounts (mode/uid are ignored), so those
# two are 0644 and still unreachable from the host through the 0700 directory.
secret_mode() {
  case "$1" in
    pg_owner | pg_app) printf 644 ;;
    *) printf 600 ;;
  esac
}
secret_get() { cat "$TH/secrets/$1" 2>/dev/null || true; }
secret_set() {
  mkdir -p "$TH/secrets"
  chmod 700 "$TH/secrets"
  (umask 077 && printf '%s' "$2" >"$TH/secrets/$1")
  chmod "$(secret_mode "$1")" "$TH/secrets/$1"
}
secret_fix_modes() {
  local f
  chmod 700 "$TH/secrets"
  for f in "$TH/secrets"/*; do [ -f "$f" ] && chmod "$(secret_mode "$(basename "$f")")" "$f"; done
  return 0
}
# ensure_secret_files: every secret file compose may mount exists (empty when not configured), so a
# release that adds a secret never makes docker create a directory in its place. An empty directory
# docker already made is replaced; one with content is not ours to delete. Used by install and update.sh.
ensure_secret_files() {
  local s
  mkdir -p "$TH/secrets"
  chmod 700 "$TH/secrets"
  for s in $SECRET_FILES; do
    if [ -d "$TH/secrets/$s" ] && [ ! -L "$TH/secrets/$s" ]; then
      rmdir "$TH/secrets/$s" 2>/dev/null || die "$TH/secrets/$s is a directory with files in it, not a secret file — look at it and remove it yourself, then run install again"
      log "removed the empty directory docker made at secrets/$s"
    fi
    [ -e "$TH/secrets/$s" ] || secret_set "$s" ""
  done
  secret_fix_modes
}

release_dir() { printf '%s/releases/%s' "$TH" "$1"; }
current_tag() { [ -e "$TH/current" ] || die "not installed (no $TH/current)"; basename "$(readlink -f "$TH/current")"; }
# Every docker call runs with fd 9 (the ops lock) closed, so no child can keep the lock alive.
compose_in() {
  local tag="$1"
  shift
  local files=(-f "$(release_dir "$tag")/compose.yaml")
  # The db mounts $TH/db (db_files): never let docker create root-owned directories in their place
  # (first run after an upgrade, or a copy removed by hand).
  if [ ! -f "$TH/db/postgresql.conf" ] || [ ! -f "$TH/db/init/20-roles.sh" ]; then db_files "$tag" || return 1; fi
  if [ -n "${THUAMMAI_COMPOSE_OVERRIDE:-}" ]; then files+=(-f "$THUAMMAI_COMPOSE_OVERRIDE"); fi
  IMAGE_TAG="$tag" THUAMMAI_HOME="$TH" THUAMMAI_UID="$(id -u)" THUAMMAI_GID="$(id -g)" \
    docker compose -p "$PROJECT" --project-directory "$(release_dir "$tag")" "${files[@]}" --env-file "$TH/.env" "$@" 9>&-
}
compose() { compose_in "$(current_tag)" "$@"; }

# First 12 hex of the image id: names the local tag, the release directory and bad-digests (F2-2).
image_tag() { local id; id="$(docker image inspect -f '{{.Id}}' "$1")"; id="${id#sha256:}"; printf '%s' "${id:0:12}"; }
extract_release() {
  local tag="$1" ref="$2" dir cid
  dir="$(release_dir "$tag")"
  [ -f "$dir/compose.yaml" ] && return 0
  # Every step is checked by hand: update.sh calls this from an `if`, where `set -e` does not apply,
  # and a half-copied release must never be moved into place.
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp" || return 1
  cid="$(docker create "$ref" true)" || { rm -rf "$dir.tmp"; return 1; }
  docker cp "$cid:/app/infra/." "$dir.tmp/" >/dev/null || { docker rm "$cid" >/dev/null 2>&1 || true; rm -rf "$dir.tmp"; return 1; }
  docker rm "$cid" >/dev/null || true
  [ -f "$dir.tmp/compose.yaml" ] || { rm -rf "$dir.tmp"; return 1; }
  chmod +x "$dir.tmp"/bin/* "$dir.tmp/setup.sh" || return 1
  printf '%s\n' "$tag" >"$dir.tmp/DIGEST" || return 1
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "$ref" >"$dir.tmp/VERSION" || return 1
  mv "$dir.tmp" "$dir"
}
# db_files <tag>: copy <tag>'s db config (db/postgresql.conf, db/init/20-roles.sh) to the stable
# $TH/db, which compose mounts. A release switch then never changes db's config — Postgres is not
# recreated on an ordinary deploy — and pruning a release can never leave the db mounting a file that
# is gone (ruling T7-1). Only changed files are replaced (atomically); DB_FILES_CHANGED=1 then, and the
# db must be recreated to read them.
DB_FILES_CHANGED=0
db_files() {
  local src f
  src="$(release_dir "$1")/db"
  DB_FILES_CHANGED=0
  mkdir -p "$TH/db/init" || return 1
  chmod 755 "$TH/db" "$TH/db/init" || return 1
  for f in postgresql.conf init/20-roles.sh; do
    [ -f "$src/$f" ] || { log "db_files: no $f in release $1" >&2; return 1; }
    cmp -s "$src/$f" "$TH/db/$f" && continue
    # The db container reads them as its own postgres uid: readable by all, writable by us only.
    { cp "$src/$f" "$TH/db/$f.tmp" && chmod u+rw,go+r,go-w "$TH/db/$f.tmp" && mv -f "$TH/db/$f.tmp" "$TH/db/$f"; } || { rm -f "$TH/db/$f.tmp"; return 1; }
    DB_FILES_CHANGED=1
  done
}
# stack_up <tag> [up options…]: db_files, then `up -d` of <tag>. A running db is recreated first — and
# only then — when its config files changed.
stack_up() {
  local tag="$1"
  shift
  db_files "$tag" || return 1
  if [ "$DB_FILES_CHANGED" = 1 ] && [ -n "$(compose_in "$tag" ps -q db 2>/dev/null || true)" ]; then
    log "db config changed — recreating Postgres"
    compose_in "$tag" up -d --wait --force-recreate --no-deps db || return 1
  fi
  compose_in "$tag" up -d "$@"
}
image_run() { docker run --rm --network none --read-only --user "$(id -u):$(id -g)" "$LOCAL_IMAGE:$(current_tag)" "$@" 9>&-; }
tools_run() { compose --profile tools run --rm --no-deps -T tools "$@"; }

# kuma_url <pasted push URL>: the same monitor at Kuma's internal address on ai-stack_ai-stack
# (F2-K) — the public dashboard URL answers an auth redirect. Keeps only the token; fails when the
# text is not a Kuma push URL. KUMA_BASE_URL in .env overrides the address (CI's fake Kuma).
kuma_url() {
  local u="${1%%\?*}" tok base
  base="$(env_get KUMA_BASE_URL)"
  case "$u" in */api/push/?*) tok="${u##*/api/push/}" ;; *) return 1 ;; esac
  case "$tok" in *[!A-Za-z0-9_-]*) return 1 ;; esac
  printf '%s/api/push/%s' "${base:-http://uptime-kuma:3001}" "$tok"
}
# kuma <alerts|backup|deploy|host> <up|down> <msg>: one push from the tools container, which sits on
# ai-stack_ai-stack next to uptime-kuma (F2-K). The URL holds a token: kuma.mjs reads it from the
# read-only mounted secret file, so it never appears on a command line; redirects count as failures.
# Silent when the monitor is not configured.
kuma() {
  [ -s "$TH/secrets/kuma_push_$1" ] || return 0
  tools_run node dist/tools/kuma.mjs "/run/host-secrets/kuma_push_$1" "$2" "$3" >/dev/null 2>&1 || log "kuma $1: push failed"
}
# shellcheck disable=SC2086 # THUAMMAI_CURL_OPTS is a CI-only list of options (F2-8)
curl_api() { curl -sS -m 10 ${THUAMMAI_CURL_OPTS:-} "$@"; }

# restarts_snapshot: "<container id> <restart count>" for every container of our project. Keyed by id:
# a recreated container is a new id and starts at 0, so a name reused by a new container never hides
# the new one's restarts.
restarts_snapshot() {
  local id
  docker ps -a --filter "label=com.docker.compose.project=$PROJECT" --format '{{.ID}}' 9>&- | while read -r id; do
    [ -n "$id" ] && printf '%s %s\n' "$id" "$(docker inspect -f '{{.RestartCount}}' "$id" 2>/dev/null 9>&- || echo 0)"
  done | sort
}
# restarts_ok <snapshot before>: no container restarted more than once since (new ids count from 0).
restarts_ok() {
  local before="$1" id n was
  while read -r id n; do
    [ -n "$id" ] || continue
    was="$(printf '%s\n' "$before" | awk -v x="$id" '$1 == x { print $2 }')"
    if [ $((n - ${was:-0})) -gt 1 ]; then return 1; fi
  done <<<"$(restarts_snapshot)"
  return 0
}
# alerts_started <tag>: StartedAt of the running alerts container, cut to milliseconds (health.mjs
# parses it with Date). Empty when there is none.
alerts_started() {
  local cid t
  cid="$(compose_in "$1" ps -q alerts 2>/dev/null | head -n 1 || true)"
  [ -n "$cid" ] || return 0
  t="$(docker inspect -f '{{.State.StartedAt}}' "$cid" 2>/dev/null 9>&- || true)"
  printf '%s' "$t" | sed -E 's/(\.[0-9]{3})[0-9]*Z$/\1Z/'
}
# gate <tag> <restart snapshot>: within 180 s, two polls at least 60 s apart (nothing failing in
# between) that both see /v1/health 200, /v1/status on (or paused), a heartbeat written after the
# *running* alerts container started — so it can only come from the new release — and no container
# restarted more than once (spec §9.3 step 6). Health is measured inside `api`.
gate() {
  local tag="$1" before="$2" deadline=$((SECONDS + ${THUAMMAI_GATE_SECONDS:-180})) gap="${THUAMMAI_GATE_GAP:-60}" first=-1 word="" since
  while [ "$SECONDS" -lt "$deadline" ]; do
    since="$(alerts_started "$tag")"
    if [ -n "$since" ]; then
      word="$(compose_in "$tag" exec -T api node dist/tools/health.mjs --allow-paused --since "$since" 2>/dev/null | tail -n 1 || true)"
    else
      word="no_alerts_container"
    fi
    if [ "$word" = ok ] && restarts_ok "$before"; then
      if [ "$first" -lt 0 ]; then first="$SECONDS"; elif [ $((SECONDS - first)) -ge "$gap" ]; then return 0; fi
    else
      first=-1
      [ "$word" != ok ] || word="restarts"
    fi
    sleep "${THUAMMAI_GATE_SLEEP:-10}"
  done
  log "gate: ${word:-no_answer}"
  return 1
}

# A restore that stopped half-way (restore.sh writes it before stopping api/alerts and removes it only
# after the health gate): update.sh and backup.sh refuse to run while it exists.
RESTORE_MARK="$TH/run/restore-incomplete"
# restore_stage: the mark's stage — "stopping" (api/alerts stopped, data being replaced: the database
# may be incomplete) or "data_restored" (pg_restore and migrate finished; only the health gate failed).
# Empty when there is no mark.
restore_stage() { [ -e "$RESTORE_MARK" ] || return 0; sed -n 's/^stage=//p' "$RESTORE_MARK" 2>/dev/null | tail -n 1 | tr -cd 'a-z_'; }
# restore_blocking: a mark whose data may be incomplete (anything but data_restored).
restore_blocking() { [ -e "$RESTORE_MARK" ] && [ "$(restore_stage)" != data_restored ]; }
# restore_hint: the exact command that puts the database back as it was before that restore.
restore_hint() {
  local s
  s="$(sed -n 's/^safety=//p' "$RESTORE_MARK" 2>/dev/null | tail -n 1 | tr -cd 'A-Za-z0-9._/-')"
  if [ -n "$s" ]; then printf 'thuammai restore --yes %s' "$s"; else printf 'thuammai restore --yes daily/<YYYY-MM-DD>.dump'; fi
}

# avail_kb <path>: free KiB on the file system that holds <path> (empty when unknown).
avail_kb() { df -Pk "$1" 2>/dev/null | awk 'NR == 2 { print $4 }' || true; }
# newest_dump_kb: size in KiB of the newest dump under backups/ (0 when there is none).
newest_dump_kb() {
  find "$TH/backups" -mindepth 2 -maxdepth 2 -type f -name '*.dump' -printf '%T@ %s\n' 2>/dev/null | sort -nr | head -n 1 | awk '{ print int(($2 + 1023) / 1024) }' || true
}
# disk_ok <path>: at least 3× the newest dump plus a margin (256 MiB) free on <path>'s file system —
# checked before anything is written, so a full disk never leaves a half-written dump or database.
# An unknown answer from df is logged and let through (the job itself still fails cleanly).
disk_ok() {
  local n
  n="$(newest_dump_kb)"
  disk_room "$1" $((3 * ${n:-0})) lenient "3x the newest dump"
}
# disk_room <path> <KiB> <strict|lenient> <what>: <KiB> plus the margin free on <path>'s file system.
# strict: an unknown answer from df fails too.
disk_room() {
  local a need=$(($2 + ${THUAMMAI_DISK_MARGIN_KB:-262144}))
  a="$(avail_kb "$1")"
  case "$a" in
    "" | *[!0-9]*)
      log "disk check: free space on $1 unknown" >&2
      [ "$3" = lenient ]
      return
      ;;
  esac
  if [ "$a" -lt "$need" ]; then
    log "not enough disk on $1: $a KiB free, need $need KiB ($4 + margin)" >&2
    return 1
  fi
}

# pg_backup <daily|predeploy> <name>: dump into <name>.dump.tmp, verify it with pg_restore --list,
# make it 0600, then rename it — a dump under its final name is always complete and verified.
# Directories are 0700 (the shared host's other users never reach a dump). Prints daily/<name>.dump.
# pg_dump's and pg_restore's output is discarded: it never reaches a log.
pg_backup() {
  local rel="$1/$2.dump"
  mkdir -p "$TH/backups/$1" || return 1
  chmod 700 "$TH/backups" "$TH/backups/$1" || return 1
  disk_ok "$TH/backups" || return 1
  compose --profile tools run --rm --no-deps -T backup dump "/backups/$rel.tmp" >/dev/null 2>&1 || { rm -f "$TH/backups/$rel.tmp"; return 1; }
  compose --profile tools run --rm --no-deps -T backup verify "/backups/$rel.tmp" >/dev/null 2>&1 || { rm -f "$TH/backups/$rel.tmp"; return 1; }
  chmod 600 "$TH/backups/$rel.tmp" || { rm -f "$TH/backups/$rel.tmp"; return 1; }
  mv -T "$TH/backups/$rel.tmp" "$TH/backups/$rel" || { rm -f "$TH/backups/$rel.tmp"; return 1; }
  printf '%s' "$rel"
}
# newest <dir> <glob> [n]: the newest n file names (none when the directory does not exist).
newest() { [ -d "$1" ] || return 0; find "$1" -maxdepth 1 -name "$2" -printf '%T@ %f\n' | sort -nr | head -n "${3:-1}" | cut -d' ' -f2 || true; }
prune_predeploy() { find "$TH/backups/predeploy" -maxdepth 1 -name '*.dump' -printf '%T@ %p\n' | sort -nr | tail -n +"$(($1 + 1))" | cut -d' ' -f2 | xargs -r rm -f; }
# prune_releases <n>: keep the current release, run/previous (the rollback target) and the newest good
# releases up to <n> in all; releases in bad-digests go first. Removes only our own local image tags.
prune_releases() {
  local keep="$1" cur prev d n=1
  cur="$(current_tag)"
  prev="$(cat "$TH/run/previous" 2>/dev/null || true)"
  if [ -n "$prev" ] && [ "$prev" != "$cur" ] && [ -d "$(release_dir "$prev")" ]; then n=2; fi
  for d in $(find "$TH/releases" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %f\n' | sort -nr | cut -d' ' -f2); do
    if [ "$d" = "$cur" ] || [ "$d" = "$prev" ]; then continue; fi
    if ! grep -qxF "$d" "$TH/run/bad-digests" 2>/dev/null && [ "$n" -lt "$keep" ]; then
      n=$((n + 1))
      continue
    fi
    rm -rf "${TH:?}/releases/$d"
    if [[ $d =~ ^[0-9a-f]{12}$ ]]; then docker image rm "$LOCAL_IMAGE:$d" >/dev/null 2>&1 9>&- || true; fi
  done
}

# db_upstream: the public Postgres image named in the current compose file (${DB_IMAGE:-<this>}).
# shellcheck disable=SC2016 # a literal ${DB_IMAGE:-…} in the compose file
db_upstream() { sed -n 's/^ *image: *"*\${DB_IMAGE:-\([^}]*\)}"* *$/\1/p' "$(release_dir "$(current_tag)")/compose.yaml" | head -n 1; }
# db_pin: make sure DB_IMAGE in .env names one of our own thuammai-db:<id12> tags that exists here
# (a fresh install, an install from a recovery bundle made on another machine, or an older install).
# The id is the running db's image when there is one, otherwise the upstream image (pulled if absent).
db_pin() {
  local cur up cid id=""
  cur="$(env_get DB_IMAGE)"
  if [ -n "$cur" ] && docker image inspect "$cur" >/dev/null 2>&1 9>&-; then return 0; fi
  up="$(db_upstream)"
  [ -n "$up" ] || { log "db_pin: no \${DB_IMAGE:-…} image line in compose.yaml"; return 1; }
  cid="$(compose ps -q db 2>/dev/null | head -n 1 || true)"
  if [ -n "$cid" ]; then id="$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null 9>&- || true)"; fi
  if [ -z "$id" ]; then
    docker image inspect "$up" >/dev/null 2>&1 9>&- || docker pull -q "$up" >/dev/null 9>&- || return 1
    id="$(docker image inspect -f '{{.Id}}' "$up" 9>&-)" || return 1
  fi
  id="${id#sha256:}"
  docker tag "$id" "$DB_LOCAL:${id:0:12}" 9>&- || return 1
  env_set DB_IMAGE "$DB_LOCAL:${id:0:12}"
}

cron_block() { sed "s#@TH@#$TH#g" "$(release_dir "$(current_tag)")/crontab.txt"; }
cron_install() {
  local cur
  cur="$( (crontab -l 2>/dev/null || true) | sed '/^# BEGIN thuammai/,/^# END thuammai/d')"
  {
    if [ -n "$cur" ]; then printf '%s\n' "$cur"; fi
    cron_block
  } | crontab -
}
cron_remove() {
  local cur
  cur="$( (crontab -l 2>/dev/null || true) | sed '/^# BEGIN thuammai/,/^# END thuammai/d')"
  if [ -n "$cur" ]; then printf '%s\n' "$cur" | crontab -; else crontab -r 2>/dev/null || true; fi
}

# One lock for every state-changing job (F2-4): update skips when busy, the others wait ≤15 min
# (THUAMMAI_LOCK_WAIT seconds, a test-only knob). Every command that edits .env or secrets takes it,
# so a cron update.sh never interleaves with — and never loses — the owner's edit.
ops_lock() {
  mkdir -p "$TH/run"
  exec 9>"$TH/run/ops.lock"
  if [ "$1" = nowait ]; then flock -n 9; else flock -w "${THUAMMAI_LOCK_WAIT:-900}" 9; fi
}

# valid_host <name>: a plain lower-case DNS name with at least one dot — no wildcard, port, comma,
# space, '#', '&' or brace — so it is safe in .env, in sed and as a Caddy site address.
HOST_RE='^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
valid_host() {
  # No newline or other control character either (some regex engines let ^/$ match at a newline).
  case "${1:-}" in *[![:print:]]* | "") return 1 ;; esac
  [[ $1 =~ $HOST_RE ]]
}

# pgdata_exists: our database volume is already there (its passwords must come from the old secrets).
pgdata_exists() { docker volume inspect "${PROJECT}_pgdata" >/dev/null 2>&1; }
