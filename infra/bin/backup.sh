#!/usr/bin/env bash
# Nightly 03:30 (spec §11.1, R23) and `thuammai backup now`: pg_dump -Fc with the db's own image
# (compose service "backup", DB_IMAGE) → verify with pg_restore --list → 0600, atomic rename →
# drop dumps (daily, pre-deploy) and exports older than 14 days → restic off-site copy when it is set up (off by default, C5).
# Kuma "thuammai backup": up ok | up offsite_missing | down backup_failed | backup_locked |
# offsite_failed | offsite_check_failed | restore_incomplete (a restore stopped half-way: no backup).
# Lock rules (F2-4): the ops lock is taken once (waits ≤ 15 min for an update/restore); while it is
# held only lib.sh functions run — never a `thuammai` subcommand; docker runs with fd 9 closed.
# Never logs a secret (the restic repository URL can hold credentials) or anything from the dump.
set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
mkdir -p "$TH/logs" "$TH/run"

# A failure handled below pushes its own message and exits through die (no ERR trap); anything
# nothing handled lands here and is reported as backup_failed rather than leaving Kuma green.
# shellcheck disable=SC2329 # called by the ERR trap
on_err() {
  local rc=$? line="$1"
  [ "$BASHPID" = "$$" ] || return 0
  trap - ERR
  log "backup: unexpected error (exit $rc) at backup.sh line $line"
  kuma backup down backup_failed
  exit 1
}
trap 'on_err $LINENO' ERR

ops_lock wait || { kuma backup down backup_locked; die "backup: another thuammai job held the lock for 15 minutes"; }
trim_log "$TH/logs/backup.log"
# A restore stopped half-way: tonight's dump would be of a half-restored database — and would rotate
# out a good one. The owner finishes the restore first.
if restore_blocking; then
  kuma backup down restore_incomplete
  die "backup: a restore did not finish — not backing up. Put the database back first: $(restore_hint)"
fi

rel=""
rel="$(pg_backup daily "$(date +%F)")" || { kuma backup down backup_failed; die "backup: dump or its verification failed — the older dumps are kept"; }
name="$(basename "$rel")"
# Only now that today's dump is verified: 14 days (R23 — the privacy text promises no older copy).
# Nightly dumps go by the date in their name (a restored or copied file keeps its day); every other
# dump here (prerestore-*, leftovers) by its age.
cutoff="$(date -d '14 days ago' +%F)"
for f in "$TH/backups/daily"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump; do
  [ -f "$f" ] || continue
  d="$(basename "$f" .dump)"
  if [[ ! $d > $cutoff ]]; then rm -f -- "$f"; fi
done
find "$TH/backups/daily" -maxdepth 1 -type f -name '*.dump' ! -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump' -mtime +13 -delete
find "$TH/backups/daily" -maxdepth 1 -type f -name '*.dump.tmp' -mmin +360 -delete
# The promise covers every copy on the VPS (final review I3): pre-deploy dumps (base-* too; update.sh
# also keeps at most 3) and recovery bundles in exports/ go after 14 days as well — the newest
# pre-deploy dump stays only while it is younger than that.
[ ! -d "$TH/backups/predeploy" ] || find "$TH/backups/predeploy" -maxdepth 1 -type f -name '*.dump' -mtime +13 -delete
[ ! -d "$TH/exports" ] || find "$TH/exports" -maxdepth 1 -type f -name '*.tar.enc' -mtime +13 -delete

msg=ok
if [ -s "$TH/secrets/restic_repository" ]; then
  if ! compose --profile tools run --rm --no-deps -T offsite backup "$name" >/dev/null 2>&1; then
    kuma backup down offsite_failed
    die "backup: off-site copy of $name failed (the local dump is kept) — see: thuammai offsite"
  fi
  log "backup: offsite backup $name done"
  if [ "$(date +%u)" = 7 ] && ! compose --profile tools run --rm --no-deps -T offsite check >/dev/null 2>&1; then
    kuma backup down offsite_check_failed
    die "backup: weekly restic check failed"
  fi
else
  # Not an error (up), but visible: until off-site exists, losing the VPS loses every follower (C5).
  msg=offsite_missing
fi
size="$(du -h "$TH/backups/$rel" 2>/dev/null | cut -f1 || true)"
log "backup: $name ${size:-?} $msg"
kuma backup up "$msg"
