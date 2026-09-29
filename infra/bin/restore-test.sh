#!/usr/bin/env bash
# Monthly (day 1, 04:00 — spec §11.2) and `thuammai restore-test`: restore the newest nightly dump
# into the throwaway database "restore_check" (created by the backup container on our internal
# network, dropped afterwards) and check it:
#   - its schema_migrations is a non-empty subset of the migrations the current release image ships
#     (an older dump may have fewer — migrate adds them on a real restore — but never an unknown one);
#   - target/follow/place row counts within 20 % of the live database.
# The live database "thuammai" is only read (size, counts). Free space in Docker's data dir is checked
# first: the live database's size plus a margin (unknown free space fails).
# Kuma "thuammai backup": up restore_test_ok | down restore_test_failed.
# Lock rules (F2-4): the ops lock is taken once (waits ≤ 15 min, e.g. for the 03:30 backup); while it
# is held only lib.sh functions run — never a `thuammai` subcommand; docker runs with fd 9 closed.
set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
mkdir -p "$TH/logs" "$TH/run"

SCRATCH=0
# drop_scratch: remove the throwaway database (on every exit once it may exist).
drop_scratch() {
  [ "$SCRATCH" = 1 ] || return 0
  SCRATCH=0
  compose --profile tools run --rm --no-deps -T backup droptest >/dev/null 2>&1 || log "restore-test: could not drop restore_check"
}
trap drop_scratch EXIT
fail() {
  drop_scratch
  kuma backup down restore_test_failed
  die "restore-test: $1"
}
# shellcheck disable=SC2329 # called by the ERR trap
on_err() {
  local rc=$? line="$1"
  [ "$BASHPID" = "$$" ] || return 0
  trap - ERR
  log "restore-test: unexpected error (exit $rc) at restore-test.sh line $line"
  drop_scratch
  kuma backup down restore_test_failed
  exit 1
}
trap 'on_err $LINENO' ERR

ops_lock wait || { kuma backup down restore_test_failed; die "restore-test: another thuammai job held the lock for 15 minutes"; }
trim_log "$TH/logs/backup.log"

# The newest nightly dump (YYYY-MM-DD.dump) — never an export or a pre-restore safety dump.
latest="$(newest "$TH/backups/daily" '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].dump')"
[ -n "$latest" ] || fail "no nightly dump yet"
# The scratch database grows in Docker's data dir: check the room before anything is created.
# It needs about as much as the live database (pg_database_size) plus the margin; an unknown answer
# from df fails the test too — better a red monitor than a full disk under the live Postgres.
root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null 9>&- || true)"
size="$(compose --profile tools run --rm --no-deps -T backup dbsize 2>/dev/null | tail -n 1 | tr -d '\r')" || fail "could not read the size of the live database"
case "$size" in "" | *[!0-9]*) fail "could not read the size of the live database" ;; esac
disk_room "${root:-/}" $(((size + 1023) / 1024)) strict "the live database's size" || fail "not enough disk (or free space unknown) for the scratch database (Docker data dir ${root:-/})"
# The migrations this release ships: the image's server/migrations/*.sql, without ".sql".
shipped="$(image_run node -e 'for (const n of require("fs").readdirSync("server/migrations").sort()) if (n.endsWith(".sql")) console.log(n.slice(0, -4))' 2>/dev/null)" || fail "could not list the release image's migrations"
[ -n "$shipped" ] || fail "the release image lists no migrations"

SCRATCH=1
compose --profile tools run --rm --no-deps -T backup restoretest "/backups/daily/$latest" >/dev/null 2>&1 || fail "pg_restore of $latest into restore_check failed"
live="$(compose --profile tools run --rm --no-deps -T backup counts thuammai 2>/dev/null | tail -n 1)" || fail "could not count rows in the live database"
test="$(compose --profile tools run --rm --no-deps -T backup counts restore_check 2>/dev/null | tail -n 1)" || fail "could not count rows in restore_check"
restored="$(compose --profile tools run --rm --no-deps -T backup versions restore_check 2>/dev/null)" || fail "could not read schema_migrations of restore_check"
drop_scratch

num4='^[0-9]+ [0-9]+ [0-9]+ [0-9]+$'
[[ $live =~ $num4 ]] || fail "unexpected counts from the live database"
[[ $test =~ $num4 ]] || fail "unexpected counts from restore_check"
read -r lm lt lf lp <<<"$live"
read -r _ tt tf tp <<<"$test"

n=0
while IFS= read -r v; do
  v="${v%$'\r'}"
  [ -n "$v" ] || continue
  [[ $v =~ ^[A-Za-z0-9._-]+$ ]] || fail "unexpected schema_migrations entry in the dump"
  grep -qxF -- "$v" <<<"$shipped" || fail "the dump has migration $v, which this release does not ship"
  n=$((n + 1))
done <<<"$restored"
[ "$n" -gt 0 ] || fail "the dump has no applied migrations"

# within <a> <b>: |a-b| ≤ 20 % of the larger one
within() {
  local a="$1" b="$2" hi d
  hi=$((a > b ? a : b))
  d=$((a > b ? a - b : b - a))
  [ $((d * 5)) -le "$hi" ]
}
if ! { within "$lt" "$tt" && within "$lf" "$tf" && within "$lp" "$tp"; }; then
  fail "row counts differ by more than 20 % (live $lt/$lf/$lp, restored $tt/$tf/$tp target/follow/place)"
fi
log "restore-test: ok ($latest; $n migrations restored, $lm live; $tt/$tf/$tp target/follow/place)"
kuma backup up restore_test_ok
