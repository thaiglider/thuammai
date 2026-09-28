import { distanceText } from '../../core/advice';
import { distKm } from '../../core/geo';
import { LEVEL_TH } from '../../core/labels';
import type { Assessment } from '../../core/risk';
import { DISPLAY } from '../../core/thresholds';
import type { Observation } from '../../core/types';
import { fmtTime } from '../../core/time';
import { obsValueText } from './format';

// Matches the water station predicate from src/core/risk.ts (lines 185–187)
const WATER = new Set<Observation['kind']>(['river', 'canal', 'road']);

/** Nearest water (level > 0) river/canal/road station within maxKm,
 *  including held stations. Matches the predicate used by risk.ts for coverage.nearestWaterKm. */
export function nearestFreshWater(lat: number, lon: number, obs: readonly Observation[], maxKm: number = DISPLAY.nearestWaterMaxKm): { o: Observation; km: number } | null {
  let best: { o: Observation; km: number } | null = null;
  for (const o of obs) {
    // Matches risk.ts: o.kind in WATER && o.level > 0 (held stations are included)
    if (!WATER.has(o.kind) || o.level === 0) continue;
    const km = distKm(lat, lon, o.lat, o.lon);
    if (km <= maxKm && (!best || km < best.km)) best = { o, km };
  }
  return best;
}

/** Context line for a card whose place has no fresh water station in the direct-evidence band.
 *  Information only: it never changes the assessed level. */
export function coverageLine(a: Assessment, lat: number, lon: number, obs: readonly Observation[]): string | null {
  if (a.coverage.water === 'near') return null;
  const n = nearestFreshWater(lat, lon, obs);
  if (!n) return null;
  const value = obsValueText(n.o);
  const heldTime = n.o.held ? ` (ค่าล่าสุดเมื่อ ${fmtTime(n.o.held.lastFreshAt)})` : '';
  return `สถานีวัดน้ำใกล้สุด: ${n.o.name} ห่าง ${distanceText(n.km)}${heldTime} — ${LEVEL_TH[n.o.level]}${value ? ` (${value})` : ''} · ข้อมูลประกอบเท่านั้น ไม่ใช่สภาพที่จุดนี้`;
}
