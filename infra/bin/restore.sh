#!/usr/bin/env bash
# thuammai restore [--yes] [--no-safety-dump] <daily/<file>.dump|predeploy/<file>.dump|predeploy>
# (spec §11.3, runbook docs/ops/vps-restore.md). Replaces OUR live database (database "thuammai" in
# the project's own db container — nothing else) with a dump:
#   confirm → ops lock → the file is a readable thuammai dump (pg_restore --list has our tables) →
#   safety dump of the current database (daily/prerestore-<UTC>.dump; its failure stops everything
#   unless --no-safety-dump) → run/restore-incomplete (stage=stopping) → stop api + alerts (no alert,
#   no sign-up while the data changes) → DROP/CREATE + pg_restore → migrate → stage=data_restored →
#   start api + alerts → health gate → remove run/restore-incomplete.
# While the mark says stopping (the database may be incomplete), update.sh, backup.sh, pause, resume,
# restart, telegram token, kuma and install refuse to run, and every failure prints the exact command that puts the
# old data back. At data_restored only `thuammai rollback` runs (the data is complete; the release may
# be what fails). A restore started while the mark exists takes no new safety dump and keeps pointing
# at the first one.
# ALERTS_PAUSED in .env is not touched: a paused site stays paused, a running one runs again.
# Lock rules (F2-4): the ops lock is taken once (waits ≤ 15 min); while it is held only lib.sh
# functions run — never a `thuammai` subcommand; docker runs with fd 9 closed.
set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"

USAGE="usage: thuammai restore [--yes] [--no-safety-dump] <daily/YYYY-MM-DD.dump|predeploy>"
yes=0
safety_dump=1
arg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --yes) yes=1 ;;
    --no-safety-dump) safety_dump=0 ;;
    -*) die "$USAGE" ;;
    *) [ -z "$arg" ] || die "$USAGE"; arg="$1" ;;
  esac
  shift
done
[ -n "$arg" ] || die "$USAGE"
if [ "$arg" = predeploy ]; then
  f="$(newest "$TH/backups/predeploy" '*.dump')"
  [ -n "$f" ] || die "no pre-deploy dump yet (backups/predeploy is empty)"
  rel="predeploy/$f"
else
  rel="${arg#"$TH/backups/"}"
fi
# Only a plain file directly under backups/daily or backups/predeploy: no .., no other directory,
# no odd characters, no symlink (it could point anywhere on the host).
[[ $rel =~ ^(daily|predeploy)/[A-Za-z0-9][A-Za-z0-9._-]*\.dump$ ]] || die "only files under backups/daily or backups/predeploy (e.g. daily/2026-09-28.dump)"
case "$rel" in *..*) die "no .. in the path" ;; esac
[ ! -L "$TH/backups/$rel" ] || die "$rel is a symlink — not restoring it"
[ -f "$TH/backups/$rel" ] || die "no such backup: $rel (see: ls $TH/backups/daily $TH/backups/predeploy)"

if [ "$yes" != 1 ]; then
  say "This REPLACES the live database with $rel ($(date -u -r "$TH/backups/$rel" +%Y-%m-%dT%H:%MZ))."
  say "Everything written after that time is lost (a safety dump of the current data is taken first)."
  say "If the dump is older than a few hours, run 'thuammai pause' first so no old alert is sent again."
  say "จะแทนที่ฐานข้อมูลปัจจุบันด้วย $rel — ข้อมูลหลังเวลานั้นจะหาย (ระบบสำรองข้อมูลปัจจุบันไว้ก่อน)"
  printf 'Type y to restore / พิมพ์ y เพื่อกู้คืน [y/N]: '
  answer=""
  IFS= read -r answer || true
  case "$answer" in y | Y | yes | YES) ;; *) die "not restored (no confirmation) / ยกเลิก ไม่ได้กู้คืน" ;; esac
fi

