#!/usr/bin/env bash
# Pull-based deploy with automatic rollback (spec §9.3, R5, R6). Cron runs it every 15 minutes as
# `deploy`; `--now` from `thuammai update now`; `--base` weekly for the Postgres patch image;
# `--rollback` from `thuammai rollback`.
# No down migrations: migrations are expand-only, so going back only switches images — no data is
# ever dropped (a real schema rollback is `thuammai restore predeploy`, a runbook step).
# Lock rules (F2-4): this script takes the ops lock once and, while holding it, calls lib.sh
# functions only — never a `thuammai` subcommand (the lock is not re-entrant). Docker calls run with
# fd 9 closed, so no child can keep the lock alive after we exit.
# Images: we tag only thuammai-local:<id12> (releases) and thuammai-db:<id12> (Postgres) — never a
# public image.
set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

MODE="${1:-}"
case "$MODE" in
  "" | --now | --base | --rollback) ;;
  *) die "usage: update.sh [--now|--base|--rollback]" ;;
esac
mkdir -p "$TH/run" "$TH/logs"
SKIPS="$TH/run/update-skipped"

# take_lock: the ops lock for this run. Cron (no argument) skips quietly when another job holds it and
# counts the skips in a row in run/update-skipped (Kuma's 60-minute deploy monitor goes down by itself
# when nothing is pushed for that long); `update now` says "busy"; --base and --rollback wait.
take_lock() {
  local n
  case "$MODE" in
    "")
      if ops_lock nowait; then
        rm -f "$SKIPS"
        return 0
      fi
      n="$(cat "$SKIPS" 2>/dev/null || true)"
      case "$n" in "" | *[!0-9]*) n=0 ;; esac
      n=$((n + 1))
      printf '%s\n' "$n" >"$SKIPS"
      log "update: another thuammai job holds the lock — skipped ($n in a row)"
      exit 0
      ;;
    --now)
      ops_lock nowait && return 0
      say "busy: another thuammai job (update, backup or restore) is running — try again in a few minutes / ไม่ว่าง: มีงานอื่นของ thuammai กำลังทำงาน ลองใหม่อีกสักครู่"
      exit 1
      ;;
    *)
      ops_lock nowait && return 0
      if [ "$MODE" = --rollback ]; then
        say "waiting for another thuammai job (update, backup or restore) to finish … / รองานอื่นของ thuammai ให้เสร็จก่อน …"
      else
        log "update: waiting for another thuammai job"
      fi
      ops_lock wait || die "another thuammai job (update, backup or restore) is still running — try again later / มีงานอื่นของ thuammai กำลังทำงาน ลองใหม่ภายหลัง"
      ;;
  esac
}
take_lock
trim_log "$TH/logs/update.log"
touch "$TH/run/bad-digests"

# A restore that did not finish leaves api/alerts stopped on a database that may be half-restored:
# no deploy, no base update, no rollback until the owner finishes it (restore.sh removes the mark).
# At stage data_restored (pg_restore and migrate finished, only the health gate failed) the data is
# complete and the release may be the problem: `thuammai rollback` runs, and a healthy rollback
# removes the mark.
if [ -e "$RESTORE_MARK" ]; then
  if [ "$MODE" = --rollback ] && [ "$(restore_stage)" = data_restored ]; then
    log "update: a restore finished its data but not its health check — rolling back as asked"
  else
    kuma deploy down restore_incomplete
    log "update: a restore did not finish — not updating. Put the database back first: $(restore_hint)"
    exit 1
  fi
fi

# RC: the exit status. A failure we handle (and report to Kuma) sets RC=1 and returns 0, so the ERR
# trap below only ever sees what nothing handled — a failed restart snapshot, prune, cron_install … —
# and reports that as deploy_error instead of leaving Kuma on its last message.
RC=0
# shellcheck disable=SC2329 # called by the ERR trap
on_err() {
  local rc=$? line="$1"
  [ "$BASHPID" = "$$" ] || return 0
  trap - ERR
  log "update: unexpected error (exit $rc) at update.sh line $line"
  kuma deploy down deploy_error
}
trap 'on_err $LINENO' ERR

# version_of <tag>: the image's version label (e.g. server-v2026.10.01.1), safe for a Kuma message.
version_of() {
  local v
  v="$(tr -cd 'A-Za-z0-9._-' 2>/dev/null <"$(release_dir "$1")/VERSION" || true)"
  printf '%s' "${v:-$1}"
}
is_bad() { grep -qxF "$1" "$TH/run/bad-digests"; }
mark_bad() { is_bad "$1" || printf '%s\n' "$1" >>"$TH/run/bad-digests"; }

