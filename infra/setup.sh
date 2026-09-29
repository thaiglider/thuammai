#!/usr/bin/env bash
# thuammai — first install on the shared VPS, as the `deploy` user, never as root (spec §9.2, C2).
#   curl -fsSL https://raw.githubusercontent.com/thaiglider/thuammai/<server-v… tag>/infra/setup.sh -o setup.sh
#   less setup.sh && bash setup.sh [--non-interactive] [--telegram-token-file <path>] [--restore-from export:<file>|restic]
# This file only checks the machine, creates $THUAMMAI_HOME, pulls the image and extracts infra/
# from it; the rest is `thuammai install` from that release (F2-3). It changes nothing outside
# $THUAMMAI_HOME except our own image tag.
set -euo pipefail
TH="${THUAMMAI_HOME:-$HOME/thuammai}"
IMAGE="${THUAMMAI_IMAGE:-ghcr.io/thaiglider/thuammai-server}"
REF="${THUAMMAI_IMAGE_REF:-$IMAGE:stable}"
say() { printf '%s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }

[ "$(id -u)" != 0 ] || die "run this as the deploy user, not as root / ให้รันด้วยผู้ใช้ deploy ไม่ใช่ root"
command -v docker >/dev/null || die "docker is not installed"
docker info >/dev/null 2>&1 || die "docker does not work for $(id -un) without root — the user must be in the docker group"
docker compose version >/dev/null 2>&1 || die "docker compose (v2 or newer) is missing"
[ "$(uname -m)" = x86_64 ] || die "this machine is $(uname -m); the image is linux/amd64 only — add linux/arm64 to release/workflows/server-image.yml first (C1)"
for c in flock curl openssl crontab awk sed diff; do command -v "$c" >/dev/null || die "missing command: $c"; done
grep -q 'VERSION_ID="24.04"' /etc/os-release 2>/dev/null || say "WARNING: this is not Ubuntu 24.04 — continuing"
net="${PROXY_NETWORK:-ai-stack_ai-stack}"
docker network inspect "$net" >/dev/null 2>&1 || die "docker network $net not found (the shared Caddy's network)"
docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net" | tr ' ' '\n' | grep -qx caddy || die "container 'caddy' is not on $net"
# Kuma answers as "uptime-kuma" on that network: a container of that name, or one with that network
# alias (read-only look at the containers on $net).
kuma_on_net() {
  local id names
  docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$net" | tr ' ' '\n' | grep -qx uptime-kuma && return 0
  # shellcheck disable=SC2016 # a Go template, not a shell expansion
  for id in $(docker network inspect -f '{{range $id, $c := .Containers}}{{$id}} {{end}}' "$net" 2>/dev/null); do
    names="$(docker inspect -f "{{with index .NetworkSettings.Networks \"$net\"}}{{range .Aliases}}{{.}} {{end}}{{end}}" "$id" 2>/dev/null || true)"
    # Newer Docker lists the names a container answers to as DNSNames (aliases included).
    names="$names $(docker inspect -f "{{with index .NetworkSettings.Networks \"$net\"}}{{range .DNSNames}}{{.}} {{end}}{{end}}" "$id" 2>/dev/null || true)"
    # shellcheck disable=SC2086 # split the list of names on purpose
    printf '%s\n' $names | grep -qx uptime-kuma && return 0
  done
  return 1
}
kuma_on_net || say "WARNING: nothing answers as 'uptime-kuma' on $net (no container of that name or alias) — Kuma pushes (http://uptime-kuma:3001) will fail until it does"
free_mb="$(awk '/MemAvailable/ { print int($2 / 1024) }' /proc/meminfo)"
[ "$free_mb" -ge 2048 ] || say "WARNING: only ${free_mb} MiB RAM available (2 GiB recommended) — continuing"

mkdir -p "$TH"
chmod 750 "$TH"
free_gb="$(df -P "$TH" | awk 'NR == 2 { print int($4 / 1048576) }')"
[ "$free_gb" -ge 10 ] || say "WARNING: only ${free_gb} GB disk free (10 GB recommended) — continuing"
mkdir -p "$TH/releases" "$TH/logs" "$TH/run" "$TH/exports" "$TH/restore" "$TH/secrets" "$TH/backups/daily" "$TH/backups/predeploy"
chmod 700 "$TH/secrets" "$TH/exports" "$TH/restore"
chmod 700 "$TH/backups" "$TH/backups/daily" "$TH/backups/predeploy"

if [ "${THUAMMAI_NO_PULL:-0}" != 1 ]; then docker pull -q "$REF" >/dev/null || die "cannot pull $REF — is the GHCR package public? (owner guide, step 3)"; fi
id="$(docker image inspect -f '{{.Id}}' "$REF")"
tag="${id#sha256:}"
tag="${tag:0:12}"
docker tag "$REF" "thuammai-local:$tag"
dir="$TH/releases/$tag"
if [ ! -f "$dir/compose.yaml" ]; then
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp"
  cid="$(docker create "thuammai-local:$tag" true)"
  docker cp "$cid:/app/infra/." "$dir.tmp/" >/dev/null
  docker rm "$cid" >/dev/null
  printf '%s\n' "$tag" >"$dir.tmp/DIGEST"
  docker image inspect -f '{{index .Config.Labels "org.opencontainers.image.version"}}' "thuammai-local:$tag" >"$dir.tmp/VERSION"
  chmod +x "$dir.tmp"/bin/* "$dir.tmp/setup.sh"
  mv "$dir.tmp" "$dir"
fi
ln -sfn "releases/$tag" "$TH/current"
exec bash "$TH/current/bin/thuammai" install "$@"
