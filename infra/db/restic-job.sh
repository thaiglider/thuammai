#!/bin/sh
# Runs inside restic/restic (compose service "offsite"), disabled until `thuammai offsite setup` (C5).
# Destination credentials are KEY=value lines in /run/secrets/restic_env — sourced here, never
# container environment (R4, F7).
set -eu
if [ -s /run/secrets/restic_env ]; then set -a; . /run/secrets/restic_env; set +a; fi
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  init) restic init ;;
  backup)
    restic backup --no-scan --host thuammai --tag nightly "/data/daily/$1" /data/config/.env /data/config/secrets
    # 14 daily snapshots and nothing monthly: the privacy text says backups are gone within 14 days (R23).
    restic forget --host thuammai --keep-daily 14 --prune ;;
  check) restic check --read-data-subset=5% ;;
  snapshots) restic snapshots --host thuammai --compact ;;
  restore) restic restore latest --host thuammai --target /restore ;;
  *) echo "usage: restic-job.sh init | backup <dump> | check | snapshots | restore" >&2; exit 2 ;;
esac