# public_check: /v1/health through the shared Caddy (after `thuammai finish` only). Its result never
# causes a rollback — Caddy is not ours — it is reported as public_route_failed.
public_check() {
  [ "$(env_get FINISHED)" = 1 ] || return 0
  curl_api -f "https://$(env_get API_HOST)/v1/health" >/dev/null 2>&1
}

# switch_to <tag>: make <tag> the current release (symlink, IMAGE_TAG, crontab block from it).
switch_to() {
  ln -sfn "releases/$1" "$TH/current"
  env_set IMAGE_TAG "$1"
  cron_install
}

deploy() {
  local ref="$1" tag="$2" old ver before
  old="$(current_tag)"
  # Take the image into use first (cheap, no side effects on the running release) …
  if ! docker tag "$ref" "$LOCAL_IMAGE:$tag" 9>&- || ! extract_release "$tag" "$LOCAL_IMAGE:$tag" 9>&-; then
    kuma deploy down pull_failed
    log "update: could not take $tag into use (tag or extract of /app/infra failed)"
    RC=1
    return 0
  fi
  ver="$(version_of "$tag")"
  # … then back up, before anything touches the database.
  if ! pg_backup predeploy "$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null; then
    kuma deploy down predeploy_backup_failed
    log "update: pre-deploy backup failed — not deploying $ver"
    RC=1
    return 0
  fi
  prune_predeploy 3
  # The old release keeps running while the new image migrates (expand-only schema, spec §5.4).
  if ! compose_in "$tag" --profile tools run --rm --no-deps -T migrate; then
    mark_bad "$tag"
    kuma deploy down migrate_failed
    log "update: migrate of $ver failed — the old release keeps running; $tag is marked bad"
    RC=1
    return 0
  fi
  before="$(restarts_snapshot)"
  if stack_up "$tag" --remove-orphans && gate "$tag" "$before"; then
    printf '%s\n' "$old" >"$TH/run/previous"
    switch_to "$tag"
    if public_check; then kuma deploy up "deployed_$ver"; else kuma deploy down public_route_failed; fi
    prune_releases 3
    log "update: deployed $ver ($tag)"
    return 0
  fi
  mark_bad "$tag"
  RC=1
  log "update: $ver failed the health gate — rolling back to $(version_of "$old"); $tag is marked bad"
  before="$(restarts_snapshot)"
  if stack_up "$old" --remove-orphans && gate "$old" "$before"; then
    kuma deploy down "rollback_$ver"
    log "update: rolled back to $(version_of "$old")"
  else
    kuma deploy down rollback_failed
    log "update: the rollback to $(version_of "$old") did not become healthy either — see: thuammai status, thuammai logs"
  fi
}

update_image() {
  local ref="$IMAGE:stable" tag
  if [ "${THUAMMAI_NO_PULL:-0}" != 1 ]; then
    if ! docker pull -q "$ref" >/dev/null 2>&1 9>&-; then
      kuma deploy down pull_failed
      log "update: pull of $ref failed"
      RC=1
      return 0
    fi
  fi
  if ! tag="$(image_tag "$ref" 9>&-)"; then
    kuma deploy down pull_failed
    log "update: no local $ref"
    RC=1
    return 0
  fi
  if [ "$tag" = "$(current_tag)" ]; then
    kuma deploy up ok
    return 0
  fi
  if is_bad "$tag"; then
    # Stays red until a new :stable arrives — a rollback never goes quiet on the next run.
    kuma deploy down stable_is_bad
    log "update: :stable ($tag) is marked bad — waiting for a new release (or: thuammai update retry $tag)"
    return 0
  fi
  deploy "$ref" "$tag"
}

# restart_db_stack: recreate db from DB_IMAGE, then make sure api/alerts run.
restart_db_stack() { compose up -d --wait db && compose up -d api alerts; }

# prune_db_images <keep…>: remove our thuammai-db:<id12> tags except the given ones (only the tag —
# the public image itself is untouched).
prune_db_images() {
  local t k skip
  for t in $(docker image ls "$DB_LOCAL" --format '{{.Repository}}:{{.Tag}}' 2>/dev/null 9>&- | grep -E "^$DB_LOCAL:[0-9a-f]{12}\$" || true); do
    skip=0
    for k in "$@"; do if [ "$t" = "$k" ]; then skip=1; fi; done
    if [ "$skip" = 0 ]; then docker image rm "$t" >/dev/null 2>&1 9>&- || true; fi
  done
}

