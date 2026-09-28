import { TH_BBOX } from './thresholds';

export interface LatLon { lat: number; lon: number }
export interface Stationish extends LatLon { id: string; kind: string }

const R = 6371.0088;
const RAD = Math.PI / 180;

export function distKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = (bLat - aLat) * RAD;
  const dLon = (bLon - aLon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * RAD) * Math.cos(bLat * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function nearest<T extends LatLon>(items: readonly T[], lat: number, lon: number, maxKm: number, n = Infinity): { item: T; km: number }[] {
  const out: { item: T; km: number }[] = [];
  for (const item of items) {
    const km = distKm(lat, lon, item.lat, item.lon);
    if (km <= maxKm) out.push({ item, km });
  }
  out.sort((a, b) => a.km - b.km);
  return Number.isFinite(n) ? out.slice(0, n) : out;
}

export function inThailand(lat: number, lon: number): boolean {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lon >= TH_BBOX[0] && lat >= TH_BBOX[1] && lon <= TH_BBOX[2] && lat <= TH_BBOX[3];
}

/** Two items are independent when ids differ AND (kinds differ OR they are ≥ minKm apart). */
export function hasIndependentPair(items: readonly Stationish[], minKm: number): boolean {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]!;
      const b = items[j]!;
      if (a.id !== b.id && (a.kind !== b.kind || distKm(a.lat, a.lon, b.lat, b.lon) >= minKm)) return true;
    }
  }
  return false;
}