STOPPED=0
# RESTORED=1 once the mark says stage=data_restored (the data is complete; only the release may fail).
RESTORED=0
# broken <message>: a failure after api/alerts were stopped — the data may be half-restored.
broken() {
  die "$1 — the database may be incomplete (api/alerts may be stopped). Put the old data back with: $(restore_hint) / ข้อมูลอาจไม่ครบ กู้คืนข้อมูลเดิมด้วยคำสั่งด้านบน"
}
# unhealthy <message>: the data was restored and migrated, but the release does not come up on it.
unhealthy() {
  die "$(restored_text "$1")"
}
# restored_text <what failed>: the advice once the data is restored and migrated.
restored_text() {
  printf '%s' "$1 — the data IS restored (run/restore-incomplete says stage=data_restored). See: thuammai logs. To go back to the previous release: thuammai rollback. To put the old data back: $(restore_hint)"
}
# shellcheck disable=SC2329 # called by the ERR trap
on_err() {
  local rc=$? line="$1"
  [ "$BASHPID" = "$$" ] || return 0
  trap - ERR
  if [ "$RESTORED" = 1 ]; then
    log "restore: $(restored_text "unexpected error (exit $rc) at restore.sh line $line")" >&2
  elif [ "$STOPPED" = 1 ]; then
    log "restore: unexpected error (exit $rc) at restore.sh line $line — api/alerts may be stopped and the database incomplete. Put the old data back with: $(restore_hint)" >&2
  else
    log "restore: unexpected error (exit $rc) at restore.sh line $line — nothing was changed" >&2
  fi
  exit 1
}
trap 'on_err $LINENO' ERR

ops_lock wait || die "another thuammai job (update or backup) is still running — nothing changed; try again later / มีงานอื่นของ thuammai กำลังทำงาน ลองใหม่ภายหลัง"
mkdir -p "$TH/logs" "$TH/run"

# The file must be a complete dump of OUR database before anything is touched.
if ! compose --profile tools run --rm --no-deps -T backup verify "/backups/$rel" >/dev/null 2>&1 ||
  ! compose --profile tools run --rm --no-deps -T backup check "/backups/$rel" >/dev/null 2>&1; then
  die "$rel is not a thuammai dump (unreadable, or without our tables) — nothing changed / ไฟล์นี้ไม่ใช่ข้อมูลสำรองของ thuammai ไม่ได้เปลี่ยนอะไร"
fi

before="$(restarts_snapshot)"
safety=""
if [ -e "$RESTORE_MARK" ]; then
  # The live database is what a failed restore left behind: never overwrite the pointer to the
  # dump taken before that first attempt.
  safety="$(sed -n 's/^safety=//p' "$RESTORE_MARK" | tail -n 1)"
  log "restore: a previous restore did not finish — no new safety dump (the one from before it: ${safety:-none})"
elif [ "$safety_dump" = 1 ]; then
  if ! safety="$(pg_backup daily "prerestore-$(date -u +%Y%m%dT%H%M%SZ)")"; then
    die "could not save the current database first (safety dump failed — full disk, or a broken database?) — nothing changed. If the current data is not worth keeping: thuammai restore --yes --no-safety-dump $rel"
  fi
  log "restore: current database saved as $safety"
else
  log "restore: --no-safety-dump — the current database is NOT saved"
fi

# write_mark <stage>: run/restore-incomplete, replaced atomically.
write_mark() {
  {
    printf 'stage=%s\n' "$1"
    printf 'release=%s\n' "$(current_tag)"
    printf 'target=%s\n' "$rel"
    printf 'safety=%s\n' "$safety"
    printf 'at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$RESTORE_MARK.tmp"
  mv -f "$RESTORE_MARK.tmp" "$RESTORE_MARK"
}
write_mark stopping

log "restore: $rel — stopping api and alerts"
STOPPED=1
compose stop api alerts || broken "could not stop api/alerts"
compose --profile tools run --rm --no-deps -T backup restore "/backups/$rel" >/dev/null 2>&1 || broken "restore of $rel failed"
compose --profile tools run --rm --no-deps -T migrate || broken "migrations failed after restoring $rel"
# The data is complete now. What is left is starting the release on it: a failure from here on is a
# release problem, so `thuammai rollback` must still work (update.sh --rollback allows this stage),
# while cron updates, backups and pause/resume keep waiting for the owner.
write_mark data_restored
RESTORED=1
compose up -d api alerts || unhealthy "could not start api/alerts after restoring $rel"
gate "$(current_tag)" "$before" || unhealthy "api/alerts did not pass the health check after restoring $rel"
rm -f "$RESTORE_MARK"
STOPPED=0
RESTORED=0
log "restore: done ($rel)"
if [ "$(env_get ALERTS_PAUSED)" = 1 ]; then say "restored. Alerts are still paused — 'thuammai resume' when you have checked the data."; fi
