#!/usr/bin/env bash
# ติดตั้ง relay ข้อมูลถนน/คลอง กทม. บนเครื่องในไทย (Debian/Ubuntu + systemd). รันซ้ำได้.
# ใช้: sudo bash relay/install.sh [RELAY_URL]      (ต้องมี relay/dist/relay.mjs — รัน `node relay/build.mjs` ก่อน)
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "ต้องรันด้วย root (sudo bash relay/install.sh)" >&2
  exit 1
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="$HERE/dist/relay.mjs"
APP=/opt/thuammai-relay
CONF=/etc/thuammai-relay
DEFAULT_URL="https://flood-api.thaiglider.com/v1/relay/bma"
NODE_BIN="$(command -v node || true)"

[ -f "$BUNDLE" ] || { echo "ไม่พบ $BUNDLE — รัน: node relay/build.mjs" >&2; exit 1; }
[ -n "$NODE_BIN" ] || { echo "ไม่พบ node (ต้อง Node 24 ขึ้นไป)" >&2; exit 1; }
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || { echo "ต้องใช้ Node 24 ขึ้นไป (พบ v$NODE_MAJOR)" >&2; exit 1; }

# 1) ผู้ใช้ระบบ
if ! id relay >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin relay
fi

# 2) โปรแกรม
install -d -m 0755 "$APP"
install -m 0644 "$BUNDLE" "$APP/relay.mjs"

# 3) ค่าตั้งค่า + key
install -d -m 0750 -o root -g relay "$CONF"
if [ ! -f "$CONF/env" ]; then
  URL="${1:-$DEFAULT_URL}"
  (umask 077; cat > "$CONF/env" <<ENVEOF
RELAY_URL=$URL
RELAY_KEY_FILE=$CONF/key
# KUMA_PUSH_URL=
ENVEOF
  )
  chown root:relay "$CONF/env"
  chmod 0640 "$CONF/env"
fi

if [ ! -s "$CONF/key" ]; then
  if [ -t 0 ]; then
    printf 'วาง relay_hmac_key (จาก `thuammai relay keys --show` บน VPS) แล้วกด Enter: '
    read -r -s KEY
    echo
  else
    IFS= read -r KEY || true
  fi
  [ -n "${KEY:-}" ] || { echo "ไม่มี key — ใส่เองภายหลังที่ $CONF/key (0600 เจ้าของ relay) แล้วรันสคริปต์นี้ซ้ำ" >&2; exit 1; }
  (umask 077; printf '%s\n' "$KEY" > "$CONF/key")
fi
chown relay:relay "$CONF/key"
chmod 0600 "$CONF/key"

# 4) systemd
cat > /etc/systemd/system/thuammai-relay.service <<UNITEOF
[Unit]
Description=Thuammai BMA relay (fetch road/canal, POST to flood-api)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=relay
Group=relay
EnvironmentFile=$CONF/env
ExecStart=$NODE_BIN $APP/relay.mjs
TimeoutStartSec=120
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6
CapabilityBoundingSet=
LockPersonality=true
UNITEOF

cat > /etc/systemd/system/thuammai-relay.timer <<TIMEREOF
[Unit]
Description=Run the Thuammai BMA relay every 5 minutes (minute 3 of each slot)

[Timer]
OnCalendar=*:03/5
Persistent=false
AccuracySec=10s

[Install]
WantedBy=timers.target
TIMEREOF

systemctl daemon-reload
systemctl enable --now thuammai-relay.timer

echo "ติดตั้งเสร็จ. ตรวจสอบ:"
echo "  systemctl list-timers thuammai-relay.timer"
echo "  systemctl start thuammai-relay.service   # ทดลองรันทันที"
echo "  journalctl -u thuammai-relay -n 20 --no-pager"
