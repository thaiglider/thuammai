import { FORECAST } from '../../core/thresholds';
import { parseLocal, toIso07 } from '../../core/time';
import type { ForecastPoint } from '../../core/types';
import type { DistrictGeo, ProvinceGeo } from '../static-data';

type Pt = { id: string; lat: number; lon: number };

export function forecastPoints(provinces: ProvinceGeo[], districts: DistrictGeo[]): Pt[] {
  return [
    ...provinces.map((p) => ({ id: `p${p.code}`, lat: p.lat, lon: p.lon })),
    ...districts.map((d) => ({ id: `d${d.code}`, lat: d.lat, lon: d.lon })),
  ];
}

export function openMeteoUrl(points: Pt[]): string {
  const q = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(3)).join(','),
    longitude: points.map((p) => p.lon.toFixed(3)).join(','),
    hourly: 'precipitation',
    forecast_hours: String(FORECAST.hours + 1),
    timezone: 'Asia/Bangkok',
  });
  return `https://api.open-meteo.com/v1/forecast?${q.toString()}`;
}

export function parseOpenMeteo(raw: any, points: Pt[], now: Date): ForecastPoint[] {
  if (Array.isArray(raw) && raw.length !== points.length) {
    throw new Error(`open-meteo returned ${raw.length} locations for ${points.length} points`);
  }
  const list: any[] = Array.isArray(raw) ? raw : [raw];
  const hourStartMs = Math.floor(now.getTime() / 3600e3) * 3600e3;
  const out: ForecastPoint[] = [];
  list.forEach((loc, i) => {
    const pt = points[i];
    const times: string[] = loc?.hourly?.time ?? [];
    const mm: (number | null)[] = loc?.hourly?.precipitation ?? [];
    if (!pt || !times.length) return;
    const rows = times
      .map((t, k) => ({ d: parseLocal(t), v: mm[k] ?? 0 }))
      .filter((r): r is { d: Date; v: number } => !!r.d && r.d.getTime() >= hourStartMs)
      .slice(0, FORECAST.hours);
    if (!rows.length) return;
    out.push({ id: pt.id, lat: pt.lat, lon: pt.lon, start: toIso07(rows[0]!.d), mm: rows.map((r) => Math.round((r.v ?? 0) * 10) / 10) });
  });
  return out;
}
