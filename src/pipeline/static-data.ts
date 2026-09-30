import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProvinceGeo } from '../core/types';

export type { ProvinceGeo };
export interface DistrictGeo { code: string; th: string; en: string; lat: number; lon: number }
export interface ProvinceShape { code: string; rings: [number, number][][] }
export interface ChainStation { code: string; th: string; qThresholds?: number[] }
export interface StaticData {
  provinces: ProvinceGeo[];
  districts: DistrictGeo[];
  shapes: ProvinceShape[];
  tidal: Set<string>;
  chain: ChainStation[];
}

export function loadStaticData(root = 'static'): StaticData {
  const read = <T>(name: string): T => JSON.parse(readFileSync(join(root, name), 'utf8')).data as T;
  return {
    provinces: read('provinces.json'),
    districts: read('bkk-districts.json'),
    shapes: read('province-shapes.json'),
    tidal: new Set(read<string[]>('tidal-stations.json')),
    chain: read('chao-phraya-chain.json'),
  };
}

function inRing(x: number, y: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

type Boxed = { code: string; rings: { ring: [number, number][]; w: number; s: number; e: number; n: number }[] };
const boxes = new WeakMap<StaticData, Boxed[]>();

function boxed(sd: StaticData): Boxed[] {
  let b = boxes.get(sd);
  if (!b) {
    b = sd.shapes.map((sh) => ({
      code: sh.code,
      rings: sh.rings.map((ring) => {
        let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
        for (const [x, y] of ring) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
        return { ring, w, s, e, n };
      }),
    }));
    boxes.set(sd, b);
  }
  return b;
}

/** Province code containing the point (simplified polygons), or null (e.g. at sea).
 *  A per-ring bounding box (cached per StaticData) skips almost every polygon test. */
export function provinceAt(lat: number, lon: number, sd: StaticData): string | null {
  for (const sh of boxed(sd)) {
    for (const r of sh.rings) if (lon >= r.w && lon <= r.e && lat >= r.s && lat <= r.n && inRing(lon, lat, r.ring)) return sh.code;
  }
  return null;
}
