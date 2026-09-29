#!/usr/bin/env bash
# Every 15 minutes (spec §10.2): disk use of /, of $THUAMMAI_HOME and of Docker's data dir, memory,
# whether our db/api/alerts containers run (and are not unhealthy), and restarts of our project's
# containers in the last hour → Kuma "thuammai host":
#   up ok | down <flags> with flags from disk_80, disk_90, mem_90, down_<service>, restarts.
# Read-only on the shared host: it looks (df, /proc/meminfo, docker info/ps/inspect of our own
# project) and writes only $THUAMMAI_HOME/run/restarts.state and its log. It takes no ops lock
# (it changes nothing) — only its own lock on fd 9 (closed for docker), so a hung run never piles up.
set -Eeuo pipefail
# shellcheck source=lib.sh
. "$(dirname "$(readlink -f "$0")")/lib.sh"
mkdir -p "$TH/logs" "$TH/run"

# shellcheck disable=SC2329 # called by the ERR trap
on_err() {
  local rc=$? line="$1"
  [ "$BASHPID" = "$$" ] || return 0
  trap - ERR
  log "hostcheck: unexpected error (exit $rc) at hostcheck.sh line $line"
  kuma host down check_failed
  exit 1
}
trap 'on_err $LINENO' ERR

exec 9>"$TH/run/hostcheck.lock"
flock -n 9 || { log "hostcheck: the previous run is still going — skipped"; exit 0; }
trim_log "$TH/logs/hostcheck.log"

flags=""
add() { case " $flags " in *" $1 "*) ;; *) flags="$flags $1" ;; esac; }

# Disk: /, our home, Docker's data dir (the dump, images and volumes live there).
root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null 9>&- || true)"
for p in / "$TH" ${root:+"$root"}; do
  use="$(df -P "$p" 2>/dev/null | awk 'NR == 2 { gsub("%", "", $5); print $5 }' || true)"
  case "$use" in "" | *[!0-9]*) continue ;; esac
  if [ "$use" -gt 90 ]; then add disk_90; elif [ "$use" -gt 80 ]; then add disk_80; fi
done
# The worst disk wins: disk_90 makes disk_80 redundant.
case " $flags " in *" disk_90 "*) flags="${flags/ disk_80/}" ;; esac

# Memory: less than 10 % of the machine available (MemAvailable; the whole shared host, not just us).
meminfo="${THUAMMAI_MEMINFO:-/proc/meminfo}"
if [ -r "$meminfo" ]; then
  read -r mt ma <<<"$(awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { print t + 0, a + 0 }' "$meminfo")"
  if [ "${mt:-0}" -gt 0 ] && [ $((ma * 10)) -lt "$mt" ]; then add mem_90; fi
fi

# Our long-running services: a running container (not a one-off `compose run`) that is not unhealthy.
for s in db api alerts; do
  st="$(docker ps --filter "label=com.docker.compose.project=$PROJECT" --filter label=com.docker.compose.oneoff=False --filter "label=com.docker.compose.service=$s" --format '{{.Status}}' 2>/dev/null 9>&- | head -n 1 || true)"
  case "$st" in "" | *"(unhealthy)"*) add "down_$s" ;; esac
done

# Restarts: every run stores "<time> <container id> <restart count>" for our containers. Compared with
# the newest sample at least an hour old, per container id (like restarts_ok): a container that was
# there counts its increase, a new id (recreated by a deploy) counts from 0. More than 3 → restarts.
# Lines of the older "<time> <total>" format are ignored (no false alarm right after an upgrade).
state="$TH/run/restarts.state"
now="$(date +%s)"
snap="$(restarts_snapshot 9>&-)"
touch "$state"
ref="$(awk -v t="$((now - 3600))" 'NF == 3 && $1 <= t && $1 > r { r = $1 } END { print r + 0 }' "$state")"
if [ "$ref" -gt 0 ]; then
  delta="$(printf '%s\n' "$snap" | awk -v r="$ref" -v f="$state" '
    BEGIN { while ((getline l < f) > 0) { if (split(l, a, " ") == 3 && a[1] == r) was[a[2]] = a[3] + 0 } }
    NF == 2 && $2 ~ /^[0-9]+$/ { d = $2 - ((($1) in was) ? was[$1] : 0); if (d > 0) s += d }
    END { print s + 0 }')"
  if [ "$delta" -gt 3 ]; then add restarts; fi
fi
# Keep two hours of samples (enough for the newest one at least an hour old).
{
  awk -v t="$((now - 7200))" 'NF == 3 && $1 >= t' "$state"
  printf '%s\n' "$snap" | awk -v n="$now" 'NF == 2 { print n, $1, $2 }'
} >"$state.tmp"
mv -f "$state.tmp" "$state"

flags="${flags# }"
if [ -z "$flags" ]; then kuma host up ok; else kuma host down "${flags// /,}"; fi
log "hostcheck: ${flags:-ok}"
