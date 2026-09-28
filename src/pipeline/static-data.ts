import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProvinceGeo { code: string; th: string; en: string; lat: number; lon: number; bbox: [number, number, number, number] }
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

/** Province code containing the point (simplified polygons), or null (e.g. at sea). */
export function provinceAt(lat: number, lon: number, sd: StaticData): string | null {
  for (const s of sd.shapes) if (s.rings.some((r) => inRing(lon, lat, r))) return s.code;
  return null;
}
