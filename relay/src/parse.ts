import { toIso07 } from '../../src/core/time';
import type { RelayCanal, RelayRoad } from '../../src/core/relay-types';

const ROAD_MAX_CM = 200;
const ROAD_MAX_AGE_MIN = 60;
const FUTURE_MIN = 5;
const CANAL_MAX_AGE_MIN = 120;
const BAD_ROAD_STATUS = new Set(['malfunction', 'temporary_malfunction']);

const num = (x: unknown): number | null => {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return Number.isFinite(n) ? n : null;
};
/** -99 is BMA's "no reading". */
const val = (x: unknown): number | null => {
  const n = num(x);
  return n === null || n === -99 ? null : n;
};
/** warning/critical/bank: 0 also means "not set". */
const lim = (x: unknown): number | null => {
  const n = val(x);
  return n === null || n === 0 ? null : n;
};
const cleanName = (s: unknown, fallback: string) => String(s ?? fallback).replace(/\s*\*+\s*$/, '').trim();

/** Directus sensor_flood rows (expanded with sensor_profile_id.*) -> latest valid reading per sensor. */
export function parseRoad(rows: unknown, now: Date): RelayRoad[] {
  if (!Array.isArray(rows)) return [];
  const best = new Map<string, { ms: number; r: RelayRoad }>();
  for (const row of rows as Record<string, any>[]) {
    const p = row?.sensor_profile_id;
    if (!p || typeof p !== 'object') continue;
    const code = typeof row.sensor_name === 'string' ? row.sensor_name : typeof p.code === 'string' ? p.code : null;
    if (!code) continue;
    if (BAD_ROAD_STATUS.has(String(p.device_status))) continue;
    const cm = num(row.value);
    if (cm === null || cm < 0 || cm > ROAD_MAX_CM) continue;
    const ms = num(row.timestamp);
    if (ms === null) continue;
    const ageMin = (now.getTime() - ms) / 60_000;
    if (ageMin < -FUTURE_MIN || ageMin > ROAD_MAX_AGE_MIN) continue;
    const lat = num(p.lat);
    const lon = num(p.long);
    if (lat === null || lon === null) continue;
    const prev = best.get(code);
    if (prev && prev.ms >= ms) continue;
    const r: RelayRoad = { code, name: cleanName(p.name, code), lat, lon, t: toIso07(new Date(ms)), cm };
    if (typeof p.district === 'string' && p.district) r.district = p.district;
    best.set(code, { ms, r });
  }
  return [...best.values()].map((b) => b.r);
}

/** PageMap GoogleMap array -> fresh, in-order canal stations. */
export function parseCanal(rows: unknown, now: Date): RelayCanal[] {
  if (!Array.isArray(rows)) return [];
  const out: RelayCanal[] = [];
  const seen = new Set<string>();
  for (const s of rows as Record<string, any>[]) {
    const code = typeof s?.water_code === 'string' ? s.water_code : null;
    if (!code || seen.has(code)) continue;
    const level = val(s.wl_in);
    if (level === null) continue;
    if (/out of order/i.test(String(s.txtStatus_en ?? ''))) continue;
    const age = num(s.datediffnow);
    if (age === null || age < 0 || age > CANAL_MAX_AGE_MIN) continue;
    const m = /\/Date\((-?\d+)\)\//.exec(String(s.site_timestamp ?? ''));
    if (!m) continue;
    const ms = Number(m[1]);
    if ((now.getTime() - ms) / 60_000 < -FUTURE_MIN) continue;
    const lat = num(s.latitude);
    const lon = num(s.longitude);
    if (lat === null || lon === null) continue;
    seen.add(code);
    out.push({
      code,
      name: cleanName(s.water_name, code),
      lat,
      lon,
      t: toIso07(new Date(ms)),
      level,
      bankL: lim(s.left_bank),
      bankR: lim(s.right_bank),
      warn: lim(s.warning),
      crit: lim(s.critical),
    });
  }
  return out;
}
