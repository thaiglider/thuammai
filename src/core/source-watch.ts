import { RELAY_PROBLEM_MIN, STALE_SOURCE_H, STALE_SOURCE_RECOVER_H } from './thresholds';
import type { SourceHealth } from './types';

/* Stale-source watch (owner-approved 2026-09-30, lessons-learned §K): a feed can stop silently —
 * the API still answers 200 and the pipeline stays ok — so the age of the newest reading is
 * checked against the current time. Shared by the alerts job (owner alert) and the web (banner). */

export type WaterSourceId = 'river' | 'canal' | 'road' | 'rain';
export const WATER_SOURCE_IDS: readonly WaterSourceId[] = ['river', 'canal', 'road', 'rain'];
/** Short Thai names (the sources page adds the provider after " — "). */
export const WATER_SOURCE_TH: Record<WaterSourceId, string> = {
  river: 'ระดับน้ำแม่น้ำ', rain: 'ฝน', road: 'น้ำบนถนน กทม.', canal: 'ระดับน้ำคลอง กทม.',
};
/** One word each, for "the assessment uses …". */
const KIND_WORD: Record<WaterSourceId, string> = { river: 'แม่น้ำ', canal: 'คลอง', road: 'ถนน', rain: 'ฝน' };

/** lagH: whole hours since the newest reading; Infinity when the time is unknown. */
export interface StaleSource { id: WaterSourceId; lagH: number }

/** Water sources whose newest reading is ≥ STALE_SOURCE_H hours before `now`. `newest` is used,
 *  not `lagMin` (meta itself may be old). A null or unreadable `newest` with items → stale (age
 *  unknown); a missing source or one with no items → ignored (other health checks cover it). */
export function staleWaterSources(sources: readonly SourceHealth[] | null | undefined, now: Date): StaleSource[] {
  if (!Array.isArray(sources)) return [];
  const out: StaleSource[] = [];
  for (const id of WATER_SOURCE_IDS) {
    const s = sources.find((x) => x !== null && typeof x === 'object' && x.id === id);
    if (!s) continue;
    const t = typeof s.newest === 'string' ? Date.parse(s.newest) : NaN;
    if (Number.isNaN(t)) {
      if (typeof s.count === 'number' && s.count > 0) out.push({ id, lagH: Infinity });
      continue;
    }
    const ageMs = now.getTime() - t;
    if (ageMs >= STALE_SOURCE_H * 3600e3) out.push({ id, lagH: Math.floor(ageMs / 3600e3) });
  }
  return out;
}

/** The BMA relay path (relay → token → pipeline) failed this snapshot: `bma` present and not ok.
 *  Absent (not configured) is no problem. */
export function relayProblem(sources: readonly SourceHealth[] | null | undefined): boolean {
  if (!Array.isArray(sources)) return false;
  const b = sources.find((x) => x !== null && typeof x === 'object' && x.id === 'bma');
  return b !== undefined && b.ok === false;
}

/** "N ชม." below two days, else "N วัน"; unknown → "ไม่ทราบเวลา". */
export function staleAgeTh(lagH: number): string {
  if (!Number.isFinite(lagH)) return 'ไม่ทราบเวลา';
  return lagH < 48 ? `${lagH} ชม.` : `${Math.floor(lagH / 24)} วัน`;
}

/** Present in the snapshot with items and a readable `newest` below `maxH` hours old. */
function freshWithin(sources: readonly SourceHealth[], id: WaterSourceId, now: Date, maxH: number): boolean {
  const s = sources.find((x) => x !== null && typeof x === 'object' && x.id === id);
  if (!s || typeof s.count !== 'number' || s.count <= 0) return false;
  const t = typeof s.newest === 'string' ? Date.parse(s.newest) : NaN;
  return !Number.isNaN(t) && now.getTime() - t < maxH * 3600e3;
}

/** Whether a watched problem (`stale:<id>` or `relay`) has positively cleared in this snapshot.
 *  Leaving the stale set is not enough — a source that vanished, lost its items or its time
 *  got worse, not better. Water: present, count > 0 and newest < STALE_SOURCE_RECOVER_H old
 *  (hysteresis). Relay: `bma` present and ok. Anything else (unknown key, no sources) → false. */
export function watchKeyRecovered(key: string, sources: readonly SourceHealth[] | null | undefined, now: Date): boolean {
  if (!Array.isArray(sources)) return false;
  if (key === 'relay') return sources.some((x) => x !== null && typeof x === 'object' && x.id === 'bma' && x.ok === true);
  const id = key.startsWith('stale:') ? key.slice('stale:'.length) : '';
  if (!(WATER_SOURCE_IDS as readonly string[]).includes(id)) return false;
  return freshWithin(sources, id as WaterSourceId, now, STALE_SOURCE_RECOVER_H);
}

/** What the assessment still rests on while these sources are stale (web banner): only water
 *  sources present in the snapshot with items and not stale. */
export function staleUsesTh(stale: readonly StaleSource[], sources: readonly SourceHealth[] | null | undefined, now: Date): string {
  const bad = new Set(stale.map((s) => s.id));
  const all = Array.isArray(sources) ? sources : [];
  const left = WATER_SOURCE_IDS.filter((id) => !bad.has(id) && freshWithin(all, id, now, STALE_SOURCE_H)).map((id) => KIND_WORD[id]);
  const scope = [...bad].every((id) => id === 'road' || id === 'canal') ? 'การประเมินใน กทม. ใช้' : 'การประเมินใช้';
  return left.length ? `${scope}${left.join(' ')} และรายงานเท่านั้น` : `${scope}รายงานเท่านั้น`;
}

/* Owner messages (Telegram admin chat): short, Thai, no URL. */
const PROVIDER: Record<WaterSourceId, string> = { river: 'สสน.', rain: 'สสน.', road: 'สสน./กทม.', canal: 'สสน./กทม.' };
const OWNER_NAME: Record<WaterSourceId, string> = { river: 'แม่น้ำ', rain: 'ฝน', road: 'ถนน', canal: 'คลอง' };
export function staleOwnerText(s: StaleSource): string {
  const age = Number.isFinite(s.lagH) ? `ค้าง ${s.lagH} ชม.` : 'ค้าง (ไม่ทราบเวลา)';
  return `⚠️ ข้อมูล${OWNER_NAME[s.id]} (${s.id}) ${age} — แหล่ง: ${PROVIDER[s.id]} · ตรวจ relay/ThaiWater`;
}
export const staleRecoveredText = (id: WaterSourceId): string => `✅ ข้อมูล${OWNER_NAME[id]} (${id}) กลับมาปกติแล้ว`;
export const RELAY_PROBLEM_TH = `⚠️ relay กทม. (bma) ใช้ไม่ได้ตั้งแต่ ${RELAY_PROBLEM_MIN} นาทีขึ้นไป — ตรวจเครื่อง relay และโทเค็น`;
export const RELAY_RECOVERED_TH = '✅ relay กทม. (bma) กลับมาปกติแล้ว';
