# relay ข้อมูลถนน/คลอง กทม.

รันบนเครื่องเล็กที่มี IP ไทย (BMA เปิดให้เฉพาะ IP ในไทย) ทุก 5 นาที: ดึงเซนเซอร์น้ำท่วมถนน (Directus `sensor_flood`) และระดับน้ำคลอง (`PageMap/GoogleMap`) ของ กทม. → ย่อเป็น JSON → gzip → เซ็น HMAC-SHA256 → `POST` ไป `https://flood-api.thaiglider.com/v1/relay/bma`
ไม่เปิด port ขาเข้า และไม่มี dependency (ใช้ Node 24 ล้วน)

## ติดตั้ง

ต้องการ: Linux + systemd, Node 24+, สิทธิ์ root

```bash
git clone https://github.com/thaiglider/thuammai.git && cd thuammai
npm ci && node relay/build.mjs        # ได้ relay/dist/relay.mjs (หรือคัดลอกไฟล์ที่ build แล้วมาไว้ที่นั่น)
sudo bash relay/install.sh            # จะถาม relay_hmac_key
```

`relay_hmac_key` ได้จาก VPS: `thuammai relay keys --show` (แสดง key ทุกครั้งที่เรียก) สคริปต์รันซ้ำได้ ไม่ทับ key/env เดิม (อาร์กิวเมนต์ `RELAY_URL` มีผลเฉพาะตอนติดตั้งครั้งแรก; ภายหลังแก้ที่ `/etc/thuammai-relay/env`)

สิ่งที่สคริปต์ทำ:
- สร้าง user ระบบ `relay`, วางโปรแกรมที่ `/opt/thuammai-relay/relay.mjs`
- `/etc/thuammai-relay/key` (0600, เจ้าของ `relay`) และ `/etc/thuammai-relay/env` (`RELAY_URL`, `RELAY_KEY_FILE`, `KUMA_PUSH_URL` ไม่บังคับ)
- systemd service (`Type=oneshot`, `NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp` ฯลฯ) + timer `OnCalendar=*:03/5` (นาทีที่ 3, 8, 13, ... ของทุกชั่วโมง)

## ตรวจสอบ

```bash
systemctl list-timers thuammai-relay.timer
systemctl start thuammai-relay.service        # ลองรันทันที
journalctl -u thuammai-relay -n 20 --no-pager
```

log แสดงเฉพาะจำนวน เช่น `fetched road=237 canal=281` / `posted 18000 bytes gzip: HTTP 204` (ไม่มีเนื้อหาข้อมูลหรือ key)

หมุน key: บน VPS ลบไฟล์ secret `relay_hmac_key` และ `relay_read_token` (ในโฟลเดอร์ secrets ของ thuammai) → `thuammai relay keys` (สร้างใหม่) → `thuammai relay keys --show` → ใส่ `relay_hmac_key` ใหม่ที่เครื่องไทย (`/etc/thuammai-relay/key`, รีสตาร์ต timer/service) และอัปเดต GitHub secret `RELAY_READ_TOKEN` ด้วยค่าใหม่

ทดสอบโดยไม่ส่ง (ดึง + สรุปจำนวนเท่านั้น): `node relay/dist/relay.mjs --once`

## พฤติกรรม

- ดึงทีละคำขอ ห่างกัน ≥ 2 วินาที, timeout 30 วินาที/คำขอ, ตรวจว่าเป็น JSON จริง, `-99` = ไม่มีค่า, ตัดสถานีคลองที่ out of order/ค้าง > 2 ชม.
- ได้ถนน ≥ 50 หรือคลอง ≥ 50 รายการ = ส่งข้อมูลตามปกติ; ถ้าไม่ถึงทั้งสองอย่าง (หรือดึงล้ม) = ส่ง `{v:1, fetchedAt, road:[], canal:[], error:"สาเหตุสั้นๆ"}` (เซ็นเหมือนเดิม, `error` ≤ 200 ตัวอักษร ไม่มี URL) เพื่อให้ฝั่ง server เห็นใน health แล้วจบด้วย exit ≠ 0; ส่งไม่สำเร็จก็ exit ≠ 0 (รอรอบถัดไป ไม่ retry ถี่)
- ถ้าตั้ง `KUMA_PUSH_URL` จะ ping หลังส่งสำเร็จ

## ถอนการติดตั้ง

```bash
sudo systemctl disable --now thuammai-relay.timer
sudo rm -f /etc/systemd/system/thuammai-relay.{service,timer}
sudo rm -rf /opt/thuammai-relay /etc/thuammai-relay && sudo userdel relay
```
