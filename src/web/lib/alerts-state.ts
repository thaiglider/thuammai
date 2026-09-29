import { ALERTS_ORIGIN_RE } from '../../core/alert-config';
import { alertKey } from '../../core/alert-key';
import type { Env } from './env';
import type { Place } from './places';
import { getJson, setJson, type KV } from './storage';

/* Static (first-render) part of the alerts feature: config, local state and the display rule.
 * Everything that talks to the Worker or the push service is in the lazy alerts-client chunk. */

export interface AlertsCfg { origin: string; vapid: string; tgBot: string }
export function alertsCfg(): AlertsCfg {
  return {
    origin: import.meta.env.VITE_ALERTS_ORIGIN ?? '',
    vapid: import.meta.env.VITE_VAPID_PUBLIC_KEY ?? '',
    tgBot: import.meta.env.VITE_TELEGRAM_BOT ?? '',
  };
}
/** A 65-byte P-256 public key is 87 base64url characters. */
export const pushConfigured = (c: AlertsCfg): boolean => ALERTS_ORIGIN_RE.test(c.origin) && /^[A-Za-z0-9_-]{87}$/.test(c.vapid);
/** A Telegram bot username (5–32 of A–Z a–z 0–9 _), without @. */
export const tgBotOk = (c: AlertsCfg): boolean => /^[A-Za-z0-9_]{5,32}$/.test(c.tgBot);
/** The bot link is offered only while alerts are on in this build (final review I1): a valid bot
 *  name AND a valid alerts config. The build passes VITE_TELEGRAM_BOT only when ALERTS_ENABLED=1;
 *  this is the client-side half, so a bad origin (D15) never sends people to a silent bot either. */
export const telegramOffered = (c: AlertsCfg): boolean => pushConfigured(c) && tgBotOk(c);
export const telegramLink = (c: AlertsCfg): string => `https://t.me/${c.tgBot}`;
export const TELEGRAM_LINK_TH = 'รับแจ้งเตือนทาง Telegram แทน';
/** "Full" is shared by both channels (the Worker's caps), so Telegram cannot follow either — but
 *  it can still show a point's level (final review M1). */
export const FULL_WITH_TG_TH = 'ระบบแจ้งเตือนรับผู้ใช้เต็มชั่วคราว — ดูระดับทาง Telegram หรือเปิดเว็บดูเป็นระยะ';

/** `holdUntil`: no sync before this time (per-day new-places cap, m4). `origin`: the alerts server
 *  this state was synced with — a different one (e.g. after the move to the VPS) re-syncs (R14). */
export interface AlertsKv { on: true; endpoint: string; syncedAt: string; placesHash: string; pending?: boolean; holdUntil?: string; origin?: string }
const KEY = 'alerts';
export function loadAlerts(kv: KV): AlertsKv | null {
  const s = getJson<Partial<AlertsKv> | null>(kv, KEY, null);
  return s && s.on === true && typeof s.endpoint === 'string' && typeof s.syncedAt === 'string' && typeof s.placesHash === 'string' ? (s as AlertsKv) : null;
}
export const saveAlerts = (kv: KV, s: AlertsKv): void => setJson(kv, KEY, s);
export const clearAlerts = (kv: KV): void => kv.remove(KEY);
export const alertsOn = (kv: KV): boolean => loadAlerts(kv) !== null;

/** The server's view of a place list: the sorted set of ~100 m keys (renames do not change it). */
export function placesHash(places: readonly Pick<Place, 'lat' | 'lon'>[]): string {
  return [...new Set(places.map((p) => alertKey(p.lat, p.lon)))].sort().join('|');
}

export type AlertsMode = 'push' | 'ios-guide' | 'telegram' | null;

/** I3: this phone says alerts are on, but this build cannot deliver them (alerts switched off or
 *  misconfigured on the server side) or the browser has no service worker. Never show "on" then. */
export function alertsPausedByBuild(cfg: AlertsCfg, env: Pick<Env, 'canServiceWorker'>, kv: KV): boolean {
  return alertsOn(kv) && (!pushConfigured(cfg) || !env.canServiceWorker);
}
export const ALERTS_PAUSED_TH = 'ระบบแจ้งเตือนหยุดชั่วคราว — ตอนนี้จะไม่ได้รับแจ้งเตือน เปิดเว็บดูเอง';
/** The server says it is stalled, or cannot be reached twice (spec §8.1, R13). */
export const ALERTS_DOWN_TH = 'ระบบแจ้งเตือนขัดข้อง — ตอนนี้อาจไม่ได้รับแจ้งเตือน เปิดเว็บดูเป็นระยะ';
export interface PushGlobals { hasPushManager: boolean; hasNotification: boolean }
export function browserPushGlobals(): PushGlobals {
  return { hasPushManager: typeof window !== 'undefined' && 'PushManager' in window, hasNotification: typeof Notification !== 'undefined' };
}

/** Which alerts UI this browser gets (spec §6.1); null hides the whole section. */
export function alertsMode(cfg: AlertsCfg, env: Env, kv: KV, g: PushGlobals, placeCount: number): AlertsMode {
  if (placeCount < 1 || env.isLine) return null;
  if (pushConfigured(cfg) && kv.persistent && env.canServiceWorker) {
    if (env.isIOS && !env.standalone) return 'ios-guide';
    if (g.hasPushManager && g.hasNotification) return 'push';
  }
  // A link needs no storage, Service Worker or Push API (ruling 13).
  return telegramOffered(cfg) ? 'telegram' : null;
}

export const GPS_CONFIRM_TH = 'ใช้ตำแหน่งปัจจุบันเพื่อหาความเสี่ยงของจุดนี้เท่านั้น ตำแหน่งไม่ถูกส่งออกจากเครื่อง — ดำเนินการต่อ?';
export const GPS_CONFIRM_ALERTS_TH = 'ใช้ตำแหน่งปัจจุบันเพื่อหาความเสี่ยงของจุดนี้เท่านั้น ตำแหน่งไม่ถูกส่งออกจากเครื่อง ยกเว้นพิกัดโดยประมาณ (~100 ม.) ที่ส่งให้ระบบแจ้งเตือนถ้าคุณบันทึกจุดนี้ — ดำเนินการต่อ?';
export const ALERTS_PRIVACY_TH = 'ชื่อจุด จุดที่บันทึก และการตั้งค่าอยู่ในเครื่องของคุณเท่านั้น · ถ้าเปิดแจ้งเตือน ระบบแจ้งเตือน (เซิร์ฟเวอร์ของโครงการ ตั้งอยู่ต่างประเทศ) เก็บพิกัดโดยประมาณ (~100 ม.) ของจุดที่ติดตามและที่อยู่สำหรับส่งแจ้งเตือนของเบราว์เซอร์ ไม่เก็บชื่อจุดและ IP — ลบเมื่อเลิกรับแจ้งเตือน หรือเมื่อไม่ได้เปิดเว็บนาน 180 วัน (สำเนาสำรองลบภายใน 14 วัน)';