# Weekly (R6): a newer patch of the pinned Postgres major through the same health gate. The db runs
# our own tag (DB_IMAGE=thuammai-db:<id12>); a new upstream id gets its own tag, and on failure
# DB_IMAGE simply goes back to the old tag. Current and one previous tag are kept.
update_base() {
  local tag cid old up new_id new_tag before
  tag="$(current_tag)"
  cid="$(compose ps -q db 2>/dev/null | head -n 1 || true)"
  if [ -z "$cid" ]; then
    kuma deploy down base_skipped
    die "the db container is not running — weekly Postgres image check skipped (thuammai status)"
  fi
  if ! db_pin; then
    kuma deploy down pull_failed
    log "update: could not pin the running Postgres image"
    RC=1
    return 0
  fi
  old="$(env_get DB_IMAGE)"
  up="$(db_upstream)"
  if [ "${THUAMMAI_NO_PULL:-0}" != 1 ] && ! docker pull -q "$up" >/dev/null 2>&1 9>&-; then
    kuma deploy down pull_failed
    log "update: pull of $up failed"
    RC=1
    return 0
  fi
  new_id="$(docker image inspect -f '{{.Id}}' "$up" 2>/dev/null 9>&- || true)"
  new_id="${new_id#sha256:}"
  if [ -z "$new_id" ]; then
    kuma deploy down pull_failed
    log "update: no local $up after the pull"
    RC=1
    return 0
  fi
  new_tag="$DB_LOCAL:${new_id:0:12}"
  if [ "$new_tag" = "$old" ]; then
    kuma deploy up base_current
    return 0
  fi
  if ! pg_backup predeploy "base-$(date -u +%Y%m%dT%H%M%SZ)" >/dev/null; then
    kuma deploy down predeploy_backup_failed
    log "update: pre-update backup failed — Postgres image not changed"
    RC=1
    return 0
  fi
  prune_predeploy 3
  docker tag "$new_id" "$DB_LOCAL:${new_id:0:12}" 9>&-
  env_set DB_IMAGE "$new_tag"
  before="$(restarts_snapshot)"
  if restart_db_stack && gate "$tag" "$before"; then
    prune_db_images "$new_tag" "$old"
    kuma deploy up base_updated
    log "update: Postgres image $old → $new_tag"
    return 0
  fi
  RC=1
  log "update: Postgres $new_tag failed the health gate — going back to $old"
  env_set DB_IMAGE "$old"
  before="$(restarts_snapshot)"
  if restart_db_stack && gate "$tag" "$before"; then
    kuma deploy down base_rollback
  else
    kuma deploy down rollback_failed
    log "update: Postgres did not become healthy on $old either — see: thuammai status"
  fi
  docker image rm "$new_tag" >/dev/null 2>&1 9>&- || true
}

# thuammai rollback: back to run/previous by hand; the release we leave is marked bad (only once the
# previous one is healthy). run/previous is used up, so a second rollback cannot ping-pong and mark
# the good release bad.
manual_rollback() {
  local prev cur before
  prev="$(cat "$TH/run/previous" 2>/dev/null || true)"
  cur="$(current_tag)"
  if [ -z "$prev" ] || [ "$prev" = "$cur" ] || [ ! -f "$(release_dir "$prev")/compose.yaml" ]; then
    die "no previous release to roll back to / ไม่มีรุ่นก่อนหน้าให้ย้อนกลับ"
  fi
  before="$(restarts_snapshot)"
  if ! { stack_up "$prev" --remove-orphans && gate "$prev" "$before"; }; then
    kuma deploy down rollback_failed
    log "update: $(version_of "$prev") did not become healthy — starting $(version_of "$cur") again"
    stack_up "$cur" --remove-orphans || true
    die "the previous release did not become healthy; $(version_of "$cur") was started again / รุ่นก่อนหน้าไม่ผ่านการตรวจ"
  fi
  switch_to "$prev"
  mark_bad "$cur"
  rm -f "$TH/run/previous"
  if [ "$(restore_stage)" = data_restored ]; then
    rm -f "$RESTORE_MARK"
    log "update: the restored data runs healthy on $(version_of "$prev") — restore finished"
  fi
  kuma deploy down manual_rollback
  log "update: rolled back to $(version_of "$prev") by hand; $(version_of "$cur") ($cur) is marked bad"
  say "rolled back to $(version_of "$prev") / ย้อนกลับแล้ว"
}

case "$MODE" in
  "" | --now) update_image ;;
  --base) update_base ;;
  --rollback) manual_rollback ;;
esac
exit "$RC"
