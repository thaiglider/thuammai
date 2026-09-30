import { distanceText } from '../../core/advice';
import { distKm } from '../../core/geo';
import { isFreshObs } from '../../core/fresh';
import { KIND_TH, LEVEL_TH, NO_NEAR_FOOT_TH, NO_NEAR_NOTE_TH, NO_NEAR_TH, STATION_LEVEL_TH } from '../../core/labels';
import type { Assessment } from '../../core/risk';
import { DISPLAY } from '../../core/thresholds';
import type { Level, Observation } from '../../core/types';
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
export function coverageLine(a: Assessment, lat: number, lon: number, obs: readonly Observation[], shownLevel: Level = a.level): string | null {
  // A level-0 place gets the "ไม่มีสถานีใกล้" list (noNearLines) instead, which counts fresh stations only.
  if (shownLevel === 0 || a.coverage.water === 'near') return null;
  const n = nearestFreshWater(lat, lon, obs);
  if (!n) return null;
  const value = obsValueText(n.o);
  const heldTime = n.o.held ? ` (ค่าล่าสุดเมื่อ ${fmtTime(n.o.held.lastFreshAt)})` : '';
  return `สถานีวัดน้ำใกล้สุด: ${n.o.name} ห่าง ${distanceText(n.km)}${heldTime} — ${LEVEL_TH[n.o.level]}${value ? ` (${value})` : ''} · ข้อมูลประกอบเท่านั้น ไม่ใช่สภาพที่จุดนี้`;
}

const KIND_ORDER = ['river', 'canal', 'road'] as const;
export interface NearStation { o: Observation; km: number }

/** The nearest fresh (`isFreshObs`: not held/stale, level > 0, recent) station of each water kind within
 *  maxKm, in river → canal → road order. Information only: it never changes the assessed level or radius. */
export function nearestByKind(lat: number, lon: number, obs: readonly Observation[], now: Date, maxKm: number = DISPLAY.nearestWaterMaxKm): NearStation[] {
  const best = new Map<Observation['kind'], NearStation>();
  for (const o of obs) {
    if (!WATER.has(o.kind) || !isFreshObs(o, now)) continue;
    const km = distKm(lat, lon, o.lat, o.lon);
    const cur = best.get(o.kind);
    if (km <= maxKm && (!cur || km < cur.km)) best.set(o.kind, { o, km });
  }
  return KIND_ORDER.flatMap((k) => best.get(k) ?? []);
}

export interface NoNear { label: string; note: string; items: string[]; foot: string }

/** The "ไม่มีสถานีใกล้" card text (spec 2026-10-01 §5): only for a shown level 0 that is not `incomplete`
 *  and has at least one fresh water station nearby; otherwise null (the plain "ไม่มีข้อมูล" card). */
export function noNearLines(shownLevel: Level, a: Assessment, near: readonly NearStation[]): NoNear | null {
  if (shownLevel !== 0 || a.incomplete || near.length === 0) return null;
  const items = near.map(({ o, km }) => `${KIND_TH[o.kind]}: ${o.name} ห่าง ${distanceText(km)} — ที่สถานี: ${STATION_LEVEL_TH[o.level as 1 | 2 | 3 | 4]}`);
  return { label: NO_NEAR_TH, note: NO_NEAR_NOTE_TH, items, foot: NO_NEAR_FOOT_TH };
}
