import provincesFile from '../../static/provinces.json';
import { distKm } from '../../src/core/geo';
import type { Level, ProvinceGeo } from '../../src/core/types';
import type { CacheLike } from './env';

const PROVINCES = (provincesFile as unknown as { data: ProvinceGeo[] }).data;

/** The province of a point: inside its bounding box, the nearest centre when boxes overlap
 *  (same rule as the web's "ดูความเสี่ยงที่บ้านของฉัน" naming). */
export function provinceFor(lat: number, lon: number, list: readonly ProvinceGeo[] = PROVINCES): ProvinceGeo {
  const inside = list.filter((p) => lon >= p.bbox[0] && lat >= p.bbox[1] && lon <= p.bbox[2] && lat <= p.bbox[3]);
  const pool = inside.length ? inside : list;
  return pool.reduce((best, p) => (distKm(lat, lon, p.lat, p.lon) < distKm(lat, lon, best.lat, best.lon) ? p : best));
}

export interface AreaInfo { generatedAt: string; level: Level }

// A malicious or misconfigured Pages deploy must not be able to make the Worker buffer an
// unbounded response into memory; areas.json is normally a few tens of KB (spec §9).
const AREAS_MAX_BYTES = 256 * 1024;
const AREAS_MEMO_TTL_MS = 5 * 60_000;

/** `caches.default` (the Workers Cache API) is scoped to a Cloudflare *zone* and does not work on
 *  the free `*.workers.dev` subdomain this Worker runs on before an owner attaches a custom domain
 *  (`cache.match`/`cache.put` silently become no-ops there) — so this same-isolate, in-process
 *  fallback keeps the "don't refetch areas.json on every update" benefit even then. It is
 *  deliberately independent of the `cache` parameter (never assume the two agree), and reset with
 *  `resetAreasCache` in tests, since a module-level value would otherwise leak between unrelated
 *  test cases that share this module instance. */
let areasMemo: { text: string; expires: number } | null = null;
export function resetAreasCache(): void { areasMemo = null; }

/** A province's overview level from the published data/areas.json (spec §7.2 step 1), through
 *  the edge cache for 5 minutes, 3 s timeout. null on any failure — the caller says less. */
export async function provinceArea(siteUrl: string, code: string, fetchImpl: typeof fetch, cache: CacheLike | null, timeoutMs = 3000): Promise<AreaInfo | null> {
  const req = new Request(new URL('data/areas.json', siteUrl).href);
  try {
    let text: string;
    if (areasMemo && areasMemo.expires > Date.now()) {
      text = areasMemo.text;
    } else {
      let res = cache ? await cache.match(req) : undefined;
      if (!res) {
        const fresh = await fetchImpl(req.url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!fresh.ok) return null;
        const len = fresh.headers.get('content-length');
        if (len !== null && Number(len) > AREAS_MAX_BYTES) return null;
        const body = await fresh.text();
        if (body.length > AREAS_MAX_BYTES) return null;
        res = new Response(body, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=300' } });
        if (cache) await cache.put(req, res.clone());
      }
      text = await res.text();
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
