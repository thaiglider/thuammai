#!/bin/sh
# Runs inside the postgis image as the deploy user's uid (compose service "backup").
# pg_dump / pg_restore as the Postgres superuser; the password comes from the secret file.
set -eu
PGPASSWORD="$(cat /run/secrets/pg_superuser)"
export PGPASSWORD PGHOST=db PGUSER=postgres
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in
  dump) pg_dump -Fc -d thuammai -f "$1" ;;
  verify) [ -s "$1" ] && pg_restore --list "$1" >/dev/null ;;
  check)
    # a thuammai dump: its table of contents has our tables (never prints the list itself)
    toc="$(pg_restore --list "$1")" || exit 1
    for t in schema_migrations follow target; do
      printf '%s\n' "$toc" | grep -Eq "^[0-9]+; [0-9]+ [0-9]+ TABLE public $t " || { echo "not a thuammai dump (no table $t)" >&2; exit 1; }
    done ;;
  dbsize) psql -X -At -v ON_ERROR_STOP=1 -d postgres -c "SELECT pg_database_size('thuammai')" ;;
  versions)
    psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "SELECT version FROM schema_migrations ORDER BY 1" ;;
  restore)
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c 'DROP DATABASE IF EXISTS thuammai WITH (FORCE)' -c 'CREATE DATABASE thuammai OWNER thuammai_owner'
    pg_restore -d thuammai --exit-on-error "$1" ;;
  counts)
    psql -X -At -v ON_ERROR_STOP=1 -d "$1" -c "SELECT (SELECT count(*) FROM schema_migrations) || ' ' || (SELECT count(*) FROM target) || ' ' || (SELECT count(*) FROM follow) || ' ' || (SELECT count(*) FROM place)" ;;
  restoretest)
    psql -X -q -v ON_ERROR_STOP=1 -d postgres -c 'DROP DATABASE IF EXISTS restore_check WITH (FORCE)' -c 'CREATE DATABASE restore_check'
    pg_restore -d restore_check --no-owner --exit-on-error "$1" >/dev/null ;;
  droptest) psql -X -q -d postgres -c 'DROP DATABASE IF EXISTS restore_check WITH (FORCE)' ;;
  *) echo "usage: pg-job.sh dump|verify|check|restore <file> | counts|versions <db> | dbsize | restoretest <file> | droptest" >&2; exit 2 ;;
esac
