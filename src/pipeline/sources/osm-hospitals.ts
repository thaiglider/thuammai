import { cleanText } from '../../core/text';
import { inThailand } from '../../core/geo';
import type { Hospital } from '../../core/types';
import { provinceAt, type StaticData } from '../static-data';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OVERPASS_QUERY =
  '[out:json][timeout:60];area["ISO3166-1"="TH"][admin_level=2]->.th;nwr["amenity"="hospital"](area.th);out center tags;';
/** POST body (form-encoded `data=`). */
export const overpassBody = (): string => `data=${encodeURIComponent(OVERPASS_QUERY)}`;

const NO_NAME = 'โรงพยาบาล (ไม่มีชื่อ)';
const PREFIX = { node: 'n', way: 'w', relation: 'r' } as const;

/** Overpass `elements` → hospitals inside Thailand with a province. Pure; skips anything malformed. */
export function parseOverpassHospitals(raw: unknown, sd: StaticData): Hospital[] {
  // Overpass answers 200 with a partial list and a remark when a query runs out of time or memory.
  const remark = (raw as { remark?: unknown })?.remark;
  if (typeof remark === 'string' && /runtime error/i.test(remark)) throw new Error(`overpass: ${remark.slice(0, 120)}`);
  const els = (raw as { elements?: unknown })?.elements;
  if (!Array.isArray(els)) throw new Error('overpass: no elements array');
  const out: Hospital[] = [];
  const seen = new Set<string>();
  for (const e of els as any[]) {
    const p = PREFIX[e?.type as keyof typeof PREFIX];
    if (!p || !Number.isInteger(e.id)) continue;
    const lat = Number(e.type === 'node' ? e.lat : e.center?.lat);
    const lon = Number(e.type === 'node' ? e.lon : e.center?.lon);
    if (!inThailand(lat, lon) || !provinceAt(lat, lon, sd)) continue;
    const tags = e.tags ?? {};
    const raw = typeof tags['name:th'] === 'string' && tags['name:th'] ? tags['name:th'] : typeof tags.name === 'string' ? tags.name : '';
    const osmId = `${p}${e.id}`;
    if (seen.has(osmId)) continue;
    seen.add(osmId);
    out.push({ osmId, name: cleanText(raw, 80) || NO_NAME, lat: Math.round(lat * 1e5) / 1e5, lon: Math.round(lon * 1e5) / 1e5 });
  }
  return out;
}
