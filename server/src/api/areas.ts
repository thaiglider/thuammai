import provincesFile from '../../../static/provinces.json';
import { distKm } from '../../../src/core/geo';
import type { Level, ProvinceGeo } from '../../../src/core/types';

const PROVINCES = (provincesFile as unknown as { data: ProvinceGeo[] }).data;

/** The province of a point: inside its bounding box, the nearest centre when boxes overlap. */
export function provinceFor(lat: number, lon: number, list: readonly ProvinceGeo[] = PROVINCES): ProvinceGeo {
  const inside = list.filter((p) => lon >= p.bbox[0] && lat >= p.bbox[1] && lon <= p.bbox[2] && lat <= p.bbox[3]);
  const pool = inside.length ? inside : list;
  return pool.reduce((best, p) => (distKm(lat, lon, p.lat, p.lon) < distKm(lat, lon, best.lat, best.lon) ? p : best));
}

export interface AreaInfo { generatedAt: string; level: Level }

// A malicious or misconfigured Pages deploy must not make the api buffer an unbounded response.
const AREAS_MAX_BYTES = 256 * 1024;
const AREAS_MEMO_TTL_MS = 5 * 60_000;
/** In-process memo of data/areas.json (one api process, spec §6.1: no Workers cache any more). */
let areasMemo: { text: string; expires: number } | null = null;
export function resetAreasCache(): void { areasMemo = null; }

/** A province's overview level from the published data/areas.json, memoised 5 minutes, 3 s
 *  timeout. null on any failure — the caller says less. */
export async function provinceArea(siteUrl: string, code: string, fetchImpl: typeof fetch, timeoutMs = 3000): Promise<AreaInfo | null> {
  try {
    let text: string;
    if (areasMemo && areasMemo.expires > Date.now()) {
      text = areasMemo.text;
    } else {
      const res = await fetchImpl(new URL('data/areas.json', siteUrl).href, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const len = res.headers.get('content-length');
      if (len !== null && Number(len) > AREAS_MAX_BYTES) return null;
      text = await res.text();
      if (text.length > AREAS_MAX_BYTES) return null;
      areasMemo = { text, expires: Date.now() + AREAS_MEMO_TTL_MS };
    }
    const j = JSON.parse(text) as { generatedAt?: unknown; areas?: unknown };
    if (typeof j.generatedAt !== 'string' || !Array.isArray(j.areas)) return null;
    const row = (j.areas as { code?: unknown; kind?: unknown; level?: unknown }[]).find((a) => a && a.kind === 'province' && a.code === code);
    if (!row || ![0, 1, 2, 3, 4].includes(row.level as number)) return null;
    return { generatedAt: j.generatedAt, level: row.level as Level };
  } catch {
    return null;
  }
}
